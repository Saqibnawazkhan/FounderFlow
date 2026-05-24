/**
 * Zod schema for task input. Used by both the TaskForm and addTaskAction.
 */

import { z } from "zod";

export const NewTaskSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(200),
  description: z.string().trim().max(2000, "Description must be 2000 chars or less"),
  status: z.enum(["pending", "in_progress", "completed"]),
  priority: z.enum(["low", "medium", "high", "urgent"]),
  assignedTo: z.string().min(1, "Pick an assignee"),
  deadline: z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), "Invalid deadline")
    // Reject past deadlines (closes audit flaw #37 — HTML `min` was the only
    // gate before, which doesn't fire if the user types or pastes a date).
    // Compare against start-of-today so "due today" stays valid.
    .refine((v) => {
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);
      return new Date(v) >= startOfToday;
    }, "Deadline can't be in the past"),
});

export type NewTaskInput = z.infer<typeof NewTaskSchema>;

export const TaskStatusUpdateSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["pending", "in_progress", "completed"]),
});
