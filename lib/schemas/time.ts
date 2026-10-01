/**
 * Zod schemas for time-tracking mutations. Server actions parse() the input
 * and trust the result; admin-edit guarding lives in the action, not here.
 */

import { z } from "zod";
import { MAX_MANUAL_ENTRY_MS } from "@/lib/time/thresholds";

const Note = z.string().trim().max(500, "Keep it under 500 characters").optional();

/** Clock skew between a browser and the server, absorbed on every "not in the
 *  future" bound so a user whose laptop is 20 s fast is not told off. */
const SKEW_MS = 60_000;

const MAX_HOURS = Math.round(MAX_MANUAL_ENTRY_MS / 3_600_000);
const TOO_LONG = `A single session can't be longer than ${MAX_HOURS} hours`;

export const ClockInSchema = z.object({
  taskId: z.string().min(1).optional(),
  note: Note,
});

export const ClockOutSchema = z.object({
  entryId: z.string().min(1),
  note: Note,
});

export const HeartbeatSchema = z.object({
  entryId: z.string().min(1),
});

// Manual/backdated entry (X1). Both ends are required — a hand-logged entry
// is a *completed* session, never an open one (an open manual row would
// collide with the "one open entry per user" rule). Guards: clock-out after
// clock-in, and neither end in the future (you can't log unworked time). The
// 60s grace absorbs client/server clock skew.
export const CreateManualEntrySchema = z
  .object({
    clockInAt: z.coerce.date(),
    clockOutAt: z.coerce.date(),
    taskId: z.string().min(1).optional().nullable(),
    note: Note,
  })
  .refine((v) => v.clockOutAt.getTime() > v.clockInAt.getTime(), {
    message: "Clock-out must be after clock-in",
    path: ["clockOutAt"],
  })
  .refine((v) => v.clockOutAt.getTime() <= Date.now() + SKEW_MS, {
    message: "You can't log time in the future",
    path: ["clockOutAt"],
  })
  // time-005. There was no upper bound at all, so `clockInAt: 1990-01-01` with
  // `clockOutAt: now` parsed and stored one 36-year "session". This action is
  // ungated by role on purpose, which put /settings "Total tracked", the /time
  // KPI and every project rollup in the hands of the lowest-privilege user in
  // the workspace. The OVERLAP half of the same finding cannot live here — it
  // needs a query — and is enforced in `createManualEntryAction`.
  .refine((v) => v.clockOutAt.getTime() - v.clockInAt.getTime() <= MAX_MANUAL_ENTRY_MS, {
    message: TOO_LONG,
    path: ["clockOutAt"],
  });

// Admin-only manual edit. clockInAt is always required (the start moment);
// clockOutAt and the other fields are optional patches.
//
// time-009: this carried ONE refine — clock-out not before clock-in — and no
// upper bound on either end, while the path it guards can edit SOMEBODY ELSE's
// timesheet. A `<input type="datetime-local">` year spinner is one scroll from
// 2028, `durationMs` returns the literal interval, and nothing downstream flags
// it, so a single fat-fingered year added thousands of hours to /settings "Total
// tracked", the /time KPI and (now that time-004 writes `projectId`) the project
// rollups. The rule the create path already enforced has to hold here too, and
// the ceiling has to be the same number — hence both refines read
// `MAX_MANUAL_ENTRY_MS` rather than repeating a literal.
//
// `clockOutAt: null` stays legal: "leave blank if still running" is documented
// UI on the edit modal. What that reopening must NOT do is leave the row where
// the nightly sweep can zero it, and that is enforced in `updateTimeEntryAction`
// (time-006 / time-007) because it needs to know about the user's other rows.
export const UpdateTimeEntrySchema = z
  .object({
    entryId: z.string().min(1),
    clockInAt: z.coerce.date(),
    clockOutAt: z.coerce.date().optional().nullable(),
    taskId: z.string().min(1).optional().nullable(),
    note: Note,
  })
  .refine((v) => !v.clockOutAt || v.clockOutAt.getTime() >= v.clockInAt.getTime(), {
    message: "Clock-out must be after clock-in",
    path: ["clockOutAt"],
  })
  .refine((v) => v.clockInAt.getTime() <= Date.now() + SKEW_MS, {
    message: "A session can't start in the future",
    path: ["clockInAt"],
  })
  .refine((v) => !v.clockOutAt || v.clockOutAt.getTime() <= Date.now() + SKEW_MS, {
    message: "You can't log time in the future",
    path: ["clockOutAt"],
  })
  .refine(
    (v) => !v.clockOutAt || v.clockOutAt.getTime() - v.clockInAt.getTime() <= MAX_MANUAL_ENTRY_MS,
    { message: TOO_LONG, path: ["clockOutAt"] }
  );
