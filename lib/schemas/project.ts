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
//
// Rebrand note: the old decorative accents ("cyan", "pink") and the generic
// "primary"/"info" slugs were retired in favour of the emerald ramp plus a
// neutral. Existing rows were rewritten by the
// `rebrand_project_colors` migration, so no persisted slug outside this
// tuple should survive. "emerald" is the brand green (it renders with the
// `primary` tokens — see COLOR_CLASSES in components/projects/project-card.tsx).
export const PROJECT_COLORS = ["emerald", "forest", "mint", "slate", "warning"] as const;
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

// Tight input/output types so RHF's `useForm<T>` infers a single shape
// (Date | null | undefined). `z.preprocess` would widen the input type to
// `unknown` and break the resolver. The browser's <input type=date>
// returns "" for an unset date; the form normalises that to `null`
// before calling .parse, so the schema never sees an empty string here.
const TargetEndDateField = z.coerce.date().nullable().optional();

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

/* ───────────────────────────────────────────────────────────────────────── */
/* Duplicate                                                                 */
/* ───────────────────────────────────────────────────────────────────────── */

/**
 * Ceiling on how many tasks one duplicate may copy.
 *
 * Not a product limit — a safety valve. The copy runs inside a single
 * interactive transaction (a half-copied project is worse than none), and
 * Prisma's default interactive-transaction timeout is 5s. A project with
 * 12,000 tasks would blow through that and roll back at the deadline, which
 * reads to the user as "it just failed" with no explanation. Refusing up
 * front with a sentence that names the number is the honest failure.
 *
 * 500 is far above any real project here (the largest seeded workspace has
 * ~40 tasks) and still comfortably inside one `createMany`.
 */
export const MAX_DUPLICATED_TASKS = 500;

/**
 * Duplicating an existing project.
 *
 * WHAT A DUPLICATE IS: a copy of a project's *shape* — its name, colour,
 * supervisor and the task list, as a plan that has not been executed yet.
 * It is explicitly NOT a snapshot of a project's history.
 *
 * The three booleans below are the product decision. Each default is argued
 * where it is declared, because the wrong default here is not a papercut:
 * it either hands people a project that looks finished on arrival, or
 * quietly signs fifteen colleagues up for work they never agreed to.
 *
 * ── The correctness boundary (why there is no fourth or fifth flag) ──
 * There is deliberately no `copyBudgets`, `copyTransactions`,
 * `copyTimeEntries` or `copyComments`, and adding one is not a matter of
 * taste:
 *
 *   - A Transaction is a claim that money moved. Copying one invents revenue
 *     or expense that never happened, and it lands in the same sums that
 *     /reports, /expenses and the dashboard totals read. A duplicate button
 *     that can restate a company's finances is a bug with a checkbox on it.
 *   - A TimeEntry is a claim that a person worked those hours. Copying one
 *     fabricates someone else's timesheet.
 *   - A Comment is a claim that a person said something. Copying one puts
 *     words in their mouth, under their avatar, on work they never saw.
 *   - A Budget is a period-scoped cap that budget checks fire against
 *     (lib/budgets/check.ts). A copied one double-counts the same allowance.
 *
 * Tasks are the one exception, and only because a task is a statement of
 * intent rather than a record of fact — which is exactly why the copy resets
 * every trace of execution on it (see `copyTasks`).
 *
 * `tests/lib/schemas/project.test.ts` pins this: a later "copy everything"
 * flag has to delete a failing test and argue with this comment first.
 *
 * Note on `.default()` — unlike NewProjectSchema above, defaults are safe
 * here because no `zodResolver` consumes this schema. The duplicate modal is
 * a plain controlled form that always sends all three booleans, so the
 * input/output type split that would break `useForm<T>` never arises. The
 * defaults exist for the server: a payload from an older client, or from
 * anything that isn't our form, lands on the conservative shape.
 */
export const DuplicateProjectSchema = z.object({
  /**
   * The project being copied. Named `sourceProjectId`, not `projectId`,
   * because this action deals in two projects and its result carries the
   * *new* one's id — a bare `projectId` either side of that boundary is the
   * kind of ambiguity that gets the wrong project revalidated.
   */
  sourceProjectId: z.string().min(1, "Pick a project to duplicate"),

  /**
   * The copy's name. Required rather than derived server-side: a project
   * list with three rows called "Launch v2 (copy)" is unnavigable, so the
   * user names the thing while they still remember why they made it. The
   * modal pre-fills "<source> (copy)" so the fast path is still one click.
   * Bounded by the same NameField every other project name uses — the copy
   * is a project, not a special case.
   */
  name: NameField,

  /**
   * Copy the task list. DEFAULT TRUE: the task list *is* the reusable shape.
   * "Duplicate this project" with the tasks left behind is just "new
   * project", which already has a button. Off is still worth offering —
   * people duplicate a project to inherit its colour, supervisor and naming
   * for a genuinely fresh scope of work.
   *
   * Whatever this is set to, copied tasks arrive RESET, unconditionally:
   * status to "pending", `completedAt` to null. That is not a flag, and it
   * should not become one. A duplicate is a plan nobody has executed yet, so
   * a copied task marked "completed" asserts work that has not happened; the
   * numbers on the project card ("3/8 open") would be a lie from the moment
   * the project existed, and "mark it all undone" would be the first thing
   * anyone had to do by hand. The only reading under which copying
   * completion makes sense is an archive or a snapshot, which is a different
   * feature with a different name.
   */
  copyTasks: z.boolean().default(true),

  /**
   * Keep each task's assignee. DEFAULT FALSE, and this is the default worth
   * defending hardest.
   *
   * Assignment is a commitment between two people. Duplicating a project is
   * one click by one person; it must not be able to place fifteen new
   * obligations on fourteen colleagues — each with a notification, each
   * showing up in their /tasks count — without anyone having agreed to
   * anything. The blast radius of the wrong default here is other people's
   * workload.
   *
   * `Task.assignedTo` is NOT NULL with an FK to User (prisma/schema.prisma
   * :293), so "unassigned" is not representable — the schema forces a choice
   * rather than allowing a blank. So the copy assigns every task to the
   * person who pressed Duplicate. That is the honest resting place: the
   * duplicate is *their* plan until they hand pieces of it out, and it puts
   * the re-assignment work on the person who asked for the copy rather than
   * on everyone else.
   *
   * True is a real option, not a trap door: re-running the same quarterly
   * checklist with the same owners is a genuine workflow. The action
   * re-verifies every carried-over assignee is still a live member of the
   * company before trusting it.
   */
  keepAssignees: z.boolean().default(false),

  /**
   * Shift copied deadlines forward as one block. DEFAULT TRUE.
   *
   * `Task.deadline` is NOT NULL (prisma/schema.prisma:297), so the obvious
   * third option — clear the dates and let people fill them in — does not
   * exist. The schema constrains the design to shift-or-keep.
   *
   * Keeping them is wrong by default because a duplicate's source is, by
   * definition, work that already ran: its dates are in the past, so the
   * copy arrives entirely overdue and every card lights up red on day one.
   * `NewTaskSchema` already refuses a past deadline outright, so copying
   * verbatim mints rows the normal task form could never create.
   *
   * So: ONE uniform delta across every copied task, chosen so the earliest
   * deadline lands today. Uniform is the load-bearing word — clamping each
   * past date to today individually would flatten a six-week plan into a
   * single day and destroy the ordering that made the project worth copying.
   * If the source's earliest deadline is already in the future the delta is
   * zero: a plan that has not started yet needs no rescuing, and dragging it
   * backwards would invent urgency nobody asked for.
   *
   * False keeps the dates verbatim, for someone deliberately reconstructing
   * a historical window.
   */
  shiftDeadlines: z.boolean().default(true),
});
export type DuplicateProjectInput = z.infer<typeof DuplicateProjectSchema>;
