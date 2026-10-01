/**
 * Read-side queries for time entries. The topbar widget calls getOpenEntry
 * on mount to know whether to render the running ticker or the "Clock in"
 * button. The /time page calls getEntries for the table (optionally for
 * the whole team when an admin/cofounder is viewing).
 */

import { db } from "@/lib/db";
import { requireScopedSession } from "@/lib/queries/session";
import { canEditEntryTimes } from "@/lib/time/thresholds";

export interface TimeEntryClient {
  id: string;
  companyId: string;
  userId: string;
  userName: string;
  taskId: string | null;
  taskTitle: string | null;
  note: string | null;
  clockInAt: string;
  clockOutAt: string | null;
  lastActivityAt: string;
  autoClosed: boolean;
  editedBy: string | null;
  editedByName: string | null;
  editedAt: string | null;
  createdAt: string;
}

function toClient(t: {
  id: string;
  companyId: string;
  userId: string;
  userName: string;
  taskId: string | null;
  taskTitle: string | null;
  note: string | null;
  clockInAt: Date;
  clockOutAt: Date | null;
  lastActivityAt: Date;
  autoClosed: boolean;
  editedBy: string | null;
  editedByName: string | null;
  editedAt: Date | null;
  createdAt: Date;
}): TimeEntryClient {
  return {
    id: t.id,
    companyId: t.companyId,
    userId: t.userId,
    userName: t.userName,
    taskId: t.taskId,
    taskTitle: t.taskTitle,
    note: t.note,
    clockInAt: t.clockInAt.toISOString(),
    clockOutAt: t.clockOutAt ? t.clockOutAt.toISOString() : null,
    lastActivityAt: t.lastActivityAt.toISOString(),
    autoClosed: t.autoClosed,
    editedBy: t.editedBy,
    editedByName: t.editedByName,
    editedAt: t.editedAt ? t.editedAt.toISOString() : null,
    createdAt: t.createdAt.toISOString(),
  };
}

export interface ClockedInPeers {
  count: number;
  peers: { userId: string; userName: string }[];
}

/**
 * Everyone in the company currently on the clock (an open entry — clockOutAt
 * null). Powers the dashboard "clocked in now" card. Deduped by user (a user
 * should only ever have one open entry, but we dedupe defensively). Company-
 * scoped, so it only reveals teammates in the caller's own workspace.
 */
export async function getClockedInPeers(): Promise<ClockedInPeers> {
  const { companyId } = await requireScopedSession();
  const rows = await db.timeEntry.findMany({
    // `deletedAt: null` — see the note on `getOpenEntry`. Without it, a user who
    // deleted their own running timer stayed in the dashboard's "clocked in now"
    // count for ever.
    where: { companyId, clockOutAt: null, deletedAt: null },
    orderBy: { clockInAt: "desc" },
    select: { userId: true, userName: true },
  });
  const seen = new Set<string>();
  const peers: { userId: string; userName: string }[] = [];
  for (const r of rows) {
    if (seen.has(r.userId)) continue;
    seen.add(r.userId);
    peers.push({ userId: r.userId, userName: r.userName });
  }
  return { count: peers.length, peers };
}

/**
 * The current user's open entry, if any. Used by the topbar widget.
 *
 * `deletedAt: null` IS THE READ HALF OF THE TOMBSTONE, and its absence was the
 * sharpest version of the gap prisma/schema.prisma warns about on
 * `TimeEntry.deletedAt`. `deleteTimeEntryAction` soft-deletes, and
 * `clockInAction` already filters `deletedAt: null` when it checks for an
 * existing open entry — so a user who deleted their own RUNNING timer got a
 * topbar pill ticking a row `findLiveEntry` then refuses to close ("Entry not
 * found"), while clock-in cheerfully started another. The read and the write
 * disagreed about whether the session existed.
 */
export async function getOpenEntry(): Promise<TimeEntryClient | null> {
  const { userId } = await requireScopedSession();
  const row = await db.timeEntry.findFirst({
    where: { userId, clockOutAt: null, deletedAt: null },
    orderBy: { clockInAt: "desc" },
  });
  return row ? toClient(row) : null;
}

export type EntryScope = "mine" | "team";

/**
 * Hard ceiling on one /time read. A page cannot lift it.
 *
 * Unchanged in size from the `take: 500` it replaces. What changed is that the
 * caller is now TOLD when it bit, because the cap itself was never the bug
 * (time-010): the /time client computed the "Total tracked" sum, the "N sessions"
 * label and the whole Week grid in memory from this array, so past 500 entries —
 * one workday each for one person for two years, or three months for a team of
 * eight — the label stopped being a count of sessions and paging the Week view
 * back rendered "No entries / 0m" for weeks that are populated in the database.
 * Empty cells for real work read as lost data, which is the worst thing a
 * timesheet can say.
 */
const MAX_ENTRY_PAGE = 500;

export interface EntryPage {
  entries: TimeEntryClient[];
  /** True when more entries exist older than the ones returned. */
  truncated: boolean;
  /**
   * `clockInAt` (ISO) of the OLDEST entry in `entries`, or null when nothing was
   * truncated. It is the honest horizon of the loaded window: the Week view uses
   * it to say "weeks before this aren't loaded" rather than drawing seven empty
   * cells for a week it simply did not fetch.
   */
  oldestLoadedAt: string | null;
}

/**
 * Lists entries for the /time page. Defaults to the current user's entries;
 * passing scope: "team" returns the whole company — but ONLY if the caller
 * has the cofounder/admin role. Members get their own entries either way
 * (no silent privilege escalation).
 *
 * `take: MAX_ENTRY_PAGE + 1` is the has-more probe — the pattern `getTaskPage`
 * documents in lib/queries/tasks.ts: one extra row is cheaper than a second
 * `count()` and cannot disagree with the page it describes. The probe row is
 * sliced off and never reaches the client.
 *
 * WHAT THIS DOES NOT CLOSE, stated so it is not read as closing time-010. The
 * totals are still computed client-side over this window, so /time's lifetime
 * "Total tracked" and /settings's (lib/queries/stats.ts, an uncapped SQL sum) can
 * still disagree for a customer past the cap — /time now says which window it is
 * describing instead of claiming a total, which removes the contradiction without
 * removing the difference. An exact figure needs an aggregate here AND the same
 * treatment in stats.ts, which also has to gain `deletedAt IS NULL` and the
 * open-entry cap; the two have to land together or the disagreement just changes
 * direction.
 */
export async function getEntries(scope: EntryScope = "mine"): Promise<EntryPage> {
  const { userId, companyId, role } = await requireScopedSession();

  const wantsTeam = scope === "team" && canEditEntryTimes(role);
  const rows = await db.timeEntry.findMany({
    // `deletedAt: null`: a tombstoned entry was still listed AND still summed
    // into every figure on the page, which is what the schema comment means by
    // "a tombstone nobody filters on does not hide a row, it duplicates it".
    where: { ...(wantsTeam ? { companyId } : { userId }), deletedAt: null },
    orderBy: { clockInAt: "desc" },
    take: MAX_ENTRY_PAGE + 1,
  });
  const truncated = rows.length > MAX_ENTRY_PAGE;
  const page = truncated ? rows.slice(0, MAX_ENTRY_PAGE) : rows;
  const entries = page.map(toClient);
  return {
    entries,
    truncated,
    oldestLoadedAt: truncated && entries.length > 0 ? entries[entries.length - 1].clockInAt : null,
  };
}
