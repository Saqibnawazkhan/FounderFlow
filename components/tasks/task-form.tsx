"use client";

import { useId, useState } from "react";
import toast from "react-hot-toast";
import { addTaskAction } from "@/lib/actions/tasks";
import type { TaskPriority, TaskStatus, User } from "@/lib/types";
import { cn } from "@/lib/utils";

interface Props {
  /** Company users for the assignee dropdown — parent fetches and passes in. */
  users: User[];
  /** Current user's id, used to default assignee to self. */
  currentUserId?: string;
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

export function TaskForm({ users, currentUserId, onClose, onSuccess }: Props) {
  const titleId = useId();
  const descId = useId();
  const assigneeId = useId();
  const deadlineId = useId();

  const [form, setForm] = useState({
    title: "",
    description: "",
    assignedTo: currentUserId || users[0]?.id || "",
    priority: "medium" as TaskPriority,
    status: "pending" as TaskStatus,
    deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  });
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.title.trim()) {
      toast.error("Please add a task title");
      return;
    }
    if (!form.assignedTo) {
      toast.error("Please select an assignee");
      return;
    }
    setLoading(true);
    const result = await addTaskAction({
      title: form.title.trim(),
      description: form.description.trim(),
      status: form.status,
      priority: form.priority,
      assignedTo: form.assignedTo,
      deadline: new Date(form.deadline).toISOString(),
    });
    setLoading(false);

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
  const inputClass =
    "w-full rounded-xl border border-border bg-bg px-4 py-2.5 text-sm text-fg placeholder:text-fg-muted/60 transition-colors focus:border-primary/50 focus:bg-surface focus:outline-none";

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
      <div>
        <label htmlFor={titleId} className={labelClass}>
          Title
        </label>
        <input
          id={titleId}
          value={form.title}
          onChange={(e) => setForm({ ...form, title: e.target.value })}
          className={inputClass}
          placeholder="What needs to be done?"
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
        />
      </div>

      <div>
        <label htmlFor={descId} className={labelClass}>
          Description (optional)
        </label>
        <textarea
          id={descId}
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          className={cn(inputClass, "min-h-[80px] resize-none")}
          placeholder="Add more context…"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor={assigneeId} className={labelClass}>
            Assigned to
          </label>
          <select
            id={assigneeId}
            value={form.assignedTo}
            onChange={(e) => setForm({ ...form, assignedTo: e.target.value })}
            className={cn(inputClass, "appearance-none")}
          >
            {users.length === 0 && <option value="">No users in this company</option>}
            {users.map((u) => (
              <option key={u.id} value={u.id} className="bg-bg">
                {u.name} {u.id === currentUserId ? "(you)" : ""}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={deadlineId} className={labelClass}>
            Deadline
          </label>
          <input
            id={deadlineId}
            type="date"
            value={form.deadline}
            onChange={(e) => setForm({ ...form, deadline: e.target.value })}
            className={inputClass}
            min={new Date().toISOString().slice(0, 10)}
          />
        </div>
      </div>

      <div>
        <p className={labelClass}>Priority</p>
        <div className="grid grid-cols-4 gap-2">
          {PRIORITIES.map((p) => {
            const active = form.priority === p.value;
            return (
              <button
                key={p.value}
                type="button"
                onClick={() => setForm({ ...form, priority: p.value })}
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
            const active = form.status === s.value;
            return (
              <button
                key={s.value}
                type="button"
                onClick={() => setForm({ ...form, status: s.value })}
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
          disabled={loading}
          className="inline-flex flex-1 items-center justify-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-primary-fg shadow-[0_0_30px_rgb(182_244_37_/_var(--glow-shadow-opacity))] transition-transform hover:scale-[1.01] active:scale-95 disabled:opacity-60 disabled:hover:scale-100"
        >
          {loading ? "Creating…" : "Create task"}
        </button>
      </div>
    </form>
  );
}
