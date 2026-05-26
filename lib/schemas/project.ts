/**
 * Zod schemas for project mutations. Server actions parse() these and trust
 * the result; the React forms use the same schemas via zodResolver so client
 * + server validation stay in lock step.
 */

import { z } from "zod";

// Fixed palette aligned with the design tokens in app/globals.css. Add to
// this list when a new accent color is wired into Tailwind — keeping the
// allowed set narrow means the project card visuals stay legible across
// dark/light themes.
export const PROJECT_COLORS = ["primary", "cyan", "pink", "warning", "info"] as const;
export type ProjectColor = (typeof PROJECT_COLORS)[number];

// Lifecycle. Drives the default filter on /projects (archived hidden by
// default) and shifts the card visual tone (on_hold dims; completed adds
// a check; archived greys out).
export const PROJECT_STATUSES = ["active", "on_hold", "completed", "archived"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

const NameField = z
  .string()
  .trim()
  .min(1, "Project name is required")
  .max(120, "Project name is too long");

const DescriptionField = z
  .string()
  .trim()
  .max(500, "Description is too long")
  .optional()
  // Coerce empty string to undefined so an empty textarea round-trips to
  // SQL NULL instead of a stored empty string.
  .transform((v) => (v && v.length > 0 ? v : undefined));

const SupervisorField = z.string().min(1, "Pick a supervisor");

const ColorField = z.enum(PROJECT_COLORS, {
  errorMap: () => ({ message: "Pick a project color" }),
});

const StatusField = z.enum(PROJECT_STATUSES, {
  errorMap: () => ({ message: "Pick a project status" }),
});

// Preprocess so an empty date input ("" from the browser) becomes null
// BEFORE z.coerce.date() — otherwise the coerce stage produces an
// Invalid Date and the whole parse fails silently. Resolved values:
//   "" / undefined → null
//   "2026-12-31" → Date
const TargetEndDateField = z.preprocess(
  (v) => (v === "" || v === undefined ? null : v),
  z.coerce.date().nullable().optional()
);

export const NewProjectSchema = z.object({
  name: NameField,
  description: DescriptionField,
  supervisorId: SupervisorField,
  // No .default() here so the inferred input/output types match — RHF's
  // useForm<T> wants a single T, and the form always supplies a starter
  // value anyway. The server action also ALWAYS receives a color.
  color: ColorField,
  targetEndDate: TargetEndDateField,
});
export type NewProjectInput = z.infer<typeof NewProjectSchema>;

export const UpdateProjectSchema = z.object({
  projectId: z.string().min(1),
  name: NameField,
  description: DescriptionField,
  color: ColorField,
  status: StatusField,
  targetEndDate: TargetEndDateField,
});
export type UpdateProjectInput = z.infer<typeof UpdateProjectSchema>;

export const ChangeSupervisorSchema = z.object({
  projectId: z.string().min(1),
  supervisorId: SupervisorField,
});
export type ChangeSupervisorInput = z.infer<typeof ChangeSupervisorSchema>;
