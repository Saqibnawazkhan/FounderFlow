/**
 * /dashboard — Server Component. The heaviest page in the app — 4 data
 * sources fetched in parallel before render so the cash-flow chart,
 * founder breakdown, upcoming tasks list, and live feed all paint in one
 * pass instead of waterfalling client-side.
 */

import { getTransactions } from "@/lib/queries/transactions";
import { getTasks } from "@/lib/queries/tasks";
import { getActivities } from "@/lib/queries/activities";
import { getCompanyUsers } from "@/lib/queries/users";
import { requireScopedSession } from "@/lib/queries/session";
import { DashboardClient } from "./dashboard-client";

export default async function DashboardPage() {
  const [session, transactions, tasks, activities, users] = await Promise.all([
    requireScopedSession(),
    getTransactions(),
    getTasks(),
    getActivities(50),
    getCompanyUsers(),
  ]);

  return (
    <DashboardClient
      transactions={transactions}
      tasks={tasks}
      activities={activities}
      users={users}
      currentUserName={session.userName}
    />
  );
}
