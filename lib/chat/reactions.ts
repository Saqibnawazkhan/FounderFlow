/**
 * Folding raw MessageReaction rows into the chip rail the UI renders.
 *
 * The database stores one row per (message, user, emoji) — that is what makes
 * toggling a create-or-delete against `@@unique([messageId, userId, emoji])`
 * instead of a counter that can drift. The UI wants the opposite shape: one
 * chip per emoji carrying a count and whether *I* am in it. This is that
 * transform, kept pure so tests/lib/chat/reactions.test.ts can pin the
 * ordering and the `mine` flag without a database.
 */

import { REACTION_EMOJI } from "@/lib/schemas/chat";

/** One chip on the reaction rail. */
export type FoldedReaction = {
  emoji: string;
  count: number;
  /** Did the viewing user react with this emoji? Drives the "on" styling. */
  mine: boolean;
};

/** The shape the query selects — deliberately the minimum. */
export type ReactionRow = { emoji: string; userId: string };

// Position in the allow-list, so chips sort the same way everywhere.
const CANONICAL_ORDER = new Map<string, number>(REACTION_EMOJI.map((e, i) => [e, i]));

/**
 * Group `rows` by emoji for one message.
 *
 * Ordering is the fixed REACTION_EMOJI order, NOT count or recency. A rail
 * sorted by count reshuffles itself under the cursor every time somebody
 * reacts — you go to click 👍 and land on 🎉. A fixed order means a chip
 * never moves once it appears. Anything not in the allow-list (a row written
 * before an emoji was retired from the list) sorts after the known set rather
 * than being dropped, so a reaction never silently disappears.
 *
 * The same person cannot appear twice for one emoji — the unique index says
 * so — but duplicates are deduped anyway rather than inflating a count, since
 * this function also runs over rows a future bulk import might write.
 */
export function foldReactions(rows: ReactionRow[], viewerId: string): FoldedReaction[] {
  const byEmoji = new Map<string, { users: Set<string> }>();
  for (const row of rows) {
    let bucket = byEmoji.get(row.emoji);
    if (!bucket) {
      bucket = { users: new Set<string>() };
      byEmoji.set(row.emoji, bucket);
    }
    bucket.users.add(row.userId);
  }

  const folded: FoldedReaction[] = [];
  // forEach rather than for-of: tsconfig targets ES5 without
  // downlevelIteration, so iterating a Map directly is a compile error.
  byEmoji.forEach((bucket, emoji) => {
    folded.push({
      emoji,
      count: bucket.users.size,
      mine: bucket.users.has(viewerId),
    });
  });

  const unknownRank = CANONICAL_ORDER.size;
  folded.sort((a, b) => {
    const ra = CANONICAL_ORDER.get(a.emoji) ?? unknownRank;
    const rb = CANONICAL_ORDER.get(b.emoji) ?? unknownRank;
    if (ra !== rb) return ra - rb;
    // Two off-list emoji: fall back to codepoint order so the result is
    // deterministic rather than insertion-dependent.
    return a.emoji < b.emoji ? -1 : a.emoji > b.emoji ? 1 : 0;
  });
  return folded;
}
