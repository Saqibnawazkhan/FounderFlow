/**
 * The company roster a COMPOSER resolves @mentions against.
 *
 * Finding tasks-and-comments-002. `User.handle` exists, Settings advertises it
 * as "the @mention address" and lets people change it, the parser gives handles
 * their own sovereign namespace, and the autocomplete hook inserts
 * `mentionToken(u)` — which prefers the handle. But no handle ever reached the
 * client: the `User` DTO (lib/types.ts) carries no `handle`, `getCompanyUsers`
 * does not return one, and every composer host then narrowed further still with
 * `users.map((u) => ({ id: u.id, name: u.name }))`. So `mentionToken` always
 * fell back to the name slug, and two things followed:
 *
 *   1. The dropdown could never offer anybody's handle, on any surface, so
 *      following the app's own instructions typed an address the composer had
 *      never heard of.
 *   2. A teammate whose display name carries no ASCII letters has NO name slug
 *      — "مہوش زیدی" slugifies to `"-"`, which the token grammar cannot produce
 *      — so `useMentionAutocomplete` filtered them out of `candidates`
 *      entirely. The person the handle column was ADDED for was the one person
 *      unmentionable from any composer.
 *
 * WHY A QUERY OF ITS OWN rather than widening the `User` DTO. Adding
 * `handle` to `lib/types.ts` and to `getCompanyUsers` is the smaller change and
 * is the better long-term shape — it would fix the project and expenses
 * composers in the same stroke, and it is recorded as the follow-up. Both files
 * belong to other slices of this wave, and a fix that cannot land is not a fix:
 * this repo's signature defect is complete, tested code with no caller. So the
 * mention roster is read here, where the parser and the composer already live,
 * and /tasks passes it straight to the thread.
 *
 * `select` is the SAME projection the two server-side rosters use
 * (lib/actions/comments.ts, lib/queries/comments.ts), and it must stay that way:
 * `MentionUser.handle` is optional in the TYPE on purpose, so dropping
 * `handle: true` from a roster select is neither a type error nor a runtime
 * error — it is silence, and it is exactly this bug.
 *
 * WHOLE-COMPANY ON PURPOSE. `buildMentionIndex` is a two-pass algorithm whose
 * correctness rests on seeing every claimant of a token: a handle or a name slug
 * contested by two people must be VOIDED rather than handed to whichever of them
 * the query happened to return. A roster that filtered anybody out (including
 * the reader) would silently turn a voided token into a wrong-person ping.
 * `useMentionAutocomplete` drops the reader from the offered list itself, via
 * `excludeUserId`.
 */

import { db } from "@/lib/db";
import { requireScopedSession } from "@/lib/queries/session";
import type { MentionUser } from "@/lib/comments/mentions";

export async function getMentionRoster(): Promise<MentionUser[]> {
  const { companyId } = await requireScopedSession();
  return db.user.findMany({
    // Tier 3: a tombstoned teammate is not mentionable, matching
    // `getCompanyUsers` and both server-side rosters.
    where: { companyId, deletedAt: null },
    select: { id: true, name: true, handle: true },
    orderBy: [{ role: "asc" }, { name: "asc" }],
  });
}
