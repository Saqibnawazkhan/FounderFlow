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
  deadline: z.string().refine((v) => !Number.isNaN(Date.parse(v)), "Invalid deadline"),
});

export type NewTaskInput = z.infer<typeof NewTaskSchema>;

export const TaskStatusUpdateSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["pending", "in_progress", "completed"]),
});
