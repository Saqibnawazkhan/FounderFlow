/**
 * Zod schemas for time-tracking mutations. Server actions parse() the input
 * and trust the result; admin-edit guarding lives in the action, not here.
 */

import { z } from "zod";

const Note = z.string().trim().max(500, "Keep it under 500 characters").optional();

export const ClockInSchema = z.object({
  taskId: z.string().min(1).optional(),
  note: Note,
});

export type ClockInInput = z.infer<typeof ClockInSchema>;

export const ClockOutSchema = z.object({
  entryId: z.string().min(1),
  note: Note,
});

export type ClockOutInput = z.infer<typeof ClockOutSchema>;

export const HeartbeatSchema = z.object({
  entryId: z.string().min(1),
});

export type HeartbeatInput = z.infer<typeof HeartbeatSchema>;

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
  .refine((v) => v.clockOutAt.getTime() <= Date.now() + 60_000, {
    message: "You can't log time in the future",
    path: ["clockOutAt"],
  });

export type CreateManualEntryInput = z.infer<typeof CreateManualEntrySchema>;

// Admin-only manual edit. clockInAt is always required (the start moment);
// clockOutAt and the other fields are optional patches. The action enforces
// that clockInAt <= clockOutAt when both are provided.
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
  });

export type UpdateTimeEntryInput = z.infer<typeof UpdateTimeEntrySchema>;
