"use client";

import { useEffect, useId } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import toast from "react-hot-toast";
import { addTaskAction } from "@/lib/actions/tasks";
import { NewTaskSchema, type NewTaskInput } from "@/lib/schemas/task";
import type { TaskPriority, TaskStatus, User } from "@/lib/types";
import { cn } from "@/lib/utils";

interface Props {
  /** Company users for the assignee dropdown — parent fetches and passes in. */
  users: User[];
  /** Available projects for the project picker. Required since the
   *  add_projects migration — Task.projectId is non-nullable. */
  projects: { id: string; name: string }[];
  /** Current user's id, used to default assignee to self. */
  currentUserId?: string;
  /** Pre-select a project when the form is rendered inside a specific
   *  project detail page. Locks the field if set. */
  forcedProjectId?: string;
  onClose: () => void;
  onSuccess?: () => void;
}

const PRIORITIES: { value: TaskPriority; label: string; dot: string; tone: string }[] = [
  { value: "low", label: "Low", dot: "bg-fg-muted", tone: "text-fg-muted" },
  { value: "medium", label: "Medium", dot: "bg-info", tone: "text-info" },
  { value: "high", label: "High", dot: "bg-warning", tone: "text-warning" },
  { value: "urgent", label: "Urgent", dot: "bg-danger", tone: "text-danger" },
];

const STATUSES: { value: TaskStatus; label: string }[] = [
  { value: "pending", label: "Pending" },
  { value: "in_progress", label: "In progress" },
  { value: "completed", label: "Completed" },
];

export function TaskForm({
  users,
  projects,
  currentUserId,
  forcedProjectId,
  onClose,
  onSuccess,
}: Props) {
  const titleId = useId();
  const descId = useId();
  const assigneeId = useId();
  const projectFieldId = useId();
  const deadlineId = useId();

  const today = new Date().toISOString().slice(0, 10);
  const defaultDeadline = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<NewTaskInput>({
    resolver: zodResolver(NewTaskSchema),
    mode: "onSubmit",
    reValidateMode: "onChange",
    defaultValues: {
      title: "",
      description: "",
      projectId: forcedProjectId || projects[0]?.id || "",
      assignedTo: currentUserId || users[0]?.id || "",
      priority: "medium",
      status: "pending",
      deadline: defaultDeadline,
    },
  });

  // The parent fetches `users` asynchronously, so on first mount the list may
  // still be empty and assignedTo's default is "". Once users arrive, fill it
  // in (without marking dirty) if the user hasn't already touched the field.
  useEffect(() => {
    if (users.length === 0) return;
    const fallback = currentUserId || users[0]?.id;
    if (!fallback) return;
    if (watch("assignedTo")) return;
    setValue("assignedTo", fallback);
    // We intentionally only re-sync when the user list changes; otherwise
    // watching `assignedTo` would cause an update loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [users.length, currentUserId]);

  // Pill-button groups (priority/status) aren't native form controls — we
  // mirror their value via watch() and write via setValue() so RHF still owns
  // the source of truth and zod still gates submit.
  const priority = watch("priority");
  const status = watch("status");

  async function onSubmit(data: NewTaskInput) {
    const result = await addTaskAction({
      ...data,
      title: data.title.trim(),
      description: data.description.trim(),
      deadline: new Date(data.deadline).toISOString(),
    });
    if (!result.success) {
      toast.error(result.error);
      return;
    }
    toast.success("Task created");
    onSuccess?.();
    onClose();
  }

  const labelClass =
    "mb-2 block font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted";

  function inputClass(hasError: boolean) {
    return cn(
      "w-full rounded-xl border bg-bg px-4 py-2.5 text-sm text-fg placeholder:text-fg-muted/60 transition-colors focus:bg-surface focus:outline-none",
      hasError ? "border-danger/60 focus:border-danger" : "border-border focus:border-primary/50"
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
      <div>
        <label htmlFor={titleId} className={labelClass}>
          Title
        </label>
        <input
          id={titleId}
          placeholder="What needs to be done?"
          aria-invalid={errors.title ? true : undefined}
          aria-describedby={errors.title ? `${titleId}-err` : undefined}
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          {...register("title")}
          className={inputClass(!!errors.title)}
        />
        {errors.title && (
          <p id={`${titleId}-err`} className="mt-1.5 text-xs text-danger">
            {errors.title.message}
          </p>
        )}
      </div>

      <div>
        <label htmlFor={descId} className={labelClass}>
          Description (optional)
        </label>
        <textarea
          id={descId}
          placeholder="Add more context…"
          aria-invalid={errors.description ? true : undefined}
          {...register("description")}
          className={cn(inputClass(!!errors.description), "min-h-[80px] resize-none")}
        />
        {errors.description && (
          <p className="mt-1.5 text-xs text-danger">{errors.description.message}</p>
        )}
      </div>

      <div>
        <label htmlFor={projectFieldId} className={labelClass}>
          Project
        </label>
        <select
          id={projectFieldId}
          disabled={Boolean(forcedProjectId)}
          aria-invalid={errors.projectId ? true : undefined}
          {...register("projectId")}
          className={cn(inputClass(!!errors.projectId), "appearance-none")}
        >
          {projects.length === 0 && <option value="">No projects yet</option>}
          {projects.map((p) => (
            <option key={p.id} value={p.id} className="bg-bg">
              {p.name}
            </option>
          ))}
        </select>
        {errors.projectId && (
          <p className="mt-1.5 text-xs text-danger">{errors.projectId.message}</p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor={assigneeId} className={labelClass}>
            Assigned to
          </label>
          <select
            id={assigneeId}
            aria-invalid={errors.assignedTo ? true : undefined}
            {...register("assignedTo")}
            className={cn(inputClass(!!errors.assignedTo), "appearance-none")}
          >
            {users.length === 0 && <option value="">No users in this company</option>}
            {users.map((u) => (
              <option key={u.id} value={u.id} className="bg-bg">
                {u.name} {u.id === currentUserId ? "(you)" : ""}
              </option>
            ))}
          </select>
          {errors.assignedTo && (
            <p className="mt-1.5 text-xs text-danger">{errors.assignedTo.message}</p>
          )}
        </div>
        <div>
          <label htmlFor={deadlineId} className={labelClass}>
            Deadline
          </label>
          <input
            id={deadlineId}
            type="date"
            min={today}
            aria-invalid={errors.deadline ? true : undefined}
            aria-describedby={errors.deadline ? `${deadlineId}-err` : undefined}
            {...register("deadline")}
            className={inputClass(!!errors.deadline)}
          />
          {errors.deadline && (
            <p id={`${deadlineId}-err`} className="mt-1.5 text-xs text-danger">
              {errors.deadline.message}
            </p>
          )}
        </div>
      </div>

      <div>
        <p className={labelClass}>Priority</p>
        <div className="grid grid-cols-4 gap-2">
          {PRIORITIES.map((p) => {
            const active = priority === p.value;
            return (
              <button
                key={p.value}
                type="button"
                onClick={() =>
                  setValue("priority", p.value, { shouldValidate: true, shouldDirty: true })
                }
                aria-pressed={active}
                className={cn(
                  "rounded-xl border px-3 py-2.5 text-sm font-medium transition-all",
                  active
                    ? "border-primary/50 bg-primary/[0.06] text-fg ring-2 ring-primary/20"
                    : "border-border text-fg-muted hover:border-primary/30 hover:text-fg"
                )}
              >
                <span className="flex items-center justify-center gap-2">
                  <span className={cn("h-2 w-2 rounded-full", p.dot)} />
                  {p.label}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <p className={labelClass}>Initial status</p>
        <div className="grid grid-cols-3 gap-2">
          {STATUSES.map((s) => {
            const active = status === s.value;
            return (
              <button
                key={s.value}
                type="button"
                onClick={() =>
                  setValue("status", s.value, { shouldValidate: true, shouldDirty: true })
                }
                aria-pressed={active}
                className={cn(
                  "rounded-xl border px-3 py-2 text-sm font-medium transition-all",
                  active
                    ? "border-primary/50 bg-primary/[0.06] text-fg ring-2 ring-primary/20"
                    : "border-border text-fg-muted hover:border-primary/30 hover:text-fg"
                )}
              >
                {s.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex gap-3 pt-2">
        <button
          type="button"
          onClick={onClose}
          className="flex-1 rounded-full border border-border bg-bg px-5 py-2.5 text-sm font-medium text-fg transition-colors hover:bg-surface-hover"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={isSubmitting}
          className="inline-flex flex-1 items-center justify-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-primary-fg shadow-[0_0_30px_rgb(182_244_37_/_var(--glow-shadow-opacity))] transition-transform hover:scale-[1.01] active:scale-95 disabled:opacity-60 disabled:hover:scale-100"
        >
          {isSubmitting ? "Creating…" : "Create task"}
        </button>
      </div>
    </form>
  );
}
