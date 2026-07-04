/**
 * /team — Server Component. Fetches users + transactions + tasks in parallel
 * so the per-member contribution + task-completion cells can compute on the
 * server before paint. Hands everything to the client child which still owns
 * the invite modal, role select, and remove-confirm interactions.
 */

import type { Metadata } from "next";
import { getCompanyUsers, getDeactivatedUsers, getPendingInvites } from "@/lib/queries/users";
import { getTransactions } from "@/lib/queries/transactions";
import { getTasks } from "@/lib/queries/tasks";
import { requireScopedSession } from "@/lib/queries/session";
import { TeamClient } from "./team-client";

export const metadata: Metadata = {
  title: "Team",
  description: "Manage co-founders and team members, change roles, and invite new members.",
};

export default async function TeamPage() {
  const [session, users, transactions, tasks, pendingInvites, deactivatedUsers] = await Promise.all(
    [
      requireScopedSession(),
      getCompanyUsers(),
      getTransactions(),
      getTasks(),
      getPendingInvites(),
      getDeactivatedUsers(),
    ]
  );

  return (
    <TeamClient
      users={users}
      transactions={transactions}
      tasks={tasks}
      pendingInvites={pendingInvites}
      deactivatedUsers={deactivatedUsers}
      currentUserId={session.userId}
      currentUserRole={session.role}
    />
  );
}
