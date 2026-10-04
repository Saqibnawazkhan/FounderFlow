/**
 * Zod schema for task input. Used by both the TaskForm and addTaskAction.
 */

import { z } from "zod";
import { DEADLINE_HOUR_UTC, deadlineDayValue } from "@/lib/tasks/deadline";

/**
 * The oldest day the deadline refine will accept: YESTERDAY, in UTC.
 *
 * BOTH SIDES OF THE COMPARISON MUST BE IN THE SAME FRAME, and the first version
 * of this bound was not. `deadlineDayValue` reads the day from UTC parts (that
 * is the whole point of `lib/tasks/deadline.ts` — one module decides what day a
 * stored instant names). The bound was built from LOCAL parts, so on every
 * machine whose local date differs from the UTC date — which is most of the
 * world for part of every day — the two disagreed by one, and the intended
 * one-day slack silently became two days or none.
 *
 * It was green when written and went red hours later, from nothing but the
 * clock moving: at TZ=America/Bogota after 19:00 the local day is still
 * yesterday while UTC has rolled over, and a deadline two full days in the past
 * landed exactly on the bound and was ACCEPTED. The test that caught it
 * (`rejects a deadline properly in the past`) is time-of-day dependent by
 * construction, so the regression test below freezes the clock instead.
 */
function pastDeadlineBound(): string {
  const now = new Date();
  // Date.UTC normalises the rollover, so the 1st of a month goes back to the
  // last day of the previous one without special-casing. Noon rather than
  // midnight for the same reason the stored instants use it: nothing lands on a
  // boundary where a one-millisecond difference changes the day.
  return deadlineDayValue(
    new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1, DEADLINE_HOUR_UTC)
    )
  );
}

export const NewTaskSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(200),
  description: z.string().trim().max(2000, "Description must be 2000 chars or less"),
  status: z.enum(["pending", "in_progress", "completed"]),
  priority: z.enum(["low", "medium", "high", "urgent"]),
  // Project the task lives under. Required since the add_projects migration —
  // the UI auto-prefills with "General" when there's no other context.
  projectId: z.string().min(1, "Pick a project"),
  assignedTo: z.string().min(1, "Pick an assignee"),
  deadline: z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), "Invalid deadline")
    /*
     * Reject past deadlines (audit flaw #37 — HTML `min` was the only gate, and
     * it does not fire on a typed or pasted date).
     *
     * COMPARED AS CALENDAR DAYS, NOT AS INSTANTS, which is what
     * tasks-and-comments-011 was about and what this refine was still getting
     * wrong after the rest of that finding was fixed. `<input type="date">` hands
     * over `"YYYY-MM-DD"`, and `new Date("2026-10-15")` is UTC midnight under the
     * ES date-only rule — while `setHours(0,0,0,0)` is LOCAL midnight. West of
     * Greenwich the picked day is therefore hours behind the comparison and "due
     * today" was refused outright: at UTC-5, 00:00Z against 05:00Z. The form
     * converts the day to a noon-UTC instant in `onSubmit`, but `zodResolver` runs
     * THIS first and `handleSubmit` never reaches `onSubmit` when it fails, so the
     * conversion could not help. Three comments elsewhere said this was fixed.
     *
     * `deadlineDayValue` reads the day from UTC parts, which is the one module
     * that knows how a deadline is stored, so a date-only string and a stored
     * noon-UTC instant both name the same day.
     *
     * AND THE BOUND IS YESTERDAY, NOT TODAY, deliberately. This schema runs on the
     * client AND in the action, and the action runs on a UTC host: a customer at
     * UTC-5 submitting their own "today" at 23:30 local is already tomorrow in the
     * server's frame, so a today-bound would reject a legitimate date on the
     * server after accepting it in the browser. No zone is stored for a user yet
     * (the `timezone` column is the real fix and is out of scope), and the widest
     * real offset is under 24h, so one day of slack makes a valid "today"
     * impossible to refuse from any zone. Accepting a deadline one day stale is a
     * smaller harm than blocking someone from scheduling work for today.
     */
    .refine((v) => {
      const day = deadlineDayValue(v);
      if (day === "") return false;
      return day >= pastDeadlineBound();
    }, "Deadline can't be in the past"),
});

export type NewTaskInput = z.infer<typeof NewTaskSchema>;

export const TaskStatusUpdateSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["pending", "in_progress", "completed"]),
});

/**
 * How many task ids one bulk request may carry.
 *
 * Capped so a malicious client can't ask us to touch an unbounded set in one
 * request. EXPORTED, and that is the point of it being here (second half of
 * tasks-and-comments-010): three places need this number and they must not
 * disagree —
 *
 *   - the parser below, which refuses an over-sized payload;
 *   - `bulkSelectionTooLargeError` in lib/actions/tasks.ts, whose sentence
 *     NAMES the number to the user;
 *   - `toggleSelectAll` in app/(app)/tasks/tasks-client.tsx, which clamps the
 *     checkbox so a legal selection is the only one the UI can produce.
 *
 * It was inline here and mirrored by hand in the action, with a comment saying
 * "if lib/schemas/task.ts ever exports its cap, import it here" — and the
 * client had no copy at all, which is how "select all" on a 300-row board
 * (`TASK_PAGE_SIZE`, lib/queries/tasks.ts) could only ever be refused.
 */
export const MAX_BULK_TASK_IDS = 200;

const TaskIdList = z
  .array(z.string().min(1))
  .min(1, "Select at least one task")
  .max(MAX_BULK_TASK_IDS);

export const BulkTaskStatusSchema = z.object({
  ids: TaskIdList,
  status: z.enum(["pending", "in_progress", "completed"]),
});

export const BulkTaskDeleteSchema = z.object({
  ids: TaskIdList,
});

// Kanban drag-reorder. The client computes the target `order` (a midpoint
// between the drop neighbors) and sends it; the server just validates the
// caller can touch the task and persists it.
export const ReorderTaskSchema = z.object({
  id: z.string().min(1),
  order: z.number().finite(),
});
