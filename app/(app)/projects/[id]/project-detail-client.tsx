"use client";

/**
 * /projects/[id] client. Shows the project header (name, supervisor, status,
 * actions), three KPI cards, and the lists of tasks + budgets that belong
 * to this project. Each section embeds the same data shapes the global
 * /tasks and /budgets pages use — we just filtered them by projectId in
 * the RSC.
 *
 * Mutations:
 *   - Edit project / archive  → admin / cofounder / supervisor
 *   - Change supervisor       → admin / cofounder
 *   - Delete project          → admin / cofounder / supervisor, blocked if
 *                               the project still has tasks/budgets
 */

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  Archive,
  ArchiveRestore,
  Briefcase,
  Clock,
  Pencil,
  Trash2,
  UserCog,
  Users,
  Wallet,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import toast from "react-hot-toast";
import Link from "next/link";
import { Avatar } from "@/components/ui/avatar";
import { PillBadge } from "@/components/landing/pill-badge";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { deleteProjectAction, updateProjectAction } from "@/lib/actions/projects";
import { canManageProject, canReassignSupervisor } from "@/lib/auth/project-permissions";
import type { Role } from "@/lib/auth/role-gates";
import { formatCurrency, formatDate, cn } from "@/lib/utils";
import { formatDuration } from "@/lib/time/thresholds";
import { useT } from "@/lib/i18n/use-t";
import type { ProjectOverview } from "@/lib/queries/projects";
import type { TaskWithCount } from "@/lib/queries/tasks";
import type { BudgetWithSpend } from "@/lib/queries/budgets";
import type { User } from "@/lib/types";
import { TaskDetailModal } from "@/components/tasks/task-detail-modal";
import { deleteTaskAction, updateTaskStatusAction } from "@/lib/actions/tasks";
import type { TaskStatus } from "@/lib/types";
import { EditProjectModal } from "./edit-project-modal";
import { ChangeSupervisorModal } from "./change-supervisor-modal";

type Props = {
  project: ProjectOverview;
  tasks: TaskWithCount[];
  budgets: BudgetWithSpend[];
  users: User[];
  canSeeBudgets: boolean;
  currentUserId: string;
  currentUserRole: Role;
};

const COLOR_STRIPE: Record<string, string> = {
  primary: "bg-primary",
  cyan: "bg-cyan",
  pink: "bg-pink",
  warning: "bg-warning",
  info: "bg-info",
};

const STATUS_CLASSES: Record<string, string> = {
  active: "border-primary/30 bg-primary/10 text-primary-strong",
  on_hold: "border-warning/30 bg-warning/10 text-warning",
  completed: "border-cyan/30 bg-cyan/10 text-cyan-strong",
  archived: "border-border bg-bg/40 text-fg-muted",
};

export function ProjectDetailClient({
  project,
  tasks,
  budgets,
  users,
  canSeeBudgets,
  currentUserId,
  currentUserRole,
}: Props) {
  const t = useT();
  const router = useRouter();
  const confirm = useConfirm();
  const [, startTransition] = useTransition();

  const canManage = canManageProject({
    userId: currentUserId,
    role: currentUserRole,
    project: { supervisorId: project.supervisorId },
  });
  const canReassign = canReassignSupervisor(currentUserRole);

  const [editOpen, setEditOpen] = useState(false);
  const [supOpen, setSupOpen] = useState(false);
  // Clicking any task row on this page opens the shared TaskDetailModal —
  // same component the /tasks page uses so the "read a task's full body"
  // affordance is identical everywhere.
  const [detailTask, setDetailTask] = useState<TaskWithCount | null>(null);
  useEffect(() => {
    if (!detailTask) return;
    const fresh = tasks.find((t) => t.id === detailTask.id);
    if (fresh && fresh !== detailTask) setDetailTask(fresh);
  }, [tasks, detailTask]);
  const mentionUsers = useMemo(() => users.map((u) => ({ id: u.id, name: u.name })), [users]);

  function refresh() {
    startTransition(() => router.refresh());
  }

  async function handleTaskStatusChange(id: string, status: TaskStatus) {
    const res = await updateTaskStatusAction({ id, status });
    if (!res.success) {
      toast.error(res.error);
      return;
    }
    refresh();
  }
  async function handleTaskDelete(id: string) {
    const ok = await confirm({
      title: "Delete this task?",
      description: "This action cannot be undone.",
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!ok) return;
    const res = await deleteTaskAction(id);
    if (!res.success) {
      toast.error(res.error);
      return;
    }
    toast.success("Task deleted");
    refresh();
  }

  async function handleArchive() {
    const ok = await confirm({
      title: t.projects.archiveConfirmTitle,
      description: t.projects.archiveConfirmDesc,
      confirmLabel: t.projects.archiveProject,
      tone: "primary",
    });
    if (!ok) return;
    const res = await updateProjectAction({
      projectId: project.id,
      name: project.name,
      description: project.description ?? undefined,
      color: project.color as "primary",
      status: "archived",
      targetEndDate: project.targetEndDate ?? null,
    });
    if (!res.success) {
      toast.error(res.error);
      return;
    }
    toast.success(t.projects.projectArchivedToast);
    refresh();
  }

  async function handleUnarchive() {
    // Reactivate straight to "active" — the confirm modal would be friction
    // here; the header's delete/archive buttons are the destructive path.
    const res = await updateProjectAction({
      projectId: project.id,
      name: project.name,
      description: project.description ?? undefined,
      color: project.color as "primary",
      status: "active",
      targetEndDate: project.targetEndDate ?? null,
    });
    if (!res.success) {
      toast.error(res.error);
      return;
    }
    toast.success(t.projects.projectRestoredToast);
    refresh();
  }

  async function handleDelete() {
    const ok = await confirm({
      title: t.projects.deleteConfirmTitle,
      description: t.projects.deleteConfirmDesc,
      confirmLabel: t.projects.deleteProject,
      tone: "danger",
    });
    if (!ok) return;
    const res = await deleteProjectAction(project.id);
    if (!res.success) {
      toast.error(res.error);
      return;
    }
    toast.success(t.projects.projectDeletedToast);
    router.push("/projects");
  }

  const statusKey = `status${project.status.charAt(0).toUpperCase()}${project.status
    .slice(1)
    .replace("_", "")}` as "statusActive" | "statusOnHold" | "statusCompleted" | "statusArchived";

  const isOverdue =
    project.status === "active" &&
    project.targetEndDate !== null &&
    new Date(project.targetEndDate).getTime() < Date.now();

  return (
    <div className="mx-auto max-w-[1600px] space-y-8">
      <header className="overflow-hidden rounded-2xl border border-border bg-surface">
        <span
          aria-hidden="true"
          className={cn("block h-1 w-full", COLOR_STRIPE[project.color] ?? COLOR_STRIPE.primary)}
        />
        <div className="flex flex-col gap-4 p-6 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <PillBadge tone="cyan">
                <Briefcase className="mr-1 inline h-3 w-3" aria-hidden="true" />
                {t.projects.title}
              </PillBadge>
              <span
                className={cn(
                  "inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider",
                  STATUS_CLASSES[project.status]
                )}
              >
                {t.projects[statusKey]}
              </span>
              {isOverdue && (
                <span className="inline-flex items-center gap-0.5 rounded-full border border-danger/30 bg-danger/10 px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-danger">
                  <AlertCircle className="h-2.5 w-2.5" aria-hidden="true" />
                  {t.projects.targetEndDateOverdue}
                </span>
              )}
            </div>
            <h1 className="text-balance text-3xl font-bold tracking-tight md:text-4xl">
              {project.name}
            </h1>
            {project.description && (
              <p className="mt-2 text-sm text-fg-muted md:text-base">{project.description}</p>
            )}
            <div className="mt-3 flex items-center gap-2 text-sm text-fg-muted">
              <Avatar name={project.supervisorName} size="xs" />
              <span>
                <span className="font-mono text-[10px] uppercase tracking-wider text-fg-muted">
                  {t.projects.supervisor}:
                </span>{" "}
                <span className="font-semibold text-fg">{project.supervisorName}</span>
              </span>
              {canReassign && (
                <button
                  onClick={() => setSupOpen(true)}
                  className="inline-flex items-center gap-1 rounded-full border border-border bg-bg px-2 py-0.5 text-[10px] font-medium text-fg-muted transition hover:bg-surface-hover hover:text-fg"
                >
                  <UserCog className="h-3 w-3" aria-hidden="true" />
                  {t.projects.changeSupervisor}
                </button>
              )}
            </div>
          </div>
          {canManage && project.status !== "archived" && (
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => setEditOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-bg px-3 py-1.5 text-xs font-medium text-fg-muted transition hover:bg-surface-hover hover:text-fg"
              >
                <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                {t.projects.editProject}
              </button>
              <button
                onClick={handleArchive}
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-bg px-3 py-1.5 text-xs font-medium text-fg-muted transition hover:bg-surface-hover hover:text-fg"
              >
                <Archive className="h-3.5 w-3.5" aria-hidden="true" />
                {t.projects.archiveProject}
              </button>
              <button
                onClick={handleDelete}
                className="inline-flex items-center gap-1.5 rounded-full border border-danger/30 bg-danger/10 px-3 py-1.5 text-xs font-medium text-danger transition hover:bg-danger/20"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                {t.projects.deleteProject}
              </button>
            </div>
          )}
          {canManage && project.status === "archived" && (
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={handleUnarchive}
                className="inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary-strong transition hover:bg-primary/20"
              >
                <ArchiveRestore className="h-3.5 w-3.5" aria-hidden="true" />
                {t.projects.unarchiveProject}
              </button>
              <button
                onClick={handleDelete}
                className="inline-flex items-center gap-1.5 rounded-full border border-danger/30 bg-danger/10 px-3 py-1.5 text-xs font-medium text-danger transition hover:bg-danger/20"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                {t.projects.deleteProject}
              </button>
            </div>
          )}
        </div>
      </header>

      {/* KPI cards */}
      <section aria-label="Project KPIs" className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Kpi
          icon={Briefcase}
          label={t.projects.openTasks}
          value={`${project.openTaskCount}/${project.totalTaskCount}`}
          tone="primary"
        />
        <Kpi
          icon={Wallet}
          label={t.projects.monthSpend}
          value={canSeeBudgets ? formatCurrency(project.monthToDateSpendPkr) : "—"}
          tone="pink"
        />
        <Kpi
          icon={Clock}
          label={t.projects.hoursTracked}
          value={formatDuration(project.trackedMs)}
          tone="cyan"
        />
      </section>

      {/* Tasks */}
      <section className="rounded-2xl border border-border bg-surface p-6">
        <header className="mb-4 flex items-center justify-between gap-3">
          <h2 className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-fg-muted">
            {t.projects.tasks}
          </h2>
          <Link href="/tasks" className="text-xs font-medium text-primary-strong hover:underline">
            All company tasks →
          </Link>
        </header>
        {tasks.length === 0 ? (
          <p className="text-sm text-fg-muted">No tasks in this project yet.</p>
        ) : (
          <ul className="space-y-2">
            {tasks.slice(0, 10).map((task) => (
              <li key={task.id}>
                <button
                  type="button"
                  onClick={() => setDetailTask(task)}
                  aria-label={`Open task ${task.title}`}
                  className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-xl border border-border bg-bg px-4 py-3 text-left transition-colors hover:border-primary/30 hover:bg-surface-hover focus-visible:border-primary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{task.title}</p>
                    <div className="mt-0.5 flex items-center gap-3 text-xs text-fg-muted">
                      <span>{task.assignedToName}</span>
                      <span>·</span>
                      <span className="capitalize">{task.status.replace("_", " ")}</span>
                      <span>·</span>
                      <span>{formatDate(task.deadline)}</span>
                    </div>
                  </div>
                  <span
                    className={cn(
                      "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider",
                      task.priority === "urgent"
                        ? "border-danger/30 bg-danger/10 text-danger"
                        : task.priority === "high"
                          ? "border-warning/30 bg-warning/10 text-warning"
                          : task.priority === "medium"
                            ? "border-info/30 bg-info/10 text-info"
                            : "border-border bg-bg text-fg-muted"
                    )}
                  >
                    {task.priority}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Budgets — only when caller can see project finances */}
      {canSeeBudgets && (
        <section className="rounded-2xl border border-border bg-surface p-6">
          <header className="mb-4 flex items-center justify-between gap-3">
            <h2 className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-fg-muted">
              {t.projects.budgets}
            </h2>
            <Link
              href="/budgets"
              className="text-xs font-medium text-primary-strong hover:underline"
            >
              All company budgets →
            </Link>
          </header>
          {budgets.length === 0 ? (
            <p className="text-sm text-fg-muted">No budgets set for this project yet.</p>
          ) : (
            <ul className="space-y-3">
              {budgets.map((b) => {
                const pct = Math.min(1, b.percentUsed) * 100;
                const over = b.percentUsed >= 1;
                const warn = b.percentUsed >= 0.8 && !over;
                return (
                  <li key={b.id} className="rounded-xl border border-border bg-bg px-4 py-3">
                    <div className="mb-1 flex items-center justify-between">
                      <p className="text-sm font-semibold">{b.category}</p>
                      <span className="font-mono text-xs text-fg-muted">
                        {formatCurrency(b.monthToDateSpend)} / {formatCurrency(b.monthlyLimit)}
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-border">
                      <div
                        className={cn(
                          "h-full rounded-full transition-all",
                          over ? "bg-danger" : warn ? "bg-warning" : "bg-primary"
                        )}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      {/* Members count footer */}
      <section className="flex items-center gap-2 text-sm text-fg-muted">
        <Users className="h-4 w-4" aria-hidden="true" />
        <span>
          {project.memberCount} {t.projects.members.toLowerCase()} · created{" "}
          {formatDistanceToNow(new Date(project.createdAt), { addSuffix: true })}
        </span>
      </section>

      {canManage && (
        <EditProjectModal
          open={editOpen}
          onClose={() => setEditOpen(false)}
          project={project}
          onSaved={() => {
            setEditOpen(false);
            refresh();
          }}
        />
      )}
      {canReassign && (
        <ChangeSupervisorModal
          open={supOpen}
          onClose={() => setSupOpen(false)}
          project={project}
          users={users}
          onSaved={() => {
            setSupOpen(false);
            refresh();
          }}
        />
      )}

      {detailTask && (
        <TaskDetailModal
          task={detailTask}
          open={Boolean(detailTask)}
          onClose={() => setDetailTask(null)}
          currentUserId={currentUserId}
          currentUserRole={currentUserRole}
          companyUsers={mentionUsers}
          canDelete={detailTask.assignedBy === currentUserId || currentUserRole === "admin"}
          onStatusChange={handleTaskStatusChange}
          onDelete={handleTaskDelete}
          onCommentsChanged={refresh}
        />
      )}
    </div>
  );
}

function Kpi({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof Briefcase;
  label: string;
  value: string;
  tone: "primary" | "cyan" | "pink";
}) {
  const toneText =
    tone === "cyan"
      ? "text-cyan-strong"
      : tone === "pink"
        ? "text-pink-strong"
        : "text-primary-strong";
  const toneFill =
    tone === "cyan" ? "bg-cyan/10" : tone === "pink" ? "bg-pink/10" : "bg-primary/10";
  return (
    <div className="rounded-2xl border border-border bg-surface p-5">
      <div className="mb-3 flex items-center justify-between">
        <p className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted">
          {label}
        </p>
        <div className={cn("flex h-7 w-7 items-center justify-center rounded-lg", toneFill)}>
          <Icon className={cn("h-3.5 w-3.5", toneText)} aria-hidden="true" />
        </div>
      </div>
      <p className="font-mono text-2xl font-bold tabular-nums text-fg">{value}</p>
    </div>
  );
}
