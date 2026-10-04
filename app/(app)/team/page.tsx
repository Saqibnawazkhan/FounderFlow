/**
 * /team — Server Component. Fetches users + the per-person contribution
 * aggregate + tasks in parallel so the per-member contribution and
 * task-completion cells can compute on the server before paint. Hands
 * everything to the client child which still owns the invite modal, role
 * select, and remove-confirm interactions.
 *
 * NO LEDGER ROWS CROSS THIS BOUNDARY (transactions-ledger-001). This page used
 * to fetch `getTransactions()` as well, and once the cells moved onto
 * `getContributionTotalsByUser()` nothing read the array — so it was up to
 * 15,000 ledger rows (every amount, description, category and author name)
 * serialized into the RSC payload of every admin and co-founder who opened
 * /team, for a page that renders none of them, and worst on exactly the large
 * workspaces the ceiling exists for. This page displays FIGURES ONLY; the
 * figures come from one `groupBy`. Pinned in
 * tests/app/finance/uncapped-totals.test.ts, which derives the list-window
 * caller set from source and fails if /team rejoins it.
 */

import type { Metadata } from "next";
import { getCompanyUsers, getDeactivatedUsers, getPendingInvites } from "@/lib/queries/users";
import { getContributionTotalsByUser } from "@/lib/queries/transactions";
import { getTasks } from "@/lib/queries/tasks";
import { requireScopedSession } from "@/lib/queries/session";
import { canSeeFinances } from "@/lib/auth/role-gates";
import { TeamClient } from "./team-client";

export const metadata: Metadata = {
  title: "Team",
  description: "Manage co-founders and team members, change roles, and invite new members.",
};

export default async function TeamPage() {
  const session = await requireScopedSession();
  // Members must never receive teammates' finance figures — don't even fetch
  // them (defense in depth: the client also hides the cells). This is also what
  // keeps the reader's own gate from firing: `getContributionTotalsByUser`
  // begins at `requireFinanceSession()`, so calling it unconditionally would
  // redirect every member off a page they are entitled to.
  const canSeeFin = canSeeFinances(session.role);

  const [users, contributions, tasks, pendingInvites, deactivatedUsers] = await Promise.all([
    getCompanyUsers(),
    // transactions-ledger-001. The per-member "invested / spent" cells were
    // reduced from a LIST window capped at 5,000 rows per type — and the rows a
    // ceiling drops are the OLDEST, so a founder who put money in early and then
    // stopped read as zero beside their own name. This aggregate has no ceiling,
    // and it is the only finance read this page makes.
    canSeeFin ? getContributionTotalsByUser() : Promise.resolve(undefined),
    getTasks(),
    getPendingInvites(),
    getDeactivatedUsers(),
  ]);

  return (
    <TeamClient
      users={users}
      contributions={contributions}
      tasks={tasks}
      pendingInvites={pendingInvites}
      deactivatedUsers={deactivatedUsers}
      currentUserId={session.userId}
      currentUserRole={session.role}
    />
  );
}
