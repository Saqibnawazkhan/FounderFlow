/**
 * /time — Server Component. Loads the current user's entries by default
 * (or the whole team if an admin/cofounder flips the toggle). The picker
 * itself is a client component because we want optimistic UI for the
 * scope toggle and the edit modal.
 */

import type { Metadata } from "next";
import { getEntries } from "@/lib/queries/time";
import { getCompanyUsers } from "@/lib/queries/users";
import { listTaskOptions } from "@/lib/queries/tasks";
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
  // Members never see the edit modal, so skip the task fetch for them entirely.
  //
  // `listTaskOptions`, NOT `getTasks` (perf-002). This page needs `{ id, title }`
  // for a `<select>`; `getTasks()` is the BOARD read — a 300-row window that
  // carries a comment-count subquery and a project join per row, every field of
  // which then crossed the RSC boundary so that a `tasks.map((t) => ({ id,
  // title }))` right here could throw all but two of them away. The mapping
  // step is gone with it. `listTaskOptions` asks for the two columns, keeps the
  // ceiling, and shares the board's one `where`, so the picker can never offer a
  // task the board says does not exist (tombstoned, or in a deleted / completed
  // / archived project).
  const [entries, users, taskOptions] = await Promise.all([
    getEntries(scope),
    canSeeTeam ? getCompanyUsers() : Promise.resolve([]),
    canSeeTeam ? listTaskOptions() : Promise.resolve([]),
  ]);

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
