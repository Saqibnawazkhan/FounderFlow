"use server";

/**
 * Time-tracking server actions.
 *
 * Permissions
 *   • Member: clockIn, clockOut, heartbeat, delete own entries.
 *   • Cofounder/Admin: above + updateTimeEntryAction (manual time edit on
 *     any entry, with editedBy/editedAt audit trail).
 *
 * "Only one open entry per user" is enforced server-side — clockIn refuses
 * if you already have a row with clockOutAt = null. The UI keeps you out
 * of trouble too, but a forged request can't bypass it.
 */

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  ClockInSchema,
  ClockOutSchema,
  CreateManualEntrySchema,
  HeartbeatSchema,
  UpdateTimeEntrySchema,
} from "@/lib/schemas/time";
import { limiters } from "@/lib/rate-limit";
import { canEditEntryTimes, AUTO_CLOSE_MS } from "@/lib/time/thresholds";
import { captureServerError } from "@/lib/sentry-server";
import { getOpenEntry, type TimeEntryClient } from "@/lib/queries/time";

export type ActionResult<T = void> = { success: true; data: T } | { success: false; error: string };

/**
 * Thin RSC-bypassing wrapper: the topbar widget is a client component and
 * needs to know on mount whether the user is currently clocked in. Same
 * permission scope as the underlying query (current user, current company).
 */
export async function getOpenEntryAction(): Promise<
  ActionResult<{
    openEntry: TimeEntryClient | null;
    tasks: { id: string; title: string }[];
  }>
> {
  const session = await auth();
  if (!session?.user?.companyId || !session.user.id) {
    return { success: false, error: "Not authenticated" };
  }
  try {
    const [openEntry, tasks] = await Promise.all([
      getOpenEntry(),
      db.task.findMany({
        where: {
          companyId: session.user.companyId,
          status: { not: "completed" },
        },
        select: { id: true, title: true },
        orderBy: { createdAt: "desc" },
        take: 100,
      }),
    ]);
    return { success: true, data: { openEntry, tasks } };
  } catch (e) {
    captureServerError(e, { action: "getOpenEntryAction" });
    return { success: false, error: "Couldn't load time tracker state." };
  }
}

export async function clockInAction(input: unknown): Promise<ActionResult<{ entryId: string }>> {
  const session = await auth();
  if (!session?.user?.companyId || !session.user.id) {
    return { success: false, error: "Not authenticated" };
  }
  const gate = limiters.write.consume(session.user.id);
  if (!gate.allowed) return { success: false, error: gate.error ?? "Too many requests" };

  const parsed = ClockInSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid clock-in" };
  }
  const { taskId, note } = parsed.data;
  const { id: userId, companyId } = session.user;

  try {
    // One open entry max. If the user is already clocked in, surface that
    // instead of creating a parallel row.
    const existing = await db.timeEntry.findFirst({
      where: { userId, clockOutAt: null },
    });
    if (existing) {
      return { success: false, error: "You're already clocked in." };
    }

    // Snapshot the task title at clock-in so a later rename / delete doesn't
    // turn the entry into a "Untitled" row in reports.
    let taskTitle: string | null = null;
    if (taskId) {
      const task = await db.task.findUnique({
        where: { id: taskId },
        select: { companyId: true, title: true },
      });
      if (!task || task.companyId !== companyId) {
        return { success: false, error: "Task not found" };
      }
      taskTitle = task.title;
    }

    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user) return { success: false, error: "User no longer exists" };

    const created = await db.timeEntry.create({
      data: {
        companyId,
        userId,
        userName: user.name,
        taskId: taskId ?? null,
        taskTitle,
        note: note ?? null,
      },
    });

    revalidatePath("/time");
    return { success: true, data: { entryId: created.id } };
  } catch (e) {
    captureServerError(e, { action: "clockInAction" });
    return { success: false, error: "Couldn't clock in right now." };
  }
}

/**
 * Manual/backdated entry (X1). Creates a COMPLETED entry for the current
 * user — always self-scoped (no userId in the input), so a member can log
 * their own forgotten sessions without any elevated permission. The schema
 * guarantees clock-out > clock-in and neither end is in the future.
 */
export async function createManualEntryAction(
  input: unknown
): Promise<ActionResult<{ entryId: string }>> {
  const session = await auth();
  if (!session?.user?.companyId || !session.user.id) {
    return { success: false, error: "Not authenticated" };
  }
  const gate = limiters.write.consume(session.user.id);
  if (!gate.allowed) return { success: false, error: gate.error ?? "Too many requests" };

  const parsed = CreateManualEntrySchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid entry" };
  }
  const { clockInAt, clockOutAt, taskId, note } = parsed.data;
  const { id: userId, companyId } = session.user;

  try {
    // Snapshot the task title so a later rename/delete doesn't strand the row.
    let taskTitle: string | null = null;
    if (taskId) {
      const task = await db.task.findUnique({
        where: { id: taskId },
        select: { companyId: true, title: true },
      });
      if (!task || task.companyId !== companyId) {
        return { success: false, error: "Task not found" };
      }
      taskTitle = task.title;
    }

    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user) return { success: false, error: "User no longer exists" };

    const created = await db.timeEntry.create({
      data: {
        companyId,
        userId,
        userName: user.name,
        taskId: taskId ?? null,
        taskTitle,
        note: note ?? null,
        clockInAt,
        clockOutAt,
        // lastActivityAt is only meaningful for the idle-sweep of *open*
        // entries; a completed manual row pins it to clock-out so it can
        // never trip the sweeper.
        lastActivityAt: clockOutAt,
      },
    });

    revalidatePath("/time");
    return { success: true, data: { entryId: created.id } };
  } catch (e) {
    captureServerError(e, { action: "createManualEntryAction" });
    return { success: false, error: "Couldn't log that entry right now." };
  }
}

/** Internal helper — owns the close + revalidate path. */
async function closeEntry(opts: {
  entryId: string;
  clockOutAt: Date;
  note?: string;
  autoClosed: boolean;
}) {
  await db.timeEntry.update({
    where: { id: opts.entryId },
    data: {
      clockOutAt: opts.clockOutAt,
      note: opts.note ?? undefined,
      autoClosed: opts.autoClosed,
    },
  });
  revalidatePath("/time");
}

export async function clockOutAction(input: unknown): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.companyId || !session.user.id) {
    return { success: false, error: "Not authenticated" };
  }

  const parsed = ClockOutSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: "Invalid clock-out" };
  const { entryId, note } = parsed.data;

  try {
    const entry = await db.timeEntry.findUnique({ where: { id: entryId } });
    if (!entry) return { success: false, error: "Entry not found" };
    if (entry.userId !== session.user.id) return { success: false, error: "Not authorized" };
    if (entry.clockOutAt) return { success: false, error: "Already clocked out" };

    await closeEntry({
      entryId,
      clockOutAt: new Date(),
      note,
      autoClosed: false,
    });
    return { success: true, data: undefined };
  } catch (e) {
    captureServerError(e, { action: "clockOutAction" });
    return { success: false, error: "Couldn't clock out right now." };
  }
}

/**
 * Client idle-trigger close: the modal stayed unanswered for 30 min, so
 * we record clockOutAt = lastActivityAt to avoid crediting AFK time.
 * Owner-only (same as clockOutAction).
 */
export async function autoCloseEntryAction(input: unknown): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Not authenticated" };

  const parsed = HeartbeatSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: "Invalid request" };

  try {
    const entry = await db.timeEntry.findUnique({ where: { id: parsed.data.entryId } });
    if (!entry) return { success: false, error: "Entry not found" };
    if (entry.userId !== session.user.id) return { success: false, error: "Not authorized" };
    if (entry.clockOutAt) return { success: true, data: undefined }; // idempotent

    await closeEntry({
      entryId: entry.id,
      clockOutAt: entry.lastActivityAt,
      autoClosed: true,
    });
    return { success: true, data: undefined };
  } catch (e) {
    captureServerError(e, { action: "autoCloseEntryAction" });
    return { success: false, error: "Couldn't auto-close right now." };
  }
}

/**
 * Bump lastActivityAt to now(). The client calls this every 5 min while
 * the entry is open AND on user response to the still-working modal.
 * Idempotent + cheap — no rate limit (heartbeat by design).
 */
export async function heartbeatAction(input: unknown): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Not authenticated" };

  const parsed = HeartbeatSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: "Invalid request" };

  try {
    const entry = await db.timeEntry.findUnique({ where: { id: parsed.data.entryId } });
    if (!entry) return { success: false, error: "Entry not found" };
    if (entry.userId !== session.user.id) return { success: false, error: "Not authorized" };
    if (entry.clockOutAt) return { success: false, error: "Entry already closed" };

    await db.timeEntry.update({
      where: { id: entry.id },
      data: { lastActivityAt: new Date() },
    });
    return { success: true, data: undefined };
  } catch (e) {
    captureServerError(e, { action: "heartbeatAction" });
    return { success: false, error: "Heartbeat failed" };
  }
}

export async function deleteTimeEntryAction(entryId: string): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.companyId || !session.user.id) {
    return { success: false, error: "Not authenticated" };
  }
  if (!entryId) return { success: false, error: "Missing entry id" };

  try {
    const entry = await db.timeEntry.findUnique({ where: { id: entryId } });
    if (!entry) return { success: false, error: "Entry not found" };
    if (entry.companyId !== session.user.companyId) {
      return { success: false, error: "Not authorized" };
    }
    // Owner OR admin/cofounder can delete.
    if (entry.userId !== session.user.id && !canEditEntryTimes(session.user.role)) {
      return { success: false, error: "Only the owner or a founder can delete this entry" };
    }
    await db.timeEntry.delete({ where: { id: entryId } });
    revalidatePath("/time");
    return { success: true, data: undefined };
  } catch (e) {
    captureServerError(e, { action: "deleteTimeEntryAction" });
    return { success: false, error: "Couldn't delete the entry right now." };
  }
}

/** Admin/cofounder-only manual edit. Members are blocked here even on a
 *  forged request. */
export async function updateTimeEntryAction(input: unknown): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.companyId || !session.user.id) {
    return { success: false, error: "Not authenticated" };
  }
  if (!canEditEntryTimes(session.user.role)) {
    return { success: false, error: "Only a founder/cofounder can edit times" };
  }

  const parsed = UpdateTimeEntrySchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid update" };
  }
  const { entryId, clockInAt, clockOutAt, taskId, note } = parsed.data;

  try {
    const entry = await db.timeEntry.findUnique({ where: { id: entryId } });
    if (!entry) return { success: false, error: "Entry not found" };
    if (entry.companyId !== session.user.companyId) {
      return { success: false, error: "Not authorized" };
    }

    let nextTaskId: string | null | undefined = undefined;
    let nextTaskTitle: string | null | undefined = undefined;
    if (taskId === null) {
      nextTaskId = null;
      nextTaskTitle = null;
    } else if (taskId) {
      const task = await db.task.findUnique({
        where: { id: taskId },
        select: { companyId: true, title: true },
      });
      if (!task || task.companyId !== session.user.companyId) {
        return { success: false, error: "Task not found" };
      }
      nextTaskId = taskId;
      nextTaskTitle = task.title;
    }

    const editor = await db.user.findUnique({ where: { id: session.user.id } });
    if (!editor) return { success: false, error: "User no longer exists" };

    await db.timeEntry.update({
      where: { id: entryId },
      data: {
        clockInAt,
        clockOutAt: clockOutAt ?? null,
        taskId: nextTaskId,
        taskTitle: nextTaskTitle,
        note: note ?? undefined,
        editedBy: editor.id,
        editedByName: editor.name,
        editedAt: new Date(),
      },
    });
    revalidatePath("/time");
    return { success: true, data: undefined };
  } catch (e) {
    captureServerError(e, { action: "updateTimeEntryAction" });
    return { success: false, error: "Couldn't update the entry right now." };
  }
}

export interface SweepResult {
  attempted: number;
  closed: string[];
  failed: { id: string; error: string }[];
}

/**
 * Cron handler — runs daily (see vercel.json). Closes any open entry that
 * hasn't heartbeat-ed in AUTO_CLOSE_MS.
 *
 * Returns a detailed result instead of a count so the cron endpoint can:
 *   • respond 206 Partial Content if some entries fail (Vercel cron monitor
 *     will only alert on 5xx, but 206 still surfaces in dashboards)
 *   • log per-entry failures to Sentry with the entry id so triage isn't
 *     "something failed somewhere"
 *
 * Each entry is closed in its own update — NOT a single $transaction —
 * because one stuck row shouldn't block sweeping the other 99.
 */
export async function sweepAutoCloseEntries(): Promise<SweepResult> {
  const cutoff = new Date(Date.now() - AUTO_CLOSE_MS);
  const stale = await db.timeEntry.findMany({
    where: { clockOutAt: null, lastActivityAt: { lt: cutoff } },
    select: { id: true, lastActivityAt: true, userId: true, companyId: true },
  });
  if (stale.length === 0) return { attempted: 0, closed: [], failed: [] };

  const closed: string[] = [];
  const failed: { id: string; error: string }[] = [];
  for (const s of stale) {
    try {
      await db.timeEntry.update({
        where: { id: s.id },
        data: { clockOutAt: s.lastActivityAt, autoClosed: true },
      });
      closed.push(s.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown sweep error";
      failed.push({ id: s.id, error: msg });
      captureServerError(e, {
        action: "sweepAutoCloseEntries:entry",
        extra: { entryId: s.id, userId: s.userId, companyId: s.companyId },
      });
    }
  }
  return { attempted: stale.length, closed, failed };
}
