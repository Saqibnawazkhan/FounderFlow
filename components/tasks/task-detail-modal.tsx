"use client";

/**
 * <TaskDetailModal> — full-fidelity read of one task.
 *
 * Motivation: kanban cards line-clamp the description to two lines and the
 * list view hides most fields, so there was no in-app way to read a task's
 * full body. Users were left with the awkward "hover to show title tooltip"
 * fallback, which cuts off at ~80 chars.
 *
 * What it shows:
 *   - Title (never clamped) + priority + status + due-date badges
 *   - Full description with `whitespace-pre-wrap` so bullet lists, code,
 *     and multi-paragraph bodies render intact
 *   - Assignee, assigner, project, created-at
 *   - Inline comment thread (lazy-loaded via `listCommentsAction`)
 *   - Delete action for the author or an admin
 *   - Status changer so users can flip status without closing first
 *
 * Callers: TasksClient (both kanban card + list row) and the project
 * detail page's task list. The modal owns nothing beyond the comment
 * fetch — status change and delete route through the parent's handlers
 * so all list/board views stay in sync.
 */

import { useEffect, useState } from "react";
import { format, isPast, isToday } from "date-fns";
import {
  AlertCircle,
  AlertOctagon,
  ArrowDown,
  ArrowUp,
  Briefcase,
  Calendar,
  CheckCircle2,
  Clock,
  Loader2,
  Minus,
  Trash2,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import toast from "react-hot-toast";
import { Modal } from "@/components/ui/modal";
import { Avatar } from "@/components/ui/avatar";
import { CommentThread } from "@/components/comments/comment-thread";
import { listCommentsAction } from "@/lib/actions/comments";
import { cn } from "@/lib/utils";
import type { CommentClient } from "@/lib/queries/comments";
import type { MentionUser } from "@/lib/comments/mentions";
import type { TaskWithCount } from "@/lib/queries/tasks";
import type { TaskPriority, TaskStatus } from "@/lib/types";

const PRIORITY_STYLES: Record<TaskPriority, string> = {
  urgent: "border-danger/30 bg-danger/10 text-danger",
  high: "border-warning/30 bg-warning/10 text-warning",
  medium: "border-info/30 bg-info/10 text-info",
  low: "border-border bg-bg text-fg-muted",
};

const PRIORITY_ICONS: Record<TaskPriority, LucideIcon> = {
  urgent: AlertOctagon,
  high: ArrowUp,
  medium: Minus,
  low: ArrowDown,
};

const STATUS_STYLES: Record<TaskStatus, string> = {
  pending: "border-pink/30 bg-pink/10 text-pink-strong",
  in_progress: "border-cyan/30 bg-cyan/10 text-cyan-strong",
  completed: "border-primary/30 bg-primary/10 text-primary-strong",
};

const STATUS_ICONS: Record<TaskStatus, LucideIcon> = {
  pending: Clock,
  in_progress: Clock,
  completed: CheckCircle2,
};

type Props = {
  task: TaskWithCount;
  open: boolean;
  onClose: () => void;
  currentUserId: string;
  currentUserRole: "admin" | "cofounder" | "member";
  companyUsers: MentionUser[];
  canDelete: boolean;
  onStatusChange: (id: string, status: TaskStatus) => void;
  onDelete: (id: string) => void;
  /** Called after a comment is posted/deleted so the parent list can bump
   * its cached commentCount + refresh the RSC. */
  onCommentsChanged?: () => void;
};

export function TaskDetailModal({
  task,
  open,
  onClose,
  currentUserId,
  currentUserRole,
  companyUsers,
  canDelete,
  onStatusChange,
  onDelete,
  onCommentsChanged,
}: Props) {
  const [comments, setComments] = useState<CommentClient[] | null>(null);
  const [commentsError, setCommentsError] = useState<string | null>(null);

  // Lazy-load the comment thread when the modal opens. Refires when the
  // active task changes so switching between cards without closing the
  // modal (potential future UX) doesn't show stale threads.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setComments(null);
    setCommentsError(null);
    listCommentsAction({ taskId: task.id }).then((res) => {
      if (cancelled) return;
      if (res.success) setComments(res.data);
      else setCommentsError(res.error);
    });
    return () => {
      cancelled = true;
    };
  }, [open, task.id]);

  async function refreshComments() {
    onCommentsChanged?.();
    const res = await listCommentsAction({ taskId: task.id });
    if (res.success) setComments(res.data);
    else toast.error(res.error);
  }

  const deadline = new Date(task.deadline);
  const overdue = isPast(deadline) && task.status !== "completed";
  const dueToday = isToday(deadline);

  const PriorityIcon = PRIORITY_ICONS[task.priority];
  const StatusIcon = STATUS_ICONS[task.status];

  return (
    <Modal open={open} onClose={onClose} title={task.title} size="lg">
      <div className="space-y-6">
        {/* Metadata row — priority + status + due + delete */}
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider",
              PRIORITY_STYLES[task.priority]
            )}
          >
            <PriorityIcon className="h-3 w-3" aria-hidden="true" />
            {task.priority}
          </span>
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider",
              STATUS_STYLES[task.status]
            )}
          >
            <StatusIcon className="h-3 w-3" aria-hidden="true" />
            {task.status.replace("_", " ")}
          </span>
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider",
              overdue
                ? "border-danger/30 bg-danger/10 font-bold text-danger"
                : dueToday
                  ? "border-warning/30 bg-warning/10 font-bold text-warning"
                  : "border-border bg-bg text-fg-muted"
            )}
          >
            {overdue ? (
              <AlertCircle className="h-3 w-3" aria-hidden="true" />
            ) : (
              <Calendar className="h-3 w-3" aria-hidden="true" />
            )}
            {format(deadline, "MMM dd, yyyy")}
            {overdue && " · overdue"}
            {dueToday && !overdue && " · today"}
          </span>

          {/* Status changer — same list the card exposes, but positioned to
              feel like a primary CTA inside the modal. */}
          <label className="sr-only" htmlFor={`detail-status-${task.id}`}>
            Change status
          </label>
          <select
            id={`detail-status-${task.id}`}
            value={task.status}
            onChange={(e) => onStatusChange(task.id, e.target.value as TaskStatus)}
            className="ml-auto cursor-pointer rounded-full border border-border bg-bg px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-wider text-fg transition-colors hover:bg-surface-hover focus:border-primary/50 focus:outline-none"
          >
            <option value="pending">Pending</option>
            <option value="in_progress">In progress</option>
            <option value="completed">Completed</option>
          </select>
          {canDelete && (
            <button
              type="button"
              onClick={() => {
                onDelete(task.id);
                onClose();
              }}
              aria-label={`Delete task ${task.title}`}
              className="inline-flex items-center gap-1 rounded-full border border-danger/30 bg-danger/10 px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-danger transition-colors hover:bg-danger/20"
            >
              <Trash2 className="h-3 w-3" aria-hidden="true" />
              Delete
            </button>
          )}
        </div>

        {/* Description — always shown, even when empty, so the section
            structure feels stable across tasks. */}
        <section aria-label="Description">
          <h3 className="mb-2 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted">
            Description
          </h3>
          {task.description ? (
            <p className="whitespace-pre-wrap break-words text-sm text-fg">{task.description}</p>
          ) : (
            <p className="text-sm italic text-fg-muted">No description provided.</p>
          )}
        </section>

        {/* People + project metadata */}
        <section
          aria-label="Task metadata"
          className="grid gap-4 rounded-xl border border-border bg-bg/40 p-4 sm:grid-cols-2"
        >
          <MetaRow icon={UserPlus} label="Assigned to" value={task.assignedToName} />
          <MetaRow icon={Avatar} label="Added by" value={task.assignedByName} avatar />
          {task.projectName && task.projectId && (
            <MetaRow
              icon={Briefcase}
              label="Project"
              value={
                <Link
                  href={`/projects/${task.projectId}`}
                  className="font-semibold text-primary-strong hover:underline"
                  onClick={onClose}
                >
                  {task.projectName}
                </Link>
              }
            />
          )}
          <MetaRow
            icon={Clock}
            label="Created"
            value={format(new Date(task.createdAt), "MMM dd, yyyy")}
          />
        </section>

        {/* Comments — the same thread users get from the standalone comment
            modal, embedded so a task's full context lives in one place. */}
        <section aria-label="Comments">
          <h3 className="mb-3 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted">
            Comments {task.commentCount > 0 && `(${task.commentCount})`}
          </h3>
          {commentsError ? (
            <div className="rounded-xl border border-danger/30 bg-danger/10 p-4 text-sm text-danger">
              {commentsError}
            </div>
          ) : comments === null ? (
            <div className="flex items-center justify-center gap-2 py-6 text-sm text-fg-muted">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Loading conversation…
            </div>
          ) : (
            <CommentThread
              target={{ taskId: task.id }}
              initialComments={comments}
              currentUserId={currentUserId}
              currentUserRole={currentUserRole}
              companyUsers={companyUsers}
              onChanged={refreshComments}
            />
          )}
        </section>
      </div>
    </Modal>
  );
}

function MetaRow({
  icon: Icon,
  label,
  value,
  avatar = false,
}: {
  icon: LucideIcon | typeof Avatar;
  label: string;
  value: React.ReactNode;
  avatar?: boolean;
}) {
  return (
    <div className="flex items-center gap-3">
      {avatar && typeof value === "string" ? (
        <Avatar name={value} size="sm" />
      ) : (
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-glass/[0.06] text-fg-muted">
          {/* Icon prop is a Lucide component in this branch. */}
          {(() => {
            const AsIcon = Icon as LucideIcon;
            return <AsIcon className="h-4 w-4" aria-hidden="true" />;
          })()}
        </span>
      )}
      <div className="min-w-0">
        <p className="font-mono text-[10px] uppercase tracking-wider text-fg-muted">{label}</p>
        <div className="text-sm font-medium text-fg">{value}</div>
      </div>
    </div>
  );
}
