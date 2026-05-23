"use client";

import { useMemo, useState } from "react";
import {
  AlertCircle,
  Calendar,
  CheckCircle2,
  CheckSquare,
  CircleDot,
  Clock,
  LayoutGrid,
  LayoutList,
  Plus,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import toast from "react-hot-toast";
import { format, isPast, isToday } from "date-fns";
import { useStore } from "@/lib/store";
import { Modal } from "@/components/ui/modal";
import { TaskForm } from "@/components/tasks/task-form";
import { Avatar } from "@/components/ui/avatar";
import { EmptyState } from "@/components/ui/empty-state";
import { PillBadge } from "@/components/landing/pill-badge";
import { cn } from "@/lib/utils";
import type { Task, TaskStatus, TaskPriority } from "@/lib/types";

interface Column {
  status: TaskStatus;
  title: string;
  icon: LucideIcon;
  tone: "primary" | "cyan" | "pink";
}

const COLUMNS: Column[] = [
  { status: "pending", title: "Pending", icon: Clock, tone: "pink" },
  { status: "in_progress", title: "In progress", icon: CircleDot, tone: "cyan" },
  { status: "completed", title: "Completed", icon: CheckCircle2, tone: "primary" },
];

const PRIORITY_STYLES: Record<TaskPriority, string> = {
  urgent: "border-danger/30 bg-danger/10 text-danger",
  high: "border-warning/30 bg-warning/10 text-warning",
  medium: "border-info/30 bg-info/10 text-info",
  low: "border-border bg-bg text-fg-muted",
};

export default function TasksPage() {
  const tasks = useStore((s) => s.getCompanyTasks());
  const updateStatus = useStore((s) => s.updateTaskStatus);
  const deleteTask = useStore((s) => s.deleteTask);
  const currentUser = useStore((s) => s.currentUser);

  const [modalOpen, setModalOpen] = useState(false);
  const [view, setView] = useState<"board" | "list">("board");
  const [filter, setFilter] = useState<"all" | "mine" | "assigned-by-me">("all");

  const filtered = useMemo(() => {
    if (filter === "mine") return tasks.filter((t) => t.assignedTo === currentUser?.id);
    if (filter === "assigned-by-me") return tasks.filter((t) => t.assignedBy === currentUser?.id);
    return tasks;
  }, [tasks, filter, currentUser?.id]);

  const grouped = useMemo(
    () => ({
      pending: filtered.filter((t) => t.status === "pending"),
      in_progress: filtered.filter((t) => t.status === "in_progress"),
      completed: filtered.filter((t) => t.status === "completed"),
    }),
    [filtered]
  );

  function handleStatusChange(id: string, status: TaskStatus) {
    updateStatus(id, status);
    toast.success(`Task marked as ${status.replace("_", " ")}`);
  }

  function handleDelete(id: string) {
    if (!confirm("Delete this task?")) return;
    deleteTask(id);
    toast.success("Task deleted");
  }

  return (
    <div className="mx-auto max-w-[1600px] space-y-8">
      {/* Header */}
      <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <PillBadge>Get it done</PillBadge>
          <h1 className="mt-4 text-balance text-4xl font-bold tracking-tight md:text-5xl">Tasks</h1>
          <p className="mt-2 text-sm text-fg-muted md:text-base">
            Assign work, set deadlines, and ship.
          </p>
        </div>
        <button
          onClick={() => setModalOpen(true)}
          className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-primary-fg shadow-[0_0_30px_rgb(182_244_37_/_var(--glow-shadow-opacity))] transition-transform hover:scale-[1.02] active:scale-95"
        >
          <Plus className="h-4 w-4" aria-hidden="true" /> New task
        </button>
      </header>

      {/* Filters + view toggle */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <SegmentedToggle
          value={filter}
          onChange={(v) => setFilter(v as typeof filter)}
          options={[
            { key: "all", label: "All", count: tasks.length },
            {
              key: "mine",
              label: "Assigned to me",
              count: tasks.filter((t) => t.assignedTo === currentUser?.id).length,
            },
            {
              key: "assigned-by-me",
              label: "Created by me",
              count: tasks.filter((t) => t.assignedBy === currentUser?.id).length,
            },
          ]}
        />

        <SegmentedToggle
          value={view}
          onChange={(v) => setView(v as typeof view)}
          options={[
            { key: "board", label: "Board", icon: LayoutGrid },
            { key: "list", label: "List", icon: LayoutList },
          ]}
        />
      </div>

      {/* Content */}
      {filtered.length === 0 ? (
        <div className="rounded-2xl border border-border bg-surface">
          <EmptyState
            icon={CheckSquare}
            title={tasks.length === 0 ? "No tasks yet" : "No tasks match this filter"}
            description={
              tasks.length === 0
                ? "Create your first task to start coordinating work across your team."
                : "Switch filters or create a new task."
            }
            action={
              <button
                onClick={() => setModalOpen(true)}
                className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-primary-fg shadow-[0_0_30px_rgb(182_244_37_/_var(--glow-shadow-opacity))] transition-transform hover:scale-[1.02] active:scale-95"
              >
                <Plus className="h-4 w-4" aria-hidden="true" /> Create task
              </button>
            }
          />
        </div>
      ) : view === "board" ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {COLUMNS.map((col) => {
            const toneText =
              col.tone === "cyan"
                ? "text-cyan-strong"
                : col.tone === "pink"
                  ? "text-pink-strong"
                  : "text-primary-strong";
            const toneFill =
              col.tone === "cyan"
                ? "bg-cyan/10"
                : col.tone === "pink"
                  ? "bg-pink/10"
                  : "bg-primary/10";
            return (
              <section
                key={col.status}
                aria-label={col.title}
                className="space-y-3 rounded-2xl border border-border bg-surface p-4"
              >
                <div className="flex items-center justify-between px-1">
                  <div className="flex items-center gap-2">
                    <div
                      className={cn(
                        "flex h-7 w-7 items-center justify-center rounded-lg",
                        toneFill
                      )}
                    >
                      <col.icon className={cn("h-3.5 w-3.5", toneText)} aria-hidden="true" />
                    </div>
                    <h3 className="text-sm font-semibold">{col.title}</h3>
                  </div>
                  <span className="rounded-full bg-bg px-2 py-0.5 font-mono text-[10px] font-bold text-fg-muted">
                    {grouped[col.status].length}
                  </span>
                </div>
                <div className="min-h-[180px] space-y-2.5">
                  {grouped[col.status].length === 0 ? (
                    <div className="rounded-xl border-2 border-dashed border-border p-6 text-center">
                      <p className="font-mono text-[10px] uppercase tracking-[0.15em] text-fg-muted">
                        Nothing here
                      </p>
                    </div>
                  ) : (
                    grouped[col.status].map((task) => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        onStatusChange={handleStatusChange}
                        onDelete={handleDelete}
                        canDelete={
                          currentUser?.id === task.assignedBy || currentUser?.role === "admin"
                        }
                      />
                    ))
                  )}
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <section className="overflow-hidden rounded-2xl border border-border bg-surface">
          <div className="scrollbar-thin overflow-x-auto">
            <table className="w-full">
              <thead className="sticky top-0 bg-surface">
                <tr className="border-b border-border">
                  <th
                    scope="col"
                    className="px-6 py-3.5 text-left font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
                  >
                    Task
                  </th>
                  <th
                    scope="col"
                    className="px-6 py-3.5 text-left font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
                  >
                    Status
                  </th>
                  <th
                    scope="col"
                    className="px-6 py-3.5 text-left font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
                  >
                    Priority
                  </th>
                  <th
                    scope="col"
                    className="px-6 py-3.5 text-left font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
                  >
                    Assigned
                  </th>
                  <th
                    scope="col"
                    className="px-6 py-3.5 text-left font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
                  >
                    Deadline
                  </th>
                  <th scope="col" className="px-6 py-3.5">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((task) => {
                  const overdue = isPast(new Date(task.deadline)) && task.status !== "completed";
                  return (
                    <tr
                      key={task.id}
                      className="border-b border-border/60 transition-colors last:border-b-0 hover:bg-bg"
                    >
                      <td className="px-6 py-4">
                        <p className="text-sm font-medium text-fg">{task.title}</p>
                        {task.description && (
                          <p className="mt-0.5 max-w-xs truncate text-xs text-fg-muted">
                            {task.description}
                          </p>
                        )}
                      </td>
                      <td className="px-6 py-4">
                        <label htmlFor={`status-${task.id}`} className="sr-only">
                          Change status of {task.title}
                        </label>
                        <select
                          id={`status-${task.id}`}
                          value={task.status}
                          onChange={(e) =>
                            handleStatusChange(task.id, e.target.value as TaskStatus)
                          }
                          className="rounded-full border border-border bg-bg px-3 py-1 text-xs font-medium text-fg focus:border-primary/50 focus:outline-none"
                        >
                          <option value="pending">Pending</option>
                          <option value="in_progress">In progress</option>
                          <option value="completed">Completed</option>
                        </select>
                      </td>
                      <td className="px-6 py-4">
                        <span
                          className={cn(
                            "inline-flex items-center rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider",
                            PRIORITY_STYLES[task.priority]
                          )}
                        >
                          {task.priority}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-2">
                          <Avatar name={task.assignedToName} size="xs" />
                          <span className="text-sm text-fg">{task.assignedToName}</span>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <span
                          className={cn(
                            "font-mono text-xs uppercase tracking-wider",
                            overdue ? "font-bold text-danger" : "text-fg-muted"
                          )}
                        >
                          {overdue && (
                            <AlertCircle className="mr-1 inline h-3 w-3" aria-hidden="true" />
                          )}
                          {format(new Date(task.deadline), "MMM dd, yyyy")}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-right">
                        {(currentUser?.id === task.assignedBy || currentUser?.role === "admin") && (
                          <button
                            onClick={() => handleDelete(task.id)}
                            aria-label={`Delete task ${task.title}`}
                            className="rounded-lg p-1.5 text-fg-muted transition-colors hover:bg-danger/10 hover:text-danger"
                          >
                            <Trash2 className="h-4 w-4" aria-hidden="true" />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="New task"
        description="Assign work to your team"
        size="lg"
      >
        <TaskForm onClose={() => setModalOpen(false)} />
      </Modal>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* SegmentedToggle — reusable filter/view pill group                           */
/* ─────────────────────────────────────────────────────────────────────────── */

interface ToggleOption {
  key: string;
  label: string;
  count?: number;
  icon?: LucideIcon;
}

function SegmentedToggle({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (key: string) => void;
  options: ToggleOption[];
}) {
  return (
    <div className="inline-flex w-fit gap-1 rounded-full border border-border bg-bg p-1">
      {options.map((opt) => {
        const Icon = opt.icon;
        const active = value === opt.key;
        return (
          <button
            key={opt.key}
            onClick={() => onChange(opt.key)}
            aria-pressed={active}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
              active ? "bg-surface text-fg shadow-card" : "text-fg-muted hover:text-fg"
            )}
          >
            {Icon && <Icon className="h-3.5 w-3.5" aria-hidden="true" />}
            {opt.label}
            {opt.count !== undefined && (
              <span className="font-mono text-[10px] text-fg-muted">{opt.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* TaskCard — kanban card                                                       */
/* ─────────────────────────────────────────────────────────────────────────── */

function TaskCard({
  task,
  onStatusChange,
  onDelete,
  canDelete,
}: {
  task: Task;
  onStatusChange: (id: string, status: TaskStatus) => void;
  onDelete: (id: string) => void;
  canDelete: boolean;
}) {
  const deadline = new Date(task.deadline);
  const overdue = isPast(deadline) && task.status !== "completed";
  const dueToday = isToday(deadline);

  return (
    <div className="group rounded-xl border border-border bg-bg p-4 transition-colors hover:border-primary/30">
      <div className="mb-3 flex items-start justify-between gap-2">
        <span
          className={cn(
            "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider",
            PRIORITY_STYLES[task.priority]
          )}
        >
          {task.priority}
        </span>
        {canDelete && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete(task.id);
            }}
            aria-label={`Delete task ${task.title}`}
            className="rounded-md p-1 text-fg-muted opacity-0 transition-all hover:bg-danger/10 hover:text-danger group-hover:opacity-100"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
      </div>

      <h4 className="mb-1 text-sm font-semibold leading-snug text-fg">{task.title}</h4>
      {task.description && (
        <p className="mb-3 line-clamp-2 text-xs text-fg-muted">{task.description}</p>
      )}

      <div className="mb-3 flex items-center gap-1.5 text-xs">
        <Calendar
          className={cn("h-3 w-3", overdue ? "text-danger" : "text-fg-muted")}
          aria-hidden="true"
        />
        <span
          className={cn(
            "font-mono uppercase tracking-wider",
            overdue
              ? "font-bold text-danger"
              : dueToday
                ? "font-bold text-warning"
                : "text-fg-muted"
          )}
        >
          {overdue && <AlertCircle className="mr-0.5 inline h-3 w-3" aria-hidden="true" />}
          {format(deadline, "MMM dd")}
        </span>
      </div>

      <div className="flex items-center justify-between border-t border-border pt-3">
        <div className="flex items-center gap-2">
          <Avatar name={task.assignedToName} size="xs" />
          <span className="text-xs text-fg-muted">{task.assignedToName.split(" ")[0]}</span>
        </div>
        <label htmlFor={`board-status-${task.id}`} className="sr-only">
          Status of {task.title}
        </label>
        <select
          id={`board-status-${task.id}`}
          value={task.status}
          onChange={(e) => onStatusChange(task.id, e.target.value as TaskStatus)}
          onClick={(e) => e.stopPropagation()}
          className="cursor-pointer rounded-md border border-border bg-bg px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-wider text-fg focus:border-primary/50 focus:outline-none"
        >
          <option value="pending">Pending</option>
          <option value="in_progress">In progress</option>
          <option value="completed">Completed</option>
        </select>
      </div>
    </div>
  );
}
