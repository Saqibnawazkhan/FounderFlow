/**
 * /dashboard — Server Component. The heaviest page in the app — 4 data
 * sources fetched in parallel before render so the cash-flow chart,
 * founder breakdown, upcoming tasks list, and live feed all paint in one
 * pass instead of waterfalling client-side.
 */

import type { Metadata } from "next";
import { getTransactions } from "@/lib/queries/transactions";
import { getTasks } from "@/lib/queries/tasks";
import { getActivities } from "@/lib/queries/activities";
import { getCompanyUsers } from "@/lib/queries/users";
import { getClockedInPeers } from "@/lib/queries/time";
import { requireScopedSession } from "@/lib/queries/session";
import { DashboardClient } from "./dashboard-client";

export const metadata: Metadata = {
  title: "Dashboard",
  description:
    "Your startup at a glance — balance, runway, upcoming tasks, and live team activity.",
};

export default async function DashboardPage() {
  const [session, transactions, tasks, activities, users, clockedIn] = await Promise.all([
    requireScopedSession(),
    getTransactions(),
    getTasks(),
    getActivities(50),
    getCompanyUsers(),
    getClockedInPeers(),
  ]);

  return (
    <DashboardClient
      transactions={transactions}
      tasks={tasks}
      activities={activities}
      users={users}
      clockedIn={clockedIn}
      currentUserId={session.userId}
      currentUserName={session.userName}
    />
  );
}
