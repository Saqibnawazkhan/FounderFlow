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
import { canEditEntryTimes } from "@/lib/time/thresholds";
import { captureServerError } from "@/lib/sentry-server";
import { getOpenEntry, type TimeEntryClient } from "@/lib/queries/time";

import type { ActionResult } from "@/lib/actions/types";

/**
 * Thin RSC-bypassing wrapper: the topbar widget is a client component and
 * needs to know on mount whether the user is currently clocked in. Same
 * permission scope as the underlying query (current user, current company).
 *
 * THE TASK LIST IT ALSO RETURNS IS A TASK LIST, AND OBEYS THE BOARD'S RULE.
 * Finding tasks-and-comments-006.
 *
 * It used to read `{ companyId, status: { not: "completed" } }` — no
 * `assignedTo`, no `deletedAt: null`, no role branch — and the result is
 * rendered as one `<option>` per task in the clock-in modal, which
 * `<ClockWidget />` mounts in the top bar for every role on every app route a
 * member can reach. lib/queries/tasks.ts:75-81 states the boundary it was
 * bypassing: "On the GLOBAL board a member only ever sees tasks assigned to
 * THEM — never a teammate's, admin's, or co-founder's work. Enforced here at
 * the data boundary so it can't be unfiltered from the client." The one place
 * the product promises a member cannot see other people's work was therefore
 * readable from a control on every screen, and task titles here are things like
 * "Terminate Ahmed's contract".
 *
 * The filter below mirrors `getTasks()`'s global-board clause deliberately,
 * the same way lib/queries/search.ts mirrors it for the command palette: the
 * picker's destination is a time entry that shows up on the board, so offering
 * a task the board will not render is a dead option. It is written out rather
 * than delegated to `getTasks()` because that query is uncapped and joins
 * comment counts and project names the picker has no use for; the cost of the
 * duplication is this comment.
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
          deletedAt: null,
          status: { not: "completed" },
          // Same as the global board: a completed or shelved project's tasks
          // are not on it, so they are not clock-in targets either.
          project: { status: { notIn: ["completed", "archived"] } },
          // And the member scope, which is the finding.
          ...(session.user.role === "member" ? { assignedTo: session.user.id } : {}),
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

/**
 * The daily auto-close sweeper used to live here, as
 * `export async function sweepAutoCloseEntries()`. It now lives in
 * `lib/time/sweep.ts` and the cron route imports it from there.
 *
 * WHY (audit finding cron-001): this file is `"use server"` and it is in the
 * client graph — four client components import actions from it. Next.js gives
 * EVERY export of such a module a callable, publicly-routable Server Action id,
 * whether or not a component calls it. The sweeper is a cron body: no `auth()`,
 * no role check, no rate limit, and a global `where` with no `companyId`
 * filter. Sitting in this file, it was an unauthenticated POST endpoint that
 * ended every running timer in every customer workspace.
 *
 * So: do NOT move it back and bolt an `auth()` call onto it. A cron request has
 * no user session, so that gate would break the nightly job rather than secure
 * it. Keeping the function out of this module is the fix. Anything new added to
 * this file must be a genuinely user-invocable action that authenticates
 * itself — a helper belongs in a plain server module.
 */
