/**
 * /dashboard — Server Component. The heaviest page in the app — 4 data
 * sources fetched in parallel before render so the cash-flow chart,
 * founder breakdown, upcoming tasks list, and live feed all paint in one
 * pass instead of waterfalling client-side.
 */

import type { Metadata } from "next";
import {
  getContributionTotalsByUser,
  getExpenseTotalsByCategory,
  getMonthToDateExpense,
  getMonthlyTotals,
  getTransactionTotals,
  getTransactions,
} from "@/lib/queries/transactions";
import { utcMonthsAgo } from "@/lib/date-range";
import { getTasks, getTaskStatusCounts } from "@/lib/queries/tasks";
import { getActivities } from "@/lib/queries/activities";
import { getCompanyUsers } from "@/lib/queries/users";
import { getClockedInPeers } from "@/lib/queries/time";
import { requireScopedSession } from "@/lib/queries/session";
import { DashboardClient } from "./dashboard-client";
// The window sizes come from ./windows, a module with no `"use client"`. They
// were imported from ./dashboard-client, and because React proxies every export
// of a client module this Server Component got `{}` instead of `3` — so
// `utcMonthsAgo(now, BURN_WINDOW_MONTHS)` was an Invalid Date and the
// `getTransactionTotals` call below threw, taking the whole page to the error
// boundary. Guarded by tests/app/dashboard/client-boundary.test.ts.
import { BURN_WINDOW_MONTHS, CASH_FLOW_MONTHS } from "./windows";

export const metadata: Metadata = {
  title: "Dashboard",
  description:
    "Your startup at a glance — balance, runway, upcoming tasks, and live team activity.",
};

export default async function DashboardPage() {
  // One `now` for every window below: two calls to new Date() inside one
  // Promise.all can straddle a month boundary and produce a month-to-date
  // figure that disagrees with the chart beside it.
  const now = new Date();
  const [
    session,
    transactions,
    tasks,
    taskCounts,
    activities,
    users,
    clockedIn,
    totals,
    monthToDate,
    burnWindow,
    monthly,
    categories,
    contributions,
  ] = await Promise.all([
    requireScopedSession(),
    getTransactions(),
    getTasks(),
    // Not tasks.length: getTasks() is page 1 of a 300-row window, so the KPI
    // must come from the unbounded groupBy or it under-reports past 300.
    getTaskStatusCounts(),
    getActivities(50),
    getCompanyUsers(),
    getClockedInPeers(),
    // money-008: every figure below comes from an aggregate, never from
    // summing `transactions` — that array is a per-type 5,000-row window.
    getTransactionTotals(),
    getMonthToDateExpense(now),
    // A ROLLING window, not a calendar one: a calendar window includes a
    // partial current month, which understates burn and so overstates runway.
    getTransactionTotals({ from: utcMonthsAgo(now, BURN_WINDOW_MONTHS) }),
    getMonthlyTotals(CASH_FLOW_MONTHS, now),
    getExpenseTotalsByCategory(),
    getContributionTotalsByUser(),
  ]);

  return (
    <DashboardClient
      transactions={transactions}
      tasks={tasks}
      taskCounts={taskCounts}
      rollups={{
        totals,
        monthToDateExpense: monthToDate,
        burnWindowExpense: burnWindow.byType.expense.total,
        monthly,
        categories,
        contributions,
      }}
      activities={activities}
      users={users}
      clockedIn={clockedIn}
      currentUserId={session.userId}
      currentUserName={session.userName}
    />
  );
}
