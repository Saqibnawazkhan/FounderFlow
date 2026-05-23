"use client";

import { useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  AlertCircle,
  Calendar,
  CheckCircle2,
  CheckSquare,
  CircleDot,
  Clock,
  LayoutList,
  LayoutGrid,
  Plus,
  Trash2,
} from "lucide-react";
import toast from "react-hot-toast";
import { format, isPast, isToday } from "date-fns";
import { useStore } from "@/lib/store";
import { Modal } from "@/components/ui/modal";
import { TaskForm } from "@/components/tasks/task-form";
import { Avatar } from "@/components/ui/avatar";
import { EmptyState } from "@/components/ui/empty-state";
import { cn, formatRelativeTime } from "@/lib/utils";
import type { Task, TaskStatus, TaskPriority } from "@/lib/types";

const COLUMNS: { status: TaskStatus; title: string; icon: typeof Clock; color: string }[] = [
  { status: "pending", title: "Pending", icon: Clock, color: "from-slate-400 to-slate-500" },
  { status: "in_progress", title: "In Progress", icon: CircleDot, color: "from-blue-500 to-cyan-500" },
  { status: "completed", title: "Completed", icon: CheckCircle2, color: "from-emerald-500 to-teal-500" },
];

const PRIORITY_STYLES: Record<TaskPriority, string> = {
  urgent: "bg-red-100 dark:bg-red-500/20 text-red-700 dark:text-red-300 border-red-200 dark:border-red-500/30",
  high: "bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-500/30",
  medium: "bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-500/30",
  low: "bg-slate-100 dark:bg-slate-700/50 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-600",
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

  const grouped = useMemo(() => {
    return {
      pending: filtered.filter((t) => t.status === "pending"),
      in_progress: filtered.filter((t) => t.status === "in_progress"),
      completed: filtered.filter((t) => t.status === "completed"),
    };
  }, [filtered]);

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
    <div className="space-y-6 max-w-[1600px] mx-auto">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Tasks</h1>
          <p className="text-slate-500 dark:text-slate-400 mt-1">
            Assign work, set deadlines, and ship.
          </p>
        </div>
        <button onClick={() => setModalOpen(true)} className="btn-primary">
          <Plus className="h-4 w-4" /> New Task
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3 sm:items-center justify-between">
        <div className="flex gap-2 p-1 bg-slate-100 dark:bg-slate-800/50 rounded-xl w-fit">
          {[
            { key: "all", label: "All Tasks", count: tasks.length },
            { key: "mine", label: "Assigned to me", count: tasks.filter((t) => t.assignedTo === currentUser?.id).length },
            { key: "assigned-by-me", label: "Created by me", count: tasks.filter((t) => t.assignedBy === currentUser?.id).length },
          ].map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key as typeof filter)}
              className={cn(
                "px-3 py-1.5 rounded-lg text-sm font-medium transition flex items-center gap-1.5",
                filter === f.key
                  ? "bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow"
                  : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100"
              )}
            >
              {f.label}
              <span className="text-xs opacity-60">{f.count}</span>
            </button>
          ))}
        </div>

        <div className="flex gap-2 p-1 bg-slate-100 dark:bg-slate-800/50 rounded-xl w-fit">
          <button
            onClick={() => setView("board")}
            className={cn(
              "px-3 py-1.5 rounded-lg text-sm font-medium transition flex items-center gap-1.5",
              view === "board" ? "bg-white dark:bg-slate-700 shadow" : "text-slate-600 dark:text-slate-400"
            )}
          >
            <LayoutGrid className="h-3.5 w-3.5" />
            Board
          </button>
          <button
            onClick={() => setView("list")}
            className={cn(
              "px-3 py-1.5 rounded-lg text-sm font-medium transition flex items-center gap-1.5",
              view === "list" ? "bg-white dark:bg-slate-700 shadow" : "text-slate-600 dark:text-slate-400"
            )}
          >
            <LayoutList className="h-3.5 w-3.5" />
            List
          </button>
        </div>
      </div>

      {/* Content */}
      {filtered.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={CheckSquare}
            title={tasks.length === 0 ? "No tasks yet" : "No tasks match this filter"}
            description={
              tasks.length === 0
                ? "Create your first task to start coordinating work across your team."
                : "Switch filters or create a new task."
            }
            action={
              <button onClick={() => setModalOpen(true)} className="btn-primary">
                <Plus className="h-4 w-4" /> Create task
              </button>
            }
          />
        </div>
      ) : view === "board" ? (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {COLUMNS.map((col) => (
            <div key={col.status} className="space-y-3">
              <div className="flex items-center justify-between px-1">
                <div className="flex items-center gap-2">
                  <div className={cn("h-7 w-7 rounded-lg bg-gradient-to-br flex items-center justify-center text-white", col.color)}>
                    <col.icon className="h-3.5 w-3.5" />
                  </div>
                  <h3 className="font-semibold text-sm">{col.title}</h3>
                  <span className="badge-default">{grouped[col.status].length}</span>
                </div>
              </div>
              <div className="space-y-3 min-h-[200px]">
                <AnimatePresence>
                  {grouped[col.status].length === 0 ? (
                    <div className="rounded-xl border-2 border-dashed border-slate-200 dark:border-slate-800 p-6 text-center">
                      <p className="text-xs text-slate-400">No tasks here</p>
                    </div>
                  ) : (
                    grouped[col.status].map((task) => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        onStatusChange={handleStatusChange}
                        onDelete={handleDelete}
                        canDelete={currentUser?.id === task.assignedBy || currentUser?.role === "admin"}
                      />
                    ))
                  )}
                </AnimatePresence>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto scrollbar-thin">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-left">
                  <th className="px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Task</th>
                  <th className="px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Status</th>
                  <th className="px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Priority</th>
                  <th className="px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Assigned</th>
                  <th className="px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Deadline</th>
                  <th className="px-6 py-3" />
                </tr>
              </thead>
              <tbody>
                {filtered.map((task) => {
                  const overdue = isPast(new Date(task.deadline)) && task.status !== "completed";
                  return (
                    <tr key={task.id} className="border-b border-slate-100 dark:border-slate-800/50 hover:bg-slate-50 dark:hover:bg-slate-800/30 transition">
                      <td className="px-6 py-4">
                        <p className="font-medium text-sm">{task.title}</p>
                        {task.description && (
                          <p className="text-xs text-slate-500 mt-0.5 truncate max-w-xs">{task.description}</p>
                        )}
                      </td>
                      <td className="px-6 py-4">
                        <select
                          value={task.status}
                          onChange={(e) => handleStatusChange(task.id, e.target.value as TaskStatus)}
                          className="text-xs font-medium px-2.5 py-1 rounded-full bg-slate-100 dark:bg-slate-800 border-0 focus:outline-none"
                        >
                          <option value="pending">Pending</option>
                          <option value="in_progress">In Progress</option>
                          <option value="completed">Completed</option>
                        </select>
                      </td>
                      <td className="px-6 py-4">
                        <span className={cn("badge border", PRIORITY_STYLES[task.priority])}>
                          {task.priority}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-2">
                          <Avatar name={task.assignedToName} size="xs" />
                          <span className="text-sm">{task.assignedToName}</span>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <span className={cn("text-sm", overdue ? "text-red-600 dark:text-red-400 font-medium" : "text-slate-500")}>
                          {format(new Date(task.deadline), "MMM dd, yyyy")}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-right">
                        {(currentUser?.id === task.assignedBy || currentUser?.role === "admin") && (
                          <button
                            onClick={() => handleDelete(task.id)}
                            className="p-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-500/10 text-slate-400 hover:text-red-500 transition"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="New task" description="Assign work to your team" size="lg">
        <TaskForm onClose={() => setModalOpen(false)} />
      </Modal>
    </div>
  );
}

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
    <motion.div
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.2 }}
      className="group card p-4 cursor-pointer hover:shadow-card-hover"
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <span className={cn("badge border text-[10px] uppercase", PRIORITY_STYLES[task.priority])}>
          {task.priority}
        </span>
        {canDelete && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete(task.id);
            }}
            className="opacity-0 group-hover:opacity-100 p-1 rounded-md hover:bg-red-50 dark:hover:bg-red-500/10 text-slate-400 hover:text-red-500 transition"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <h4 className="font-semibold text-sm mb-1 leading-snug">{task.title}</h4>
      {task.description && (
        <p className="text-xs text-slate-500 mb-3 line-clamp-2">{task.description}</p>
      )}

      <div className="flex items-center justify-between text-xs mb-3">
        <div className="flex items-center gap-1.5">
          <Calendar className={cn("h-3 w-3", overdue ? "text-red-500" : "text-slate-400")} />
          <span className={cn(overdue ? "text-red-600 dark:text-red-400 font-medium" : dueToday ? "text-amber-600 dark:text-amber-400 font-medium" : "text-slate-500")}>
            {overdue && <AlertCircle className="h-3 w-3 inline mr-0.5" />}
            {format(deadline, "MMM dd")}
          </span>
        </div>
      </div>

      <div className="flex items-center justify-between pt-3 border-t border-slate-100 dark:border-slate-800">
        <div className="flex items-center gap-2">
          <Avatar name={task.assignedToName} size="xs" />
          <span className="text-xs text-slate-600 dark:text-slate-400">{task.assignedToName.split(" ")[0]}</span>
        </div>
        <select
          value={task.status}
          onChange={(e) => onStatusChange(task.id, e.target.value as TaskStatus)}
          onClick={(e) => e.stopPropagation()}
          className="text-[10px] font-medium px-2 py-1 rounded-md bg-slate-100 dark:bg-slate-800 border-0 focus:outline-none cursor-pointer"
        >
          <option value="pending">Pending</option>
          <option value="in_progress">In Progress</option>
          <option value="completed">Completed</option>
        </select>
      </div>
    </motion.div>
  );
}
