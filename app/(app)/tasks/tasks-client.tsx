"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  Calendar,
  CheckCircle2,
  CheckSquare,
  CircleDot,
  Clock,
  GripVertical,
  LayoutGrid,
  LayoutList,
  Plus,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import toast from "react-hot-toast";
import { format, isPast, isToday } from "date-fns";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { deleteTaskAction, updateTaskStatusAction } from "@/lib/actions/tasks";
import { Modal } from "@/components/ui/modal";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { TaskForm } from "@/components/tasks/task-form";
import { Avatar } from "@/components/ui/avatar";
import { EmptyState } from "@/components/ui/empty-state";
import { PillBadge } from "@/components/landing/pill-badge";
import { cn } from "@/lib/utils";
import type { Task, TaskStatus, TaskPriority, User } from "@/lib/types";

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

type Props = {
  initialTasks: Task[];
  users: User[];
  currentUserId: string;
  currentUserRole: "admin" | "cofounder" | "member";
};

export function TasksClient({ initialTasks, users, currentUserId, currentUserRole }: Props) {
  const router = useRouter();
  const confirm = useConfirm();
  const [, startTransition] = useTransition();

  // Optimistic local copy of the task list. Seeded from the RSC prop, then
  // mutated in place for snappy DnD updates. router.refresh() in the parent
  // re-runs the server query and arrives back here as `initialTasks`; we
  // resync via the effect below.
  const [tasks, setTasks] = useState<Task[]>(initialTasks);
  useEffect(() => {
    setTasks(initialTasks);
  }, [initialTasks]);

  function refresh() {
    startTransition(() => router.refresh());
  }

  const [modalOpen, setModalOpen] = useState(false);
  const [view, setView] = useState<"board" | "list">("board");
  const [filter, setFilter] = useState<"all" | "mine" | "assigned-by-me">("all");

  const filtered = useMemo(() => {
    if (filter === "mine") return tasks.filter((t) => t.assignedTo === currentUserId);
    if (filter === "assigned-by-me") return tasks.filter((t) => t.assignedBy === currentUserId);
    return tasks;
  }, [tasks, filter, currentUserId]);

  const grouped = useMemo(
    () => ({
      pending: filtered.filter((t) => t.status === "pending"),
      in_progress: filtered.filter((t) => t.status === "in_progress"),
      completed: filtered.filter((t) => t.status === "completed"),
    }),
    [filtered]
  );

  async function handleStatusChange(id: string, status: TaskStatus) {
    const result = await updateTaskStatusAction({ id, status });
    if (!result.success) {
      toast.error(result.error);
      return;
    }
    toast.success(`Task marked as ${status.replace("_", " ")}`);
    refresh();
  }

  async function handleDelete(id: string) {
    const ok = await confirm({
      title: "Delete this task?",
      description: "This action cannot be undone.",
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!ok) return;
    const result = await deleteTaskAction(id);
    if (!result.success) {
      toast.error(result.error);
      return;
    }
    toast.success("Task deleted");
    refresh();
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor)
  );

  const [draggingTask, setDraggingTask] = useState<Task | null>(null);

  function handleDragStart(e: DragStartEvent) {
    const t = tasks.find((x) => x.id === e.active.id);
    if (t) setDraggingTask(t);
  }

  function handleDragEnd(e: DragEndEvent) {
    setDraggingTask(null);
    const taskId = String(e.active.id);
    const overStatus = e.over?.id as TaskStatus | undefined;
    if (!overStatus) return;
    const task = tasks.find((t) => t.id === taskId);
    if (!task || task.status === overStatus) return;
    // Optimistic — paint the new column instantly, then fire-and-roll-back.
    setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, status: overStatus } : t)));
    void updateTaskStatusAction({ id: taskId, status: overStatus }).then((res) => {
      if (!res.success) {
        toast.error(res.error);
        refresh();
      }
    });
  }

  return (
    <div className="mx-auto max-w-[1600px] space-y-8">
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

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <SegmentedToggle
          value={filter}
          onChange={(v) => setFilter(v as typeof filter)}
          options={[
            { key: "all", label: "All", count: tasks.length },
            {
              key: "mine",
              label: "Assigned to me",
              count: tasks.filter((t) => t.assignedTo === currentUserId).length,
            },
            {
              key: "assigned-by-me",
              label: "Created by me",
              count: tasks.filter((t) => t.assignedBy === currentUserId).length,
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
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setDraggingTask(null)}
        >
          <div className="-mx-4 flex snap-x snap-mandatory gap-4 overflow-x-auto px-4 pb-2 md:mx-0 md:grid md:grid-cols-3 md:overflow-visible md:px-0">
            {COLUMNS.map((col) => (
              <div key={col.status} className="w-[85vw] shrink-0 snap-center md:w-auto md:shrink">
                <DroppableColumn
                  column={col}
                  tasks={grouped[col.status]}
                  onStatusChange={handleStatusChange}
                  onDelete={handleDelete}
                  canDeleteTask={(task) =>
                    currentUserId === task.assignedBy || currentUserRole === "admin"
                  }
                  isDragActive={draggingTask !== null}
                />
              </div>
            ))}
          </div>
          <DragOverlay dropAnimation={null}>
            {draggingTask && (
              <TaskCard
                task={draggingTask}
                onStatusChange={handleStatusChange}
                onDelete={handleDelete}
                canDelete={false}
                isDragging
              />
            )}
          </DragOverlay>
        </DndContext>
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
                        {(currentUserId === task.assignedBy || currentUserRole === "admin") && (
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
        <TaskForm
          users={users}
          currentUserId={currentUserId}
          onClose={() => setModalOpen(false)}
          onSuccess={refresh}
        />
      </Modal>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* SegmentedToggle                                                            */
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
/* DroppableColumn                                                            */
/* ─────────────────────────────────────────────────────────────────────────── */

function DroppableColumn({
  column,
  tasks,
  onStatusChange,
  onDelete,
  canDeleteTask,
  isDragActive,
}: {
  column: Column;
  tasks: Task[];
  onStatusChange: (id: string, status: TaskStatus) => void;
  onDelete: (id: string) => void;
  canDeleteTask: (task: Task) => boolean;
  isDragActive: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: column.status });

  const toneText =
    column.tone === "cyan"
      ? "text-cyan-strong"
      : column.tone === "pink"
        ? "text-pink-strong"
        : "text-primary-strong";
  const toneFill =
    column.tone === "cyan" ? "bg-cyan/10" : column.tone === "pink" ? "bg-pink/10" : "bg-primary/10";

  return (
    <section
      ref={setNodeRef}
      aria-label={column.title}
      className={cn(
        "space-y-3 rounded-2xl border bg-surface p-4 transition-colors",
        isOver ? "border-primary/60 bg-primary/[0.04]" : "border-border",
        isDragActive && !isOver && "border-dashed"
      )}
    >
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-2">
          <div className={cn("flex h-7 w-7 items-center justify-center rounded-lg", toneFill)}>
            <column.icon className={cn("h-3.5 w-3.5", toneText)} aria-hidden="true" />
          </div>
          <h3 className="text-sm font-semibold">{column.title}</h3>
        </div>
        <span className="rounded-full bg-bg px-2 py-0.5 font-mono text-[10px] font-bold text-fg-muted">
          {tasks.length}
        </span>
      </div>
      <div className="min-h-[180px] space-y-2.5">
        {tasks.length === 0 ? (
          <div
            className={cn(
              "rounded-xl border-2 border-dashed p-6 text-center transition-colors",
              isOver ? "border-primary/60 bg-primary/[0.04]" : "border-border"
            )}
          >
            <p className="font-mono text-[10px] uppercase tracking-[0.15em] text-fg-muted">
              {isOver ? "Drop to move" : "Nothing here"}
            </p>
          </div>
        ) : (
          tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              onStatusChange={onStatusChange}
              onDelete={onDelete}
              canDelete={canDeleteTask(task)}
            />
          ))
        )}
      </div>
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* TaskCard                                                                    */
/* ─────────────────────────────────────────────────────────────────────────── */

function TaskCard({
  task,
  onStatusChange,
  onDelete,
  canDelete,
  isDragging: isOverlay = false,
}: {
  task: Task;
  onStatusChange: (id: string, status: TaskStatus) => void;
  onDelete: (id: string) => void;
  canDelete: boolean;
  isDragging?: boolean;
}) {
  const { attributes, listeners, setNodeRef, isDragging, transform } = useDraggable({
    id: task.id,
    disabled: isOverlay,
  });

  const deadline = new Date(task.deadline);
  const overdue = isPast(deadline) && task.status !== "completed";
  const dueToday = isToday(deadline);

  const style: React.CSSProperties = isOverlay
    ? { boxShadow: "0 20px 50px rgb(0 0 0 / 0.30)", transform: "rotate(-1.5deg)" }
    : transform
      ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
      : {};

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "group rounded-xl border border-border bg-bg p-4 transition-colors hover:border-primary/30",
        isDragging && !isOverlay && "opacity-30",
        isOverlay && "cursor-grabbing border-primary/40 bg-surface"
      )}
    >
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5">
          {!isOverlay && (
            <button
              type="button"
              aria-label={`Drag ${task.title} to change status`}
              {...attributes}
              {...listeners}
              className="cursor-grab touch-none rounded-md p-0.5 text-fg-muted/70 transition-colors hover:bg-glass/[0.06] hover:text-fg active:cursor-grabbing"
            >
              <GripVertical className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          )}
          <span
            className={cn(
              "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider",
              PRIORITY_STYLES[task.priority]
            )}
          >
            {task.priority}
          </span>
        </div>
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
