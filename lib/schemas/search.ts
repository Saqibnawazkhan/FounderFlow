/**
 * Zod schema + shared constants for cross-content search (Phase H).
 *
 * The union of searchable content types lives HERE rather than in
 * prisma/schema.prisma or in the query file, for the same reason every other
 * union in this codebase does: the columns it describes are plain Strings and
 * zod owns the allowed values at the application boundary. `SEARCH_GROUPS` is
 * additionally the RENDER ORDER — lib/queries/search.ts walks this tuple to
 * assemble its result, so the palette's section order is decided once, here,
 * and cannot drift between the query and the UI.
 *
 * The palette is a client component that calls `searchAction`, so this module
 * is the one place the query string is validated. It must not assume the
 * caller is the palette: anything arriving at a server action is untrusted
 * input, including input that came from our own form a moment ago.
 */

import { z } from "zod";

/**
 * Every content type the palette can return, in the order it renders them.
 *
 * Tasks and projects first because they are what someone reaches for the
 * palette to find; messages next; the two finance groups last — they are also
 * the two groups a member never receives at all (see `canSeeFinances` in
 * lib/auth/role-gates.ts and rule 3 in lib/queries/search.ts).
 */
export const SEARCH_GROUPS = ["task", "project", "message", "transaction", "budget"] as const;
export type SearchGroup = (typeof SEARCH_GROUPS)[number];

/**
 * WHY 2 AND NOT 1.
 *
 * A one-character query matches a large fraction of the workspace: every task
 * whose title contains an "a", every project, every category. That is a full
 * scan per keystroke — five ILIKE scans and one tsquery — to produce a
 * shortlist that is effectively random and that nobody typed one character
 * hoping to see. The palette fires on a debounce as you type, so the first
 * character of EVERY search would pay that cost, and the results would be
 * thrown away a few milliseconds later when the second character arrived.
 *
 * Two characters is not a meaningful restriction on real searches (nobody
 * looks for a task by a single letter) and it removes the single most
 * expensive, least useful query in the feature. The UI should simply render
 * nothing below a two-character term rather than showing an error — this
 * schema rejects it so the server never runs the scan either way.
 */
export const SEARCH_MIN_LENGTH = 2;

/**
 * 100 characters. Nobody type-aheads a paragraph; a long term is either a
 * paste accident or someone probing, and `websearch_to_tsquery` on a 10KB
 * string is real parsing work done per keystroke-burst for a result that
 * cannot match anything.
 */
export const SEARCH_MAX_LENGTH = 100;

/**
 * `.trim()` runs before `.min()` — zod applies string checks in declaration
 * order — so "  " is a zero-length term and is rejected, not accepted as two
 * characters of whitespace that then match every row in the workspace.
 */
export const SearchQuerySchema = z.object({
  q: z
    .string()
    .trim()
    .min(SEARCH_MIN_LENGTH, `Type at least ${SEARCH_MIN_LENGTH} characters`)
    .max(SEARCH_MAX_LENGTH, "That search is too long"),
});

export type SearchQueryInput = z.infer<typeof SearchQuerySchema>;
