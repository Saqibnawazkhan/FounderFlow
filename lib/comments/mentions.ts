/**
 * @mention parser.
 *
 * Token format: `@handle` (case-insensitive). Example: typing `@ali reviewed
 * this` resolves against the teammate whose `User.handle` is `ali`. A name
 * slug — lowercase + spaces→hyphens + strip non-[a-z0-9-] — still resolves as
 * a FALLBACK, so `@Ali-Khan` keeps working in every comment written before
 * handles existed and for anyone who never picked one.
 *
 * Why server-side: trusting the client to send a list of mention IDs lets
 * any user fan out a notification to arbitrary people. The server re-parses
 * the body against the company-scoped user list to avoid that.
 *
 * ---------------------------------------------------------------------------
 * PRECEDENCE — the handle namespace is sovereign, name slugs fill what's left
 * ---------------------------------------------------------------------------
 * The moment one token can mean two things, one token can point at two people:
 * Zainab picks the handle `ali`, and a colleague *named* "Ali" slugifies to
 * `ali` too. Three rules were on the table — name-wins, handle-wins, and
 * ambiguity-is-no-match. What `buildMentionIndex` below implements is the
 * third applied inside the second:
 *
 *   1. A HANDLE ALWAYS RESOLVES TO ITS OWNER. Handles are unique per company
 *      in the database (`@@unique([companyId, handle])`, schema.prisma:136), so
 *      inside one workspace a handle token has exactly one owner and is never
 *      ambiguous. Nothing a third party types into their own profile can take
 *      that token away or blank it out.
 *   2. A NAME SLUG RESOLVES ONLY IN THE LEFTOVER SPACE: the token must be
 *      claimed by no handle at all, AND exactly one person's name must slugify
 *      to it. Two "Ali Khan"s no longer ping the first one in roster order —
 *      `@ali-khan` resolves to NOBODY and renders as plain text.
 *
 * Why not name-wins: a name is edited by its owner at any moment and is not
 * unique. If a name slug could outrank a handle, a stranger renaming
 * themselves to "Ali" would silently steal Zainab's chosen address — or, if we
 * called that collision ambiguous and dropped it, silently DELETE it. An
 * identity a stranger can revoke by editing their own profile is not an
 * address. The derived, mutable thing must never outrank the chosen, stable,
 * database-unique one; that asymmetry is the whole argument.
 *
 * Why the leftover space is no-match and not the old first-match-wins: "first"
 * meant roster order, which is `findMany` order, which is not something any
 * writer can see or reason about. Pinging a coin-flip colleague is worse than
 * pinging nobody. Nobody is VISIBLE (no chip renders, the raw `@token` stays
 * as text) and RECOVERABLE (the autocomplete offers each person's unique
 * handle); the wrong ping is silent to the writer and baffling to whoever
 * receives it.
 *
 * The residual risk, stated plainly: someone hand-typing `@ali` while thinking
 * of the colleague *named* Ali reaches Zainab, who owns the handle. Two things
 * keep that from being silent — the autocomplete inserts the HANDLE, so a
 * mention picked from the list is never the guessed one, and
 * `tokenizeForRender` labels the chip with the resolved person's display name,
 * so the writer sees who `@ali` became in their own posted comment.
 *
 * REJECTED — widening the token regex to `\p{L}` so Urdu names slug directly.
 * It looks like the one-line version of T16 and it is not. Urdu writes no
 * ASCII word boundary the tokenizer can stop at, so `@` followed by prose
 * swallows the rest of the sentence into the token and every mention inside an
 * Urdu sentence resolves to nobody, silently. It also needs the `u` flag,
 * which tsconfig's absent `target` (tsc defaults to ES5) rejects as TS1501.
 * Giving everyone a typable ASCII address leaves the grammar alone instead of
 * making it guess. Same conclusion as the `User.handle` comment in
 * schema.prisma:51 — please don't re-propose it.
 *
 * Edge cases we deliberately handle:
 *  - duplicate @ tokens for the same user → dedupe to one mention
 *  - @author themselves                  → drop (no self-pings)
 *  - email-style `@foo.com` patterns     → ignored unless the token matches
 *  - trailing punctuation `@Ali,`        → trimmed via the token regex
 *  - a name in a non-ASCII script (T16)  → reachable through their handle
 *  - two people sharing a name slug      → resolves to nobody, not to "first"
 *  - a name slug hitting someone's handle→ the handle's owner, always
 *  - a name slugging to a lone `-`       → contributes no token at all; see
 *    `nameSlugToken`, which shape-checks rather than testing for emptiness
 *
 * Edge cases we deliberately DON'T handle (yet):
 *  - a handle that can't be typed as a token (`ali.khan`, `2024`) → indexed
 *    by nobody and simply never resolves. Keeping such a handle out of the
 *    database belongs to the mint/edit path, not to the parser, which has no
 *    way to report the problem to the person it affects.
 *  - a roster loaded without `handle` in its `select` → degrades to name-slug
 *    behaviour, i.e. back to T16 for that surface. `MentionUser.handle` is
 *    optional in the TYPE so those call sites keep compiling, which means only
 *    a grep catches them — see the roster selects in lib/queries/ and
 *    lib/actions/.
 */

export type MentionUser = {
  id: string;
  name: string;
  /**
   * The chosen, per-company-unique address. Optional in the type and NOT in
   * the data: every existing row was backfilled (migration
   * 20260925140000_add_user_handle) and the column stays nullable only so a
   * row whose email local-part sanitises to nothing can exist. It is optional
   * here so a roster query that hasn't added `handle: true` to its `select`
   * still type-checks — at the cost of silently resolving by name slug alone.
   */
  handle?: string | null;
};

/**
 * Composer autocomplete (T6): if `caret` sits inside an in-progress `@token`,
 * return the token's span (`from`..`to`) and the partial `query` after the
 * `@`. A token starts at an `@` that's at the start of the string or preceded
 * by whitespace and runs through unbroken `[a-zA-Z0-9-]` up to the caret.
 * Returns null when the caret isn't inside a mention token.
 *
 * Kept next to the parser so the detection rule (what starts a mention) and
 * the extraction rule (what resolves to a user) stay in lockstep.
 */
export type ActiveMention = { from: number; to: number; query: string };
export function findMentionQuery(value: string, caret: number): ActiveMention | null {
  let i = caret - 1;
  while (i >= 0) {
    const ch = value[i];
    if (ch === "@") {
      const prev = i > 0 ? value[i - 1] : "";
      if (prev === "" || /\s/.test(prev)) {
        const query = value.slice(i + 1, caret);
        if (/^[a-zA-Z0-9-]*$/.test(query)) return { from: i, to: caret, query };
      }
      return null;
    }
    if (/\s/.test(ch)) return null; // whitespace before an @ → not a mention
    i--;
  }
  return null;
}

/**
 * Lowercase, spaces→hyphens, strip non-alphanum-hyphen.
 *
 * NOTE this is lossy by design and is no longer the address of record: a name
 * carrying no ASCII letters comes back as the EMPTY STRING, which is the T16
 * bug in one line. Callers must treat `""` as "this person has no name slug"
 * and fall back to the handle — `mentionToken` does exactly that. Kept public
 * because the composer still renders a name slug as a hint and because every
 * pre-handle comment body in the database is written in this grammar.
 */
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

// The same grammar as MENTION_REGEX, anchored, already lowercased. A handle
// that doesn't match this shape can never be produced by the tokenizer, so
// indexing it would be indexing a key nobody can ever look up.
const TYPABLE_TOKEN = /^[a-z][a-z0-9-]*$/;

/**
 * The lookup key a handle contributes, or `""` when it contributes none.
 * Lowercased because tokens are matched case-insensitively; shape-checked
 * because an untypable handle (`ali.khan`, `2024`, `مہوش`) is unreachable
 * through the token grammar no matter what we do with it.
 */
export function normalizeHandle(handle: string | null | undefined): string {
  if (!handle) return "";
  const normalized = handle.trim().toLowerCase();
  return TYPABLE_TOKEN.test(normalized) ? normalized : "";
}

/**
 * The lookup key a display NAME contributes, or `""` when it contributes none.
 *
 * Not merely `slugifyName(name) !== ""`: "مہوش زیدی" slugifies to `"-"`,
 * because the space becomes a hyphen BEFORE the non-ASCII letters are
 * stripped. A lone hyphen is non-empty and still untypable — MENTION_REGEX
 * demands a leading ASCII letter — so an emptiness check would index a key no
 * token can ever produce and would offer a composer row that inserts `"@- "`.
 * Shape-check against the token grammar instead of guessing at emptiness.
 */
function nameSlugToken(name: string): string {
  const slug = slugifyName(name);
  return TYPABLE_TOKEN.test(slug) ? slug : "";
}

/**
 * What the UI should show, and what the composer should insert, for `user`.
 * The handle when there is a typable one, the name slug otherwise — the same
 * precedence the resolver uses, so what you see offered is what will resolve.
 *
 * Returns `""` for the one person with neither: no typable handle AND a name
 * that yields no typable slug. Rendering `@` followed by nothing is the third
 * symptom listed in T16, so callers should drop the row rather than print an
 * empty token.
 */
export function mentionToken(user: MentionUser): string {
  return normalizeHandle(user.handle) || nameSlugToken(user.name);
}

/**
 * Token → user, with the precedence rules from the module header applied.
 *
 * Built in two passes because the passes are not symmetric: pass one owns its
 * namespace outright, pass two may only occupy what pass one never touched —
 * INCLUDING tokens pass one had to void. A handle contested by two users is a
 * database impossibility (`@@unique([companyId, handle])`), but the roster
 * arrives here as a plain array that any caller can assemble, so a contested
 * handle voids its token permanently rather than handing it down to a third
 * person's name slug, which would be the wrong-person ping by another route.
 *
 * The merge at the end uses `Map.forEach` rather than `for…of` over the Map:
 * tsconfig sets no `target`, so tsc defaults to ES5 and iterating a Map or Set
 * directly is TS2802.
 */
function buildMentionIndex(companyUsers: MentionUser[]): Map<string, MentionUser> {
  // PASS 1 — handles. `claimedHandles` remembers every handle token seen,
  // including ones later voided, so pass 2 can't move into the wreckage.
  const handleOwner = new Map<string, MentionUser>();
  const claimedHandles = new Set<string>();
  for (const u of companyUsers) {
    const handle = normalizeHandle(u.handle);
    if (!handle) continue;
    if (claimedHandles.has(handle)) {
      const owner = handleOwner.get(handle);
      // The same user listed twice keeps their handle; a genuine contest voids it.
      if (!owner || owner.id !== u.id) handleOwner.delete(handle);
      continue;
    }
    claimedHandles.add(handle);
    handleOwner.set(handle, u);
  }

  // PASS 2 — name slugs, in the leftover space only.
  const slugOwner = new Map<string, MentionUser>();
  const claimedSlugs = new Set<string>();
  for (const u of companyUsers) {
    const slug = nameSlugToken(u.name);
    if (!slug) continue; // T16: a non-ASCII name yields no token — the handle carries them.
    if (claimedHandles.has(slug)) continue; // handles outrank name slugs, always.
    if (claimedSlugs.has(slug)) {
      const owner = slugOwner.get(slug);
      if (!owner || owner.id !== u.id) slugOwner.delete(slug);
      continue;
    }
    claimedSlugs.add(slug);
    slugOwner.set(slug, u);
  }

  const index = new Map<string, MentionUser>();
  handleOwner.forEach((u, token) => index.set(token, u));
  slugOwner.forEach((u, token) => index.set(token, u));
  return index;
}

/**
 * Pull every @token out of `body` and return the unique list of matching
 * user IDs (excluding the author). Returns IDs in first-appearance order.
 */
export function extractMentions(
  body: string,
  companyUsers: MentionUser[],
  authorId: string
): string[] {
  const index = buildMentionIndex(companyUsers);

  const matchedIds: string[] = [];
  const seen = new Set<string>();
  // Reset regex state for fresh exec calls (`g` flag is stateful)
  MENTION_REGEX.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = MENTION_REGEX.exec(body)) !== null) {
    const token = match[1].toLowerCase();
    const user = index.get(token);
    if (!user) continue;
    if (user.id === authorId) continue;
    if (seen.has(user.id)) continue;
    seen.add(user.id);
    matchedIds.push(user.id);
  }

  return matchedIds;
}

/**
 * Render-time helper: split `body` into alternating text/mention segments
 * so the UI can render mention tokens as styled chips.
 *
 * Returns segments like `[{ type: "text", text: "Hey " }, { type: "mention",
 * slug: "ali", userId?: string, name?: string }]`. The userId is resolved
 * through the same index `extractMentions` uses, so a chip renders exactly
 * when a notification fired; absent if the token doesn't match anyone
 * (renders as plain @text in that case).
 *
 * `slug` keeps its name for the call sites that already read it, but it now
 * holds THE TOKEN AS TYPED — a handle or a name slug. Callers show `name` in
 * preference to it anyway, which is what makes the precedence rule auditable:
 * the writer sees which person `@ali` resolved to.
 */
export type CommentSegment =
  | { type: "text"; text: string }
  | { type: "mention"; slug: string; userId?: string; name?: string };

export function tokenizeForRender(body: string, companyUsers: MentionUser[]): CommentSegment[] {
  const index = buildMentionIndex(companyUsers);

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
    const user = index.get(slug);
    if (user) {
      segments.push({ type: "mention", slug, userId: user.id, name: user.name });
    } else {
      // Unrecognised or deliberately-ambiguous token → render the raw `@token`
      // as text so users don't feel like the system "ate" their input, and so
      // an unresolved mention is visibly unresolved rather than silently lost.
      segments.push({ type: "text", text: body.slice(start, end) });
    }
    cursor = end;
  }
  if (cursor < body.length) {
    segments.push({ type: "text", text: body.slice(cursor) });
  }
  return segments;
}
