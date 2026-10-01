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
  // THE TASK OPTIONS ARE FETCHED FOR EVERY ROLE (time-002).
  //
  // This was `canSeeTeam ? listTaskOptions() : Promise.resolve([])`, on the
  // premise that "members never see the edit modal, so skip the task fetch for
  // them entirely". The premise is true and the conclusion is not: `tasks` feeds
  // TWO modals. The edit modal is indeed admin/cofounder-only, but the "Log time"
  // button is rendered for every role in TimeClient, `<ManualEntryModal>` takes
  // the same `tasks` prop, and `createManualEntryAction` has no role gate at all
  // — deliberately, so any member can log their own forgotten work without
  // elevated permission. So a member's Log-time dropdown held exactly one option,
  // "Untagged work".
  //
  // It landed hardest on the one role that cannot also EDIT an entry: a member who
  // mistimes a session has to delete and re-log it, and re-logging stripped the
  // tag. Every member-logged hour became untagged work, which is the per-task and
  // per-project reporting the feature exists for.
  //
  // Fetching for everyone leaks nothing: `listTaskOptions` shares the board's
  // `taskScopeWhere`, which narrows a member to `assignedTo: <them>` at the data
  // boundary. The EDIT modal stays behind `canSeeTeam` in TimeClient, where that
  // gate belongs.
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
  const [entryPage, users, taskOptions] = await Promise.all([
    getEntries(scope),
    canSeeTeam ? getCompanyUsers() : Promise.resolve([]),
    listTaskOptions(),
  ]);

  return (
    <TimeClient
      // The server's clock, so the server render and the first client render
      // agree on every duration (time-011).
      serverNowMs={Date.now()}
      initialEntries={entryPage.entries}
      // The read is bounded. Saying so is the fix for time-010: the client's
      // totals and the Week grid are computed from this window, and presenting a
      // window as a lifetime total is what made /time and /settings disagree.
      entriesTruncated={entryPage.truncated}
      oldestLoadedAt={entryPage.oldestLoadedAt}
      users={users}
      tasks={taskOptions}
      currentUserId={session.userId}
      currentUserRole={session.role}
      canSeeTeam={canSeeTeam}
      initialScope={scope}
    />
  );
}
