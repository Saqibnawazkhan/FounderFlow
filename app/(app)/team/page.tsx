/**
 * /team — Server Component. Fetches users + transactions + tasks in parallel
 * so the per-member contribution + task-completion cells can compute on the
 * server before paint. Hands everything to the client child which still owns
 * the invite modal, role select, and remove-confirm interactions.
 */

import { getCompanyUsers } from "@/lib/queries/users";
import { getTransactions } from "@/lib/queries/transactions";
import { getTasks } from "@/lib/queries/tasks";
import { requireScopedSession } from "@/lib/queries/session";
import { TeamClient } from "./team-client";

export default async function TeamPage() {
  const [session, users, transactions, tasks] = await Promise.all([
    requireScopedSession(),
    getCompanyUsers(),
    getTransactions(),
    getTasks(),
  ]);

  return (
    <TeamClient
      users={users}
      transactions={transactions}
      tasks={tasks}
      currentUserId={session.userId}
      currentUserRole={session.role}
    />
  );
}
