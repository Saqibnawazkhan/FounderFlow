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
import { canEditEntryTimes, MAX_MANUAL_ENTRY_MS } from "@/lib/time/thresholds";
import { captureServerError } from "@/lib/sentry-server";
import { getOpenEntry, type TimeEntryClient } from "@/lib/queries/time";

import type { ActionResult } from "@/lib/actions/types";

/**
 * How many `<option>`s the topbar clock-in picker loads (time-013).
 *
 * NOT EXPORTED, and it cannot be: this module is `"use server"`, where Next
 * requires every export to be an async function and turns each one into a
 * publicly-routable action id. The widget learns about the ceiling from the
 * `tasksTruncated` flag in the payload instead of importing the number.
 *
 * It stays at 100 rather than rising to the /time picker's `MAX_TASK_OPTIONS`
 * (500) because `<ClockWidget>` mounts in the topbar of EVERY app route, so this
 * list is on the critical path of every page view while the /time modals' list is
 * fetched once per visit to one page.
 *
 * A ceiling is legitimate. A ceiling nobody is told about is the finding: with
 * `orderBy: createdAt desc` the tasks that fall off the bottom are the
 * long-lived ones, which are exactly the tasks people track the most time
 * against, so their hours quietly landed as untagged work. Reporting the
 * truncation makes the limit visible; making the 101st task REACHABLE needs a
 * searchable combobox backed by a `title contains` query, which is a feature and
 * is recorded rather than built here.
 */
const PICKER_LIMIT = 100;

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
    /** True when open tasks exist beyond the ones returned. See PICKER_LIMIT. */
    tasksTruncated: boolean;
  }>
> {
  const session = await auth();
  if (!session?.user?.companyId || !session.user.id) {
    return { success: false, error: "Not authenticated" };
  }
  try {
    const [openEntry, rows] = await Promise.all([
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
        // `+ 1` is the has-more probe, the same pattern `getTaskPage` documents:
        // one extra row is cheaper than a second `count()`, and this widget mounts
        // on every route, so an extra aggregate per page view is not free. The
        // probe row is sliced off below and never reaches the client.
        take: PICKER_LIMIT + 1,
      }),
    ]);
    const tasksTruncated = rows.length > PICKER_LIMIT;
    return {
      success: true,
      data: {
        openEntry,
        tasks: tasksTruncated ? rows.slice(0, PICKER_LIMIT) : rows,
        tasksTruncated,
      },
    };
  } catch (e) {
    captureServerError(e, { action: "getOpenEntryAction" });
    return { success: false, error: "Couldn't load time tracker state." };
  }
}

/**
 * The one task lookup the three write paths share, and the one place the tag a
 * TimeEntry carries is decided.
 *
 * Returns `null` for an id that is not a live task of this company — so a
 * tombstoned task answers exactly as an id that never existed (time-003).
 * `clockInAction` had this right after data-integrity-012; the manual-entry and
 * admin-edit paths were still `findUnique({ where: { id } })` followed by a
 * `task.companyId === companyId` comparison afterwards, which a soft-deleted task
 * walks straight through — and its title was then frozen onto a brand-new row
 * that an hours-based invoice is built from.
 *
 * It also answers the PROJECT (time-004). `TimeEntry.projectId` / `projectName`
 * and the `[projectId, clockInAt]` index have existed since
 * 20260526151502_add_projects, and no writer ever set either, so every "Hours
 * tracked" figure on /projects read 0m for ever: lib/queries/projects.ts rolls up
 * with `projectId: { in: projectIds }` and there was nothing to match. The demo
 * workspace hid it — prisma/seed.ts creates no TimeEntry rows at all.
 *
 * `projectName` is a snapshot, like `taskTitle` beside it, so a later rename or
 * delete leaves the historical row readable instead of blank.
 *
 * Not exported: this module is `"use server"`, so every export is a publicly
 * routable Server Action id (see the note at the foot of this file about
 * cron-001).
 */
type TaskTag = { taskTitle: string; projectId: string | null; projectName: string | null };

async function findTaskTag(taskId: string, companyId: string): Promise<TaskTag | null> {
  const task = await db.task.findFirst({
    where: { id: taskId, companyId, deletedAt: null },
    select: { title: true, project: { select: { id: true, name: true } } },
  });
  if (!task) return null;
  return {
    taskTitle: task.title,
    projectId: task.project?.id ?? null,
    projectName: task.project?.name ?? null,
  };
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
    //
    // `deletedAt: null` IS LOAD-BEARING, and it is the sharpest edge of
    // data-integrity-001. `deleteTimeEntryAction` now tombstones instead of
    // hard-deleting, so without this filter a user who deleted their own RUNNING
    // timer would match here for the rest of time: every future clock-in refused
    // with "You're already clocked in.", and no entry anywhere in the UI to
    // clock out of, because every read filters the tombstone out. The soft
    // delete would have created a permanent lockout that the hard delete did
    // not have.
    const existing = await db.timeEntry.findFirst({
      where: { userId, clockOutAt: null, deletedAt: null },
    });
    if (existing) {
      return { success: false, error: "You're already clocked in." };
    }

    /*
     * …AND NOT INSIDE HOURS ALREADY LOGGED. The check above asks only whether
     * another entry is OPEN, which is a different question: hand-log 09:00-12:00,
     * then clock in live at 10:00, and both rows stand. Every total counts that
     * hour twice, and an hours-based invoice is the one place this product cannot
     * be approximately right.
     *
     * time-005 added the probe to `createManualEntryAction` alone, so the product
     * refused the overlap you typed and accepted the identical overlap you clocked
     * — an inconsistent rule, which teaches the user the wrong thing and then
     * contradicts it. The start instant is `now`, and the session is open, so the
     * probe asks "does anything live still cover this moment?".
     */
    const covering = await findOverlappingEntry({
      userId,
      clockInAt: new Date(),
      clockOutAt: null,
    });
    if (covering) return { success: false, error: OVERLAP_ERROR };

    // Snapshot the task title + project at clock-in so a later rename / delete
    // doesn't turn the entry into an "Untitled" row in reports, and so the hours
    // roll up on /projects. `findTaskTag` carries data-integrity-012's tombstone
    // and tenant filters inside the predicate; see its docstring.
    let tag: TaskTag | null = null;
    if (taskId) {
      tag = await findTaskTag(taskId, companyId);
      if (!tag) {
        return { success: false, error: "Task not found" };
      }
    }

    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user) return { success: false, error: "User no longer exists" };

    const created = await db.timeEntry.create({
      data: {
        companyId,
        userId,
        userName: user.name,
        taskId: taskId ?? null,
        taskTitle: tag?.taskTitle ?? null,
        projectId: tag?.projectId ?? null,
        projectName: tag?.projectName ?? null,
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
    /* NO OVERLAPPING SESSIONS (time-005, the half a schema cannot see).
     *
     * `CreateManualEntrySchema` now caps one entry at MAX_MANUAL_ENTRY_MS, but a
     * length bound does nothing about the cheaper version of the same problem:
     * log 09:00–12:00, then 10:00–13:00 for a different task, and the overlapping
     * two hours are counted twice in /settings "Total tracked", the /time KPI and
     * every project rollup. That needs no malice — two tasks, one afternoon — and
     * this action is ungated by role on purpose, so the workspace's
     * lowest-privilege user owns the number either way.
     *
     * The predicate is the standard half-open interval overlap: an existing row
     * starts before this one ends AND ends after this one starts, where a still
     * OPEN row (clockOutAt null) counts as running to infinity. Written this way
     * rather than as `NOT (before OR after)` because Prisma renders the positive
     * form into an index-usable clause on `[userId, clockInAt]`.
     *
     * `deletedAt: null` is load-bearing: `deleteTimeEntryAction` tombstones
     * (data-integrity-001), so without it a user who deleted a mistaken entry
     * could never re-log those hours correctly — the deleted row would block the
     * replacement for ever, from no surface they can see.
     *
     * Back-to-back sessions are legal. The bounds are strict (`lt` / `gt`), so
     * 12:00–13:00 against 09:00–12:00 passes.
     */
    const overlap = await findOverlappingEntry({ userId, clockInAt, clockOutAt });
    if (overlap) return { success: false, error: OVERLAP_ERROR };

    // Snapshot the task title + project so a later rename/delete doesn't strand
    // the row, and so /projects can roll the hours up. See `findTaskTag`.
    let tag: TaskTag | null = null;
    if (taskId) {
      tag = await findTaskTag(taskId, companyId);
      if (!tag) {
        return { success: false, error: "Task not found" };
      }
    }

    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user) return { success: false, error: "User no longer exists" };

    const created = await db.timeEntry.create({
      data: {
        companyId,
        userId,
        userName: user.name,
        taskId: taskId ?? null,
        taskTitle: tag?.taskTitle ?? null,
        projectId: tag?.projectId ?? null,
        projectName: tag?.projectName ?? null,
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

/**
 * One lookup, one rule: a tombstoned entry is GONE to every writer in this file,
 * and answers exactly as an id that never existed does (data-integrity-001).
 *
 * Not exported, and must not be: this module is `"use server"`, so an export is
 * a publicly-routable endpoint (see the note at the foot of this file about
 * cron-001). A plain helper is the right shape.
 *
 * Why a branch rather than a `where` clause: Prisma's `findUnique` accepts only
 * unique fields in its filter, so `deletedAt: null` cannot be added to it, and
 * switching to `findFirst` on every caller would change five query shapes to
 * express one boolean. Written once here because five hand-copied
 * `entry.deletedAt` checks is five chances to forget the sixth.
 *
 * `closeEntry` below deliberately has no check of its own — both its callers go
 * through this function first, and a second lookup inside a helper that already
 * holds the row would just be a slower way to ask the same question.
 */
async function findLiveEntry(entryId: string) {
  const entry = await db.timeEntry.findUnique({ where: { id: entryId } });
  return entry && entry.deletedAt === null ? entry : null;
}

/**
 * Internal helper — owns the close + revalidate path.
 *
 * Returns TRUE only if this call is the one that closed the entry.
 *
 * data-integrity-006. This was `db.timeEntry.update({ where: { id } })` — the id
 * and nothing else — behind a separate `if (entry.clockOutAt)` read in each
 * caller. Two statements with no condition on the write, so the guard held for a
 * person clicking once and did nothing for two requests that interleave between
 * the read and the update: a double-click, a second tab, or the idle-modal
 * auto-close landing at the same moment as the button. The later write won, so
 * `clockOutAt` moved forward and the tracked duration grew — and on the
 * auto-close path it also set `autoClosed: true`, putting "the system ended this
 * because you went away" on a session the person ended deliberately. That column
 * is what an hours-based invoice is defended with.
 *
 * `updateMany` with the guard IN the `where` makes the check and the write one
 * statement, which is the only version of this that is correct under
 * concurrency. `count === 0` means somebody else got there first, and the two
 * callers deliberately want opposite things with that: the person pressing the
 * button is told, the background auto-close stays idempotent.
 *
 * `deletedAt: null` belongs in the condition too — `deleteTimeEntryAction`
 * tombstones rather than hard-deletes (data-integrity-001), so the row is still
 * physically there for an update to land on.
 *
 * The mirror race in `clockInAction` is NOT fixed by this and cannot be fixed
 * from application code: two interleaved requests both see no open entry and both
 * insert, and there is no row to lock at READ COMMITTED. It needs
 * `CREATE UNIQUE INDEX "TimeEntry_one_open_per_user" ON "TimeEntry"("userId")
 * WHERE "clockOutAt" IS NULL` in a hand-written migration — Prisma has no syntax
 * for a partial unique index, the same situation as Message's GIN index — plus a
 * P2002 catch there. Recorded, not done here.
 */
async function closeEntry(opts: {
  entryId: string;
  clockOutAt: Date;
  note?: string;
  autoClosed: boolean;
}): Promise<boolean> {
  const { count } = await db.timeEntry.updateMany({
    where: { id: opts.entryId, clockOutAt: null, deletedAt: null },
    data: {
      clockOutAt: opts.clockOutAt,
      note: opts.note ?? undefined,
      autoClosed: opts.autoClosed,
    },
  });
  if (count === 0) return false;
  revalidatePath("/time");
  return true;
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
    const entry = await findLiveEntry(entryId);
    if (!entry) return { success: false, error: "Entry not found" };
    if (entry.userId !== session.user.id) return { success: false, error: "Not authorized" };
    if (entry.clockOutAt) return { success: false, error: "Already clocked out" };

    const closed = await closeEntry({
      entryId,
      clockOutAt: new Date(),
      note,
      autoClosed: false,
    });
    // The read above already answered this for the sequential case; this is the
    // interleaved one, and it is the only answer that cannot be raced.
    if (!closed) return { success: false, error: "Already clocked out" };
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
    const entry = await findLiveEntry(parsed.data.entryId);
    if (!entry) return { success: false, error: "Entry not found" };
    if (entry.userId !== session.user.id) return { success: false, error: "Not authorized" };
    if (entry.clockOutAt) return { success: true, data: undefined }; // idempotent

    // Deliberately idempotent, unlike clockOutAction: a background timer whose
    // job is already done is not an error, and `count === 0` here means the user
    // closed the entry themselves — in which case NOT writing is the whole point,
    // because the write would relabel their session `autoClosed`.
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
 *
 * IT IS ALSO THE ELAPSED-TIME BOUND (time-015), and it is the only place that
 * bound can live. Auto-close is driven by IDLE time: `entryState` reads
 * `lastActivityAt`, and so does the nightly sweep. `<ClockWidget>` heartbeats
 * every HEARTBEAT_MS whenever `document.hidden` is false, so a tab parked on a
 * second monitor refreshes `lastActivityAt` for ever — the entry never goes idle,
 * never warns, and is never swept. A timer started Friday afternoon was still
 * counting on Monday and read 70h+, summed into /time "Total tracked", /settings
 * and `getClockedInPeers`, with no ⏱ marker anywhere saying the figure was junk.
 * Every other path is bounded already: a hidden tab stops heartbeating and the
 * sweep takes it; only the VISIBLE tab was unbounded, and this is the request the
 * visible tab makes.
 *
 * So a heartbeat on an entry that has been open for MAX_MANUAL_ENTRY_MS closes it
 * at `clockInAt + MAX_MANUAL_ENTRY_MS` — the ceiling this product already applies
 * to a hand-logged session, and the looser of the two on purpose, because a
 * heartbeat is evidence somebody is THERE and the idle horizon is the wrong
 * question to ask them. It marks the row `autoClosed` so the badge warns someone,
 * and reports failure. `lastActivityAt` is deliberately NOT bumped: the whole point is to stop
 * extending the entry's life.
 *
 * `clockOutAction` is deliberately NOT clamped the same way. Closing by hand
 * records the moment the person chose, and overwriting it with a computed cap is
 * the exact harm of data-integrity-007 — a clock-out at a time nobody picked,
 * contradicting the customer on an hours-based invoice. Prevention belongs here,
 * where the entry is still running.
 */
/** The one sentence every path that can manufacture an overlap returns. */
const OVERLAP_ERROR = "Those hours overlap a session you've already logged.";

/**
 * A live entry of this user's that intersects `[clockInAt, clockOutAt)`.
 *
 * ONE PROBE FOR ALL THREE WRITE PATHS, and it was one for a while. time-005 put
 * it in `createManualEntryAction` only, so the product refused an overlap you
 * typed and accepted the identical overlap by two other routes: clocking in live
 * at 10:00 when 09:00-12:00 is already logged (`clockInAction` checks only that
 * no OTHER entry is open), and an admin dragging somebody else's entry across a
 * session they already have (`updateTimeEntryAction`). An hours-based invoice
 * double-counts either way, and the refusal being inconsistent is worse than the
 * refusal being absent — a user who learns the rule from one screen is then told
 * the opposite by another.
 *
 * `deletedAt: null` is load-bearing and not a habit: `deleteTimeEntryAction`
 * tombstones (data-integrity-001), so without it a user who deleted a mistaken
 * entry could never re-log those hours — blocked for ever by a row on no surface
 * they can open. That is the same lockout shape `clockInAction`'s own filter
 * exists to prevent, and the audit's suggested query omitted it.
 *
 * `excludeEntryId` is for the edit path: a row must not collide with itself.
 *
 * Bounds are STRICT (`lt` / `gt`), so back-to-back sessions are legal —
 * 12:00-13:00 against 09:00-12:00 passes. An OPEN entry is treated as running to
 * infinity, which is what `clockOutAt: null` means.
 */
async function findOverlappingEntry(args: {
  userId: string;
  clockInAt: Date;
  /** `null` for a session still running — it intersects anything after its start. */
  clockOutAt: Date | null;
  excludeEntryId?: string;
}): Promise<{ id: string } | null> {
  const { userId, clockInAt, clockOutAt, excludeEntryId } = args;
  return db.timeEntry.findFirst({
    where: {
      userId,
      deletedAt: null,
      ...(excludeEntryId ? { id: { not: excludeEntryId } } : {}),
      ...(clockOutAt ? { clockInAt: { lt: clockOutAt } } : {}),
      OR: [{ clockOutAt: null }, { clockOutAt: { gt: clockInAt } }],
    },
    select: { id: true },
  });
}

export async function heartbeatAction(input: unknown): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Not authenticated" };

  const parsed = HeartbeatSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: "Invalid request" };

  try {
    const entry = await findLiveEntry(parsed.data.entryId);
    if (!entry) return { success: false, error: "Entry not found" };
    if (entry.userId !== session.user.id) return { success: false, error: "Not authorized" };
    if (entry.clockOutAt) return { success: false, error: "Entry already closed" };

    /*
     * THE CEILING HERE IS THE MANUAL-ENTRY ONE, NOT THE IDLE ONE, and the
     * difference is hours out of somebody's timesheet.
     *
     * This closed at `AUTO_CLOSE_MS` (12.5h) — the IDLE horizon, which is the
     * right number for the nightly sweep because the sweep keys on a stale
     * `lastActivityAt`, i.e. on nobody being there. It is the wrong number here:
     * a heartbeat only fires while `document.hidden` is false, so reaching this
     * line is positive evidence the person IS present. Somebody genuinely working
     * a fourteen-hour day lost 1.5h, was told the session had gone "idle", and had
     * no way to say otherwise.
     *
     * `MAX_MANUAL_ENTRY_MS` (24h) is this repo's own answer to "when does a
     * duration stop being plausible", and its docstring argues the case in as many
     * words — deliberately looser than AUTO_CLOSE_MS, because "a 20-hour launch
     * night is a thing people really log". A live attended session deserves at
     * least what a hand-logged one gets; charging the attended path a stricter
     * ceiling than the typed one is backwards.
     *
     * A ceiling still belongs here rather than nowhere: while heartbeats keep
     * arriving `lastActivityAt` stays fresh, so the sweep never fires, and a tab
     * left visible on an unattended monitor would otherwise run for ever — which
     * is the case time-015 is really about.
     */
    const openFor = Date.now() - entry.clockInAt.getTime();
    if (openFor >= MAX_MANUAL_ENTRY_MS) {
      await closeEntry({
        entryId: entry.id,
        clockOutAt: new Date(entry.clockInAt.getTime() + MAX_MANUAL_ENTRY_MS),
        autoClosed: true,
      });
      return {
        success: false,
        error:
          `Session passed the ${Math.round(MAX_MANUAL_ENTRY_MS / 3_600_000)}h limit and was ` +
          `closed. Log the rest by hand if you were still working.`,
      };
    }

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
    const entry = await findLiveEntry(entryId);
    if (!entry) return { success: false, error: "Entry not found" };
    if (entry.companyId !== session.user.companyId) {
      return { success: false, error: "Not authorized" };
    }
    // Owner OR admin/cofounder can delete.
    if (entry.userId !== session.user.id && !canEditEntryTimes(session.user.role)) {
      return { success: false, error: "Only the owner or a founder can delete this entry" };
    }
    /* THE TOMBSTONE, NOT A DELETE (data-integrity-001).
     *
     * This was `db.timeEntry.delete(...)` until 2026-09-29, and it is the
     * soft-delete gap with the sharpest consequence in the schema: the guard
     * above lets a MEMBER delete their OWN entry, so one mis-click destroyed
     * billable hours that only that person could have reconstructed, and the
     * editedBy / editedByName / editedAt audit trail — the columns that exist to
     * prove an admin did or did not adjust someone's timesheet — went with it.
     * CLAUDE.md's Tier 3 section counted these rows as recoverable for 90 days
     * the whole time.
     *
     * The row is now collected exactly when a Transaction or a Task tombstone is:
     * when /api/cron/purge-soft-deleted hard-purges the overdue Company, which
     * already names `timeEntry` by hand (route.ts). There is deliberately no
     * individual-entry purge stage, for the same reason there is no
     * individual-user one.
     */
    await db.timeEntry.update({ where: { id: entryId }, data: { deletedAt: new Date() } });
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
    const entry = await findLiveEntry(entryId);
    if (!entry) return { success: false, error: "Entry not found" };
    if (entry.companyId !== session.user.companyId) {
      return { success: false, error: "Not authorized" };
    }

    const nextClockOutAt = clockOutAt ?? null;

    /* ONE OPEN ENTRY PER USER, WHICHEVER ACTION WRITES (time-006).
     *
     * The edit modal's clock-out field is labelled "leave blank if still
     * running", so blanking it is an invited action — and it wrote
     * `clockOutAt: null` with no check at all. If the owner already had a live
     * session the workspace then held TWO rows with `clockOutAt = null` for one
     * person. `getOpenEntry()` is a `findFirst` ordered by `clockInAt desc`, so
     * the topbar shows one of them and the other accrues invisibly until the cron
     * sweeps it; both are summed by /time, /settings and `getClockedInPeers`, so
     * the overlap is double-billed and the dashboard's "clocked in now" count is
     * wrong. This is the invariant `clockInAction` defends and the module header
     * above states, and it was true of exactly one of the writers.
     *
     * `id: { not: entryId }` is the whole subtlety: editing the user's ONE open
     * entry and leaving it open is the normal case and must keep working. The rule
     * is also per USER, not per workspace — `entry.userId`, not the editor's id,
     * because an admin edits other people's timesheets.
     *
     * This is a check-then-write and therefore still racy against a simultaneous
     * `clockInAction`; closing that needs the partial unique index described on
     * `closeEntry` below. It removes the one-click hole, not the interleaving.
     */
    if (nextClockOutAt === null) {
      const otherOpen = await db.timeEntry.findFirst({
        where: {
          userId: entry.userId,
          clockOutAt: null,
          deletedAt: null,
          id: { not: entryId },
        },
        select: { id: true },
      });
      if (otherOpen) {
        return {
          success: false,
          error: "That person already has a running session. Clock it out first.",
        };
      }
    }

    /*
     * AND THE EDITED WINDOW MUST NOT LAND ON ANOTHER OF THEIR SESSIONS (time-005,
     * the two-thirds of it that the create path alone did not cover).
     *
     * This is the path with the widest reach: an admin editing somebody ELSE's
     * timesheet can drag a row across a session that person already logged, and
     * until now nothing asked. The same hour then appears in two rows, both are
     * summed by /time, /settings and the project rollup, and the person whose
     * hours they are never sees the edit happen.
     *
     * `excludeEntryId` is the subtlety the create path does not need: a row must
     * not be refused for overlapping itself. Keyed on `entry.userId`, not the
     * editor's id, for the same reason the check above is.
     */
    const collides = await findOverlappingEntry({
      userId: entry.userId,
      clockInAt,
      clockOutAt: nextClockOutAt,
      excludeEntryId: entryId,
    });
    if (collides) return { success: false, error: OVERLAP_ERROR };

    let nextTaskId: string | null | undefined = undefined;
    let nextTaskTitle: string | null | undefined = undefined;
    let nextProjectId: string | null | undefined = undefined;
    let nextProjectName: string | null | undefined = undefined;
    if (taskId === null) {
      nextTaskId = null;
      nextTaskTitle = null;
      // Untagging drops the project with the task (time-004). Leaving the old
      // projectId behind would keep the hours on a project the entry no longer
      // claims any connection to.
      nextProjectId = null;
      nextProjectName = null;
    } else if (taskId) {
      // findTaskTag, not `findUnique` + a `companyId` comparison afterwards: a
      // tombstoned task walked through the old shape (time-003).
      const tag = await findTaskTag(taskId, session.user.companyId);
      if (!tag) {
        return { success: false, error: "Task not found" };
      }
      nextTaskId = taskId;
      nextTaskTitle = tag.taskTitle;
      nextProjectId = tag.projectId;
      nextProjectName = tag.projectName;
    }

    const editor = await db.user.findUnique({ where: { id: session.user.id } });
    if (!editor) return { success: false, error: "User no longer exists" };

    await db.timeEntry.update({
      where: { id: entryId },
      data: {
        clockInAt,
        clockOutAt: nextClockOutAt,
        taskId: nextTaskId,
        taskTitle: nextTaskTitle,
        projectId: nextProjectId,
        projectName: nextProjectName,
        note: note ?? undefined,
        /* time-007 — A P0, and the reason this line is not optional.
         *
         * This update never touched `lastActivityAt`. Blank the clock-out on an
         * entry whose `clockInAt` you also moved forward, and the row is left with
         * `lastActivityAt` hours BEHIND `clockInAt`. `sweepAutoCloseEntries` then
         * matches it (`clockOutAt: null`, `lastActivityAt < cutoff`) and writes
         * `clockOutAt = lastActivityAt` — a clock-out before the clock-in — and
         * `durationMs` clamps a negative interval to zero. The session becomes 0m,
         * overnight, with no error anywhere, applied by a background job hours
         * after the admin left. TimeEntry has no history column, so on a product
         * where hours feed invoices those numbers are simply money destroyed.
         *
         * Both branches guarantee `lastActivityAt >= clockInAt`, which is the
         * invariant the sweep needs. Reopening restarts the idle clock from now —
         * the admin just touched the row, so that is also the honest reading.
         * Closing pins it to the clock-out, for the same reason
         * `createManualEntryAction` does: a completed row can then never trip the
         * sweeper, whatever a later edit does to it. */
        lastActivityAt: nextClockOutAt ?? new Date(),
        /* time-008. `autoClosed` means "nobody typed these times". Somebody just
         * did, so it cannot stay true: app/(app)/time/time-client.tsx renders the
         * stopwatch marker and the warning colour from it and counts the row in the
         * "Auto-closed" stat, which is the signal admins use to pick rows needing
         * review — so a corrected row kept returning to the top of the review queue
         * and the "No idle timeouts" KPI could never clear. Unconditional, not just
         * on the closing branch: the stat counts the flag without looking at
         * `clockOutAt`, so a reopened row would stay in it too. */
        autoClosed: false,
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
