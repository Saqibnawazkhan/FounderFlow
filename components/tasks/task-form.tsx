"use client";

import { useState } from "react";
import toast from "react-hot-toast";
import { useStore } from "@/lib/store";
import type { TaskPriority, TaskStatus } from "@/lib/types";

interface Props {
  onClose: () => void;
}

const PRIORITIES: { value: TaskPriority; label: string; color: string }[] = [
  { value: "low", label: "Low", color: "bg-slate-400" },
  { value: "medium", label: "Medium", color: "bg-blue-500" },
  { value: "high", label: "High", color: "bg-amber-500" },
  { value: "urgent", label: "Urgent", color: "bg-red-500" },
];

export function TaskForm({ onClose }: Props) {
  const addTask = useStore((s) => s.addTask);
  const users = useStore((s) => s.getCompanyUsers());
  const currentUser = useStore((s) => s.currentUser);

  const [form, setForm] = useState({
    title: "",
    description: "",
    assignedTo: currentUser?.id || "",
    priority: "medium" as TaskPriority,
    status: "pending" as TaskStatus,
    deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  });
  const [loading, setLoading] = useState(false);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.title.trim()) {
      toast.error("Please add a task title");
      return;
    }
    const assignee = users.find((u) => u.id === form.assignedTo);
    if (!assignee) {
      toast.error("Please select an assignee");
      return;
    }
    setLoading(true);
    addTask({
      title: form.title.trim(),
      description: form.description.trim(),
      assignedTo: assignee.id,
      assignedToName: assignee.name,
      priority: form.priority,
      status: form.status,
      deadline: new Date(form.deadline).toISOString(),
    });
    toast.success("Task created");
    setLoading(false);
    onClose();
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="label">Title</label>
        <input
          value={form.title}
          onChange={(e) => setForm({ ...form, title: e.target.value })}
          className="input"
          placeholder="What needs to be done?"
          autoFocus
        />
      </div>

      <div>
        <label className="label">Description (optional)</label>
        <textarea
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          className="input min-h-[80px] resize-none"
          placeholder="Add more context..."
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">Assigned To</label>
          <select
            value={form.assignedTo}
            onChange={(e) => setForm({ ...form, assignedTo: e.target.value })}
            className="input"
          >
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} {u.id === currentUser?.id ? "(you)" : ""}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Deadline</label>
          <input
            type="date"
            value={form.deadline}
            onChange={(e) => setForm({ ...form, deadline: e.target.value })}
            className="input"
            min={new Date().toISOString().slice(0, 10)}
          />
        </div>
      </div>

      <div>
        <label className="label">Priority</label>
        <div className="grid grid-cols-4 gap-2">
          {PRIORITIES.map((p) => (
            <button
              key={p.value}
              type="button"
              onClick={() => setForm({ ...form, priority: p.value })}
              className={`px-3 py-2.5 rounded-xl border text-sm font-medium transition-all ${
                form.priority === p.value
                  ? "border-brand-500 bg-brand-50 dark:bg-brand-500/10 text-brand-700 dark:text-brand-300 shadow-md"
                  : "border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600"
              }`}
            >
              <div className="flex items-center justify-center gap-2">
                <div className={`h-2 w-2 rounded-full ${p.color}`} />
                {p.label}
              </div>
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="label">Initial Status</label>
        <div className="grid grid-cols-3 gap-2">
          {[
            { value: "pending", label: "Pending" },
            { value: "in_progress", label: "In Progress" },
            { value: "completed", label: "Completed" },
          ].map((s) => (
            <button
              key={s.value}
              type="button"
              onClick={() => setForm({ ...form, status: s.value as TaskStatus })}
              className={`px-3 py-2 rounded-xl border text-sm font-medium transition-all ${
                form.status === s.value
                  ? "border-brand-500 bg-brand-50 dark:bg-brand-500/10 text-brand-700 dark:text-brand-300"
                  : "border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex gap-3 pt-2">
        <button type="button" onClick={onClose} className="btn-secondary flex-1">
          Cancel
        </button>
        <button type="submit" disabled={loading} className="btn-primary flex-1">
          {loading ? "Creating..." : "Create Task"}
        </button>
      </div>
    </form>
  );
}
