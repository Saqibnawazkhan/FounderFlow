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
    where: { companyId, clockOutAt: null },
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

/** The current user's open entry, if any. Used by the topbar widget. */
export async function getOpenEntry(): Promise<TimeEntryClient | null> {
  const { userId } = await requireScopedSession();
  const row = await db.timeEntry.findFirst({
    where: { userId, clockOutAt: null },
    orderBy: { clockInAt: "desc" },
  });
  return row ? toClient(row) : null;
}

export type EntryScope = "mine" | "team";

/**
 * Lists entries for the /time page. Defaults to the current user's entries;
 * passing scope: "team" returns the whole company — but ONLY if the caller
 * has the cofounder/admin role. Members get their own entries either way
 * (no silent privilege escalation).
 */
export async function getEntries(scope: EntryScope = "mine"): Promise<TimeEntryClient[]> {
  const { userId, companyId, role } = await requireScopedSession();

  const wantsTeam = scope === "team" && canEditEntryTimes(role);
  const rows = await db.timeEntry.findMany({
    where: wantsTeam ? { companyId } : { userId },
    orderBy: { clockInAt: "desc" },
    take: 500, // bounded — the page also paginates client-side
  });
  return rows.map(toClient);
}
