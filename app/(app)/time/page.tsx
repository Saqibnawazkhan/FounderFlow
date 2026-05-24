/**
 * /time — Server Component. Loads the current user's entries by default
 * (or the whole team if an admin/cofounder flips the toggle). The picker
 * itself is a client component because we want optimistic UI for the
 * scope toggle and the edit modal.
 */

import type { Metadata } from "next";
import { getEntries } from "@/lib/queries/time";
import { getCompanyUsers } from "@/lib/queries/users";
import { getTasks } from "@/lib/queries/tasks";
import { requireScopedSession } from "@/lib/queries/session";
import { canEditEntryTimes } from "@/lib/time/thresholds";
import { TimeClient } from "./time-client";

export const metadata: Metadata = {
  title: "Time",
  description: "Clock in, clock out, and review your team's logged hours.",
};

type SearchParams = { scope?: string };

export default async function TimePage({ searchParams }: { searchParams: SearchParams }) {
  const session = await requireScopedSession();
  const canSeeTeam = canEditEntryTimes(session.role);
  // Only honor `?scope=team` when the caller is actually allowed; the query
  // helper also guards but this keeps the URL state honest in the UI.
  const scope = canSeeTeam && searchParams.scope === "team" ? "team" : "mine";
  const [entries, users, tasks] = await Promise.all([
    getEntries(scope),
    canSeeTeam ? getCompanyUsers() : Promise.resolve([]),
    canSeeTeam ? getTasks() : Promise.resolve([]),
  ]);

  // Members never see the edit modal, so skip the tasks fetch for them.
  const taskOptions = tasks.map((t) => ({ id: t.id, title: t.title }));

  return (
    <TimeClient
      initialEntries={entries}
      users={users}
      tasks={taskOptions}
      currentUserId={session.userId}
      currentUserRole={session.role}
      canSeeTeam={canSeeTeam}
      initialScope={scope}
    />
  );
}
