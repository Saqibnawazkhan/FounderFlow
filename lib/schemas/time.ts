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
