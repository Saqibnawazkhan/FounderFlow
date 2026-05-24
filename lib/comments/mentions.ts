/**
 * @mention parser.
 *
 * Token format: `@first-last` (case-insensitive). Example: typing
 * `@Ali-Khan reviewed this` resolves against the user whose name slugifies
 * to `ali-khan`. We slugify (lowercase + spaces→hyphens + strip
 * non-[a-z0-9-]) on both sides so "Ali Khan" and "ALI KHAN" both match.
 *
 * Why server-side: trusting the client to send a list of mention IDs lets
 * any user fan out a notification to arbitrary people. The server re-parses
 * the body against the company-scoped user list to avoid that.
 *
 * Edge cases we deliberately handle:
 *  - duplicate @ tokens for the same user → dedupe to one mention
 *  - @author themselves                  → drop (no self-pings)
 *  - email-style `@foo.com` patterns     → ignored unless slug matches
 *  - trailing punctuation `@Ali,`        → trimmed via the token regex
 *
 * Edge cases we deliberately DON'T handle (yet):
 *  - ambiguous slugs (two "Ali Khan"s)   → first match wins; documented
 *  - non-ASCII names (Urdu script users) → only ASCII letters are slugged
 */

export type MentionUser = {
  id: string;
  name: string;
};

/** Lowercase, spaces→hyphens, strip non-alphanum-hyphen. */
export function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

// The token regex matches `@` followed by 1+ ASCII letters/digits/hyphens.
// Leading char must be a letter so `@2024` doesn't tokenize.
const MENTION_REGEX = /@([a-zA-Z][a-zA-Z0-9-]*)/g;

/**
 * Pull every @slug out of `body` and return the unique list of matching
 * user IDs (excluding the author). Returns IDs in first-appearance order.
 */
export function extractMentions(
  body: string,
  companyUsers: MentionUser[],
  authorId: string
): string[] {
  const slugIndex = new Map<string, string>();
  for (const u of companyUsers) {
    const slug = slugifyName(u.name);
    // Skip empty slugs (e.g. all-non-ASCII names) and keep first-write-wins
    // semantics so a duplicate slug doesn't overwrite the earlier user.
    if (slug && !slugIndex.has(slug)) slugIndex.set(slug, u.id);
  }

  const matchedIds: string[] = [];
  const seen = new Set<string>();
  // Reset regex state for fresh exec calls (`g` flag is stateful)
  MENTION_REGEX.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = MENTION_REGEX.exec(body)) !== null) {
    const token = match[1].toLowerCase();
    const userId = slugIndex.get(token);
    if (!userId) continue;
    if (userId === authorId) continue;
    if (seen.has(userId)) continue;
    seen.add(userId);
    matchedIds.push(userId);
  }

  return matchedIds;
}

/**
 * Render-time helper: split `body` into alternating text/mention segments
 * so the UI can render mention slugs as styled chips.
 *
 * Returns segments like `[{ type: "text", text: "Hey " }, { type: "mention",
 * slug: "ali-khan", userId?: string, name?: string }]`. The userId is
 * resolved via the `companyUsers` lookup; absent if the slug doesn't
 * match anyone (renders as plain @text in that case).
 */
export type CommentSegment =
  | { type: "text"; text: string }
  | { type: "mention"; slug: string; userId?: string; name?: string };

export function tokenizeForRender(body: string, companyUsers: MentionUser[]): CommentSegment[] {
  const slugIndex = new Map<string, MentionUser>();
  for (const u of companyUsers) {
    const slug = slugifyName(u.name);
    if (slug && !slugIndex.has(slug)) slugIndex.set(slug, u);
  }

  const segments: CommentSegment[] = [];
  let cursor = 0;
  MENTION_REGEX.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = MENTION_REGEX.exec(body)) !== null) {
    const start = match.index;
    const end = MENTION_REGEX.lastIndex;
    if (start > cursor) {
      segments.push({ type: "text", text: body.slice(cursor, start) });
    }
    const slug = match[1].toLowerCase();
    const user = slugIndex.get(slug);
    if (user) {
      segments.push({ type: "mention", slug, userId: user.id, name: user.name });
    } else {
      // Unrecognised slug → render the raw `@token` as text so users don't
      // feel like the system "ate" their input.
      segments.push({ type: "text", text: body.slice(start, end) });
    }
    cursor = end;
  }
  if (cursor < body.length) {
    segments.push({ type: "text", text: body.slice(cursor) });
  }
  return segments;
}
