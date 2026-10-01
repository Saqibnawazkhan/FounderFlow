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

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  Archive,
  ArchiveRestore,
  Briefcase,
  Check,
  ChevronDown,
  Clock,
  Pencil,
  Plus,
  Trash2,
  UserCog,
  Users,
  Wallet,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { formatDistanceToNow } from "date-fns";
import toast from "react-hot-toast";
import Link from "next/link";
import { Avatar } from "@/components/ui/avatar";
import { PillBadge } from "@/components/landing/pill-badge";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { deleteProjectAction, updateProjectAction } from "@/lib/actions/projects";
import { canManageProject, canReassignSupervisor } from "@/lib/auth/project-permissions";
import { COLOR_CLASSES, STATUS_LABEL_KEY } from "@/components/projects/project-card";
import type { ProjectStatus } from "@/lib/schemas/project";
import { canSeeFinances, type Role } from "@/lib/auth/role-gates";
import { cn } from "@/lib/utils";
import { formatDuration } from "@/lib/time/thresholds";
import { useDateFormat, useT, useNumberFormat } from "@/lib/i18n/use-t";
import { useMoney } from "@/lib/hooks/useMoney";
import type { ProjectOverview } from "@/lib/queries/projects";
import type { TaskWithCount } from "@/lib/queries/tasks";
import type { BudgetWithSpend } from "@/lib/queries/budgets";
import type { User } from "@/lib/types";
import { TaskDetailModal } from "@/components/tasks/task-detail-modal";
import { TaskForm } from "@/components/tasks/task-form";
import { Modal } from "@/components/ui/modal";
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

/**
 * The header stripe's colour comes from COLOR_CLASSES in
 * components/projects/project-card.tsx — the same table the grid card paints
 * from — and this file deliberately keeps no second copy. projects-004.
 *
 * WHAT WAS WRONG. A local `COLOR_STRIPE` map lived here, keyed
 * `primary | forest | mint | warning | info`: the slugs the
 * `20260923000000_rebrand_project_colors` migration RETIRED. `PROJECT_COLORS`
 * (lib/schemas/project.ts) is `emerald | forest | mint | slate | warning`, so
 * the map had no `slate` entry and no `emerald` one, plus two slugs nothing can
 * store any more. A slate project therefore painted a slate stripe on the grid
 * and the brand green in its own header — the colour tag meaning two different
 * things on the two screens a customer clicks between. Emerald was masked by
 * luck, because the `?? primary` fallback happens to be the emerald token.
 *
 * Importing rather than re-listing is the point: a sixth palette entry is now a
 * one-file change that cannot land on one surface only.
 */
const STATUS_CLASSES: Record<string, string> = {
  active: "border-primary/30 bg-primary/10 text-primary-strong",
  on_hold: "border-warning/30 bg-warning/10 text-warning-strong",
  completed: "border-forest/30 bg-forest/10 text-forest-strong",
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
  const money = useMoney();
  const n = useNumberFormat();
  const d = useDateFormat();
  const router = useRouter();
  const confirm = useConfirm();
  const [refreshing, startTransition] = useTransition();

  const canManage = canManageProject({
    userId: currentUserId,
    role: currentUserRole,
    project: { supervisorId: project.supervisorId },
  });
  const canReassign = canReassignSupervisor(currentUserRole);
  /**
   * May this viewer reach the COMPANY-WIDE /budgets page? Deliberately the
   * company predicate and not `canSeeBudgets`, which is per-project.
   * projects-003.
   *
   * `canSeeProjectFinances` grants a member who supervises this project the
   * escape hatch, and that is what `canSeeBudgets` carries — correctly, for the
   * figures on this page. But `/budgets` is in MEMBER_BLOCKED_ROUTES
   * (lib/auth/role-gates.ts) and `authorized()` in auth.config.ts sends
   * role="member" to `homeRouteForRole("member")` = /tasks. So the one role the
   * escape hatch exists to serve was the one role for which "All company
   * budgets →" silently landed somewhere else. The hatch is documented as
   * per-project only, in lib/auth/project-permissions.ts; this makes the link
   * agree with that.
   */
  const canSeeCompanyFinances = canSeeFinances(currentUserRole);

  const [editOpen, setEditOpen] = useState(false);
  const [supOpen, setSupOpen] = useState(false);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
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

  /**
   * Is one of the header's write paths already running? projects-012.
   *
   * TWO THINGS, because they answer different questions.
   *
   * `busyRef` is the GUARD, and it is a ref because a real double-click puts
   * both `click` handlers in the SAME task: `setBusy(true)` from the first has
   * not re-rendered when the second starts, so a `disabled` attribute derived
   * from state is not on the element yet and the second handler runs to
   * completion. A ref is written synchronously, so it is already true. Both
   * clicks previously reached `updateProjectAction`, which archived twice and
   * wrote two Activity rows for one user action.
   *
   * `busy` is what the USER sees — it is state because only state re-renders —
   * and it is ORed with the `useTransition` pending flag below, which covers the
   * second window the finding names: after a successful write the `project` prop
   * is stale until `router.refresh()` lands, so `handleStatusChange`'s
   * `status === project.status` no-op guard is comparing against the old value.
   * Staying disabled through the refresh is what closes that, and it ends by
   * itself when the fresh props arrive rather than needing a timer.
   */
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const headerBusy = busy || refreshing;

  /** Claim the header for one write. `false` means another one already has it. */
  function claim(): boolean {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    return true;
  }

  /** Give it back — on a cancelled confirm, or a write that failed. A write that
   *  SUCCEEDED releases via the refresh instead, so the stale-prop window above
   *  is not left open. */
  function release() {
    busyRef.current = false;
    setBusy(false);
  }

  /**
   * Run a claimed header write, and release the header if the call REJECTS.
   *
   * The four handlers below each release on an explicit `!res.success`, and none
   * of them released on a thrown promise — so a network failure or a 500 at the
   * action boundary left `busyRef` and `busy` true for ever: the status menu,
   * Archive, Restore and Delete all stayed `disabled`, with no toast, until the
   * page was reloaded. Before the double-click guard existed the reader could
   * simply click again, so the guard made a transient failure permanent. Found by
   * adversarial verification.
   *
   * app/verify-email-change/page.tsx is this repo's precedent for the same
   * release-on-error shape, and the reason it is a wrapper rather than four
   * try/catch blocks is that a fifth handler added later inherits it.
   */
  async function runClaimed<T>(call: () => Promise<T>): Promise<T | null> {
    try {
      return await call();
    } catch {
      release();
      // `t.auth.networkErrorToast` — an existing key with an Urdu translation
      // already written, reused rather than minting a new one. `lib/i18n/strings.ts`
      // belongs to another slice this wave and the standing rule is not to ship
      // Urdu nobody can read; the sentence ("We couldn't reach the server. Check
      // your connection and try again.") is exactly what a rejected action means,
      // and app/login and app/signup already use it for the same thing.
      toast.error(t.auth.networkErrorToast);
      return null;
    }
  }

  function refresh() {
    startTransition(() => router.refresh());
    // The transition's pending flag now holds the buttons; this hands the guard
    // over to it rather than dropping it.
    busyRef.current = false;
    setBusy(false);
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
    // Claimed BEFORE the confirm dialog: the second click of a double-click
    // gets its own dialog otherwise, and two yeses are two writes.
    if (!claim()) return;
    const ok = await confirm({
      title: t.projects.archiveConfirmTitle,
      description: t.projects.archiveConfirmDesc,
      confirmLabel: t.projects.archiveProject,
      tone: "primary",
    });
    if (!ok) {
      release();
      return;
    }
    // STATUS ONLY — projects-010. This button is not trying to change a name, a
    // description, a colour or a date, so it does not send them. It used to send
    // all four, read from the props this page was MOUNTED with, and
    // `updateProjectAction` wrote every column it was given: archiving a project
    // in a tab opened before a colleague's rename silently reverted the rename,
    // the description and the target date, with no error and no toast. The
    // action now leaves a column alone when the payload does not mention it, and
    // these three handlers are what makes that reachable.
    const res = await runClaimed(() =>
      updateProjectAction({ projectId: project.id, status: "archived" })
    );
    if (!res) return;
    if (!res.success) {
      toast.error(res.error);
      release();
      return;
    }
    toast.success(t.projects.projectArchivedToast);
    refresh();
  }

  async function handleUnarchive() {
    // Reactivate straight to "active" — the confirm modal would be friction
    // here; the header's delete/archive buttons are the destructive path.
    // Status only — see handleArchive.
    if (!claim()) return;
    const res = await runClaimed(() =>
      updateProjectAction({ projectId: project.id, status: "active" })
    );
    if (!res) return;
    if (!res.success) {
      toast.error(res.error);
      release();
      return;
    }
    toast.success(t.projects.projectRestoredToast);
    refresh();
  }

  // Direct status change from the header dropdown — the discoverable way to
  // mark a project Completed / On hold / Active without digging into Edit.
  // Reuses updateProjectAction (same path as archive/unarchive).
  async function handleStatusChange(status: ProjectStatus) {
    // `project.status` is the prop this render was given, which is stale between
    // a successful write and the refresh landing — so this no-op check cannot be
    // the double-fire guard on its own. `claim()` is. See busyRef.
    if (status === project.status) return;
    if (!claim()) return;
    // Status only — see handleArchive. This was the headline case in
    // projects-010: a cofounder clicking "Completed" in a stale tab reverted a
    // founder's rename.
    const res = await runClaimed(() => updateProjectAction({ projectId: project.id, status }));
    if (!res) return;
    if (!res.success) {
      toast.error(res.error);
      release();
      return;
    }
    toast.success(t.projects.projectSavedToast);
    refresh();
  }

  async function handleDelete() {
    if (!claim()) return;
    const ok = await confirm({
      title: t.projects.deleteConfirmTitle,
      description: t.projects.deleteConfirmDesc,
      confirmLabel: t.projects.deleteProject,
      tone: "danger",
    });
    if (!ok) {
      release();
      return;
    }
    const res = await runClaimed(() => deleteProjectAction(project.id));
    if (!res) return;
    if (!res.success) {
      toast.error(res.error);
      release();
      return;
    }
    toast.success(t.projects.projectDeletedToast);
    // No release: this navigates away, and re-enabling a Delete button on a
    // project that has just been deleted only invites a second, failing call.
    router.push("/projects");
  }

  /**
   * A LOOKUP, not a string built from the slug. projects-002 left this behind.
   *
   * `status${s.charAt(0).toUpperCase()}${s.slice(1).replace("_","")}` produces
   * "statusOnhold" for "on_hold" — lowercase h, because `.replace("_","")`
   * deletes the underscore without capitalising what follows. lib/i18n/strings.ts
   * defines `statusOnHold` and nothing named `statusOnhold`, so the lookup was
   * `undefined` and React rendered an EMPTY pill: the header of a paused project
   * did not say it was paused, in English or in Urdu. The `as` cast on the
   * computed string is why neither `tsc` nor `next build` objected — an assertion
   * is not a check.
   *
   * STATUS_LABEL_KEY was extracted from this exact bug and exported so, in its
   * own words, "the other three sites import one source of truth". None of the
   * three did; this is one of them.
   */
  const statusKey = STATUS_LABEL_KEY[project.status] ?? STATUS_LABEL_KEY.active;

  const isOverdue =
    project.status === "active" &&
    project.targetEndDate !== null &&
    new Date(project.targetEndDate).getTime() < Date.now();

  return (
    <div className="mx-auto max-w-[1600px] space-y-8">
      <header className="overflow-hidden rounded-2xl border border-border bg-surface">
        <span
          aria-hidden="true"
          className={cn(
            "block h-1 w-full",
            (COLOR_CLASSES[project.color] ?? COLOR_CLASSES.emerald).stripe
          )}
        />
        <div className="flex flex-col gap-4 p-6 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <PillBadge tone="forest">
                <Briefcase className="me-1 inline h-3 w-3" aria-hidden="true" />
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
              <StatusMenu
                current={project.status}
                onSelect={handleStatusChange}
                disabled={headerBusy}
              />
              <button
                onClick={() => setEditOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-bg px-3 py-1.5 text-xs font-medium text-fg-muted transition hover:bg-surface-hover hover:text-fg"
              >
                <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                {t.projects.editProject}
              </button>
              <button
                onClick={handleArchive}
                disabled={headerBusy}
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-bg px-3 py-1.5 text-xs font-medium text-fg-muted transition hover:bg-surface-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Archive className="h-3.5 w-3.5" aria-hidden="true" />
                {t.projects.archiveProject}
              </button>
              <button
                onClick={handleDelete}
                disabled={headerBusy}
                className="inline-flex items-center gap-1.5 rounded-full border border-danger/30 bg-danger/10 px-3 py-1.5 text-xs font-medium text-danger transition hover:bg-danger/20 disabled:cursor-not-allowed disabled:opacity-60"
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
                disabled={headerBusy}
                className="inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary-strong transition hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <ArchiveRestore className="h-3.5 w-3.5" aria-hidden="true" />
                {t.projects.unarchiveProject}
              </button>
              <button
                onClick={handleDelete}
                disabled={headerBusy}
                className="inline-flex items-center gap-1.5 rounded-full border border-danger/30 bg-danger/10 px-3 py-1.5 text-xs font-medium text-danger transition hover:bg-danger/20 disabled:cursor-not-allowed disabled:opacity-60"
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
          value={`${n.number(project.openTaskCount)}/${n.number(project.totalTaskCount)}`}
          tone="primary"
        />
        <Kpi
          icon={Wallet}
          label={t.projects.monthSpend}
          value={canSeeBudgets ? money(project.monthToDateSpendPkr) : "—"}
          tone="mint"
        />
        <Kpi
          icon={Clock}
          label={t.projects.hoursTracked}
          value={formatDuration(project.trackedMs)}
          tone="forest"
        />
      </section>

      {/* Tasks */}
      <section className="rounded-2xl border border-border bg-surface p-6">
        <header className="mb-4 flex items-center justify-between gap-3">
          <h2 className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-fg-muted">
            {t.projects.tasks}
          </h2>
          <div className="flex items-center gap-3">
            {/* projects-007: `canManage` as well as the status, because that is
                the gate `addTaskAction` enforces ("Only the supervisor or a
                founder can add tasks here"). Behind the status alone, every
                member holding one task here was invited to fill in a five-field
                form and then refused. */}
            {canManage && project.status !== "archived" && (
              <button
                onClick={() => setNewTaskOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-xs font-bold text-primary-fg shadow-[0_0_20px_rgb(var(--primary)_/_var(--glow-shadow-opacity))] transition-transform hover:scale-[1.03] active:scale-95"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" /> New task
              </button>
            )}
            <Link href="/tasks" className="text-xs font-medium text-primary-strong hover:underline">
              All company tasks →
            </Link>
          </div>
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
                  className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-xl border border-border bg-bg px-4 py-3 text-start transition-colors hover:border-primary/30 hover:bg-surface-hover focus-visible:border-primary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{task.title}</p>
                    <div className="mt-0.5 flex items-center gap-3 text-xs text-fg-muted">
                      <span>{task.assignedToName}</span>
                      <span>·</span>
                      <span className="capitalize">{task.status.replace("_", " ")}</span>
                      <span>·</span>
                      <span>{d.date(task.deadline)}</span>
                    </div>
                  </div>
                  <span
                    className={cn(
                      "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider",
                      task.priority === "urgent"
                        ? "border-danger/30 bg-danger/10 text-danger"
                        : task.priority === "high"
                          ? "border-warning/30 bg-warning/10 text-warning-strong"
                          : task.priority === "medium"
                            ? "border-info/30 bg-info/10 text-info-strong"
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
            {/* projects-003 — see canSeeCompanyFinances. The section above is
                gated per-project; this link is company-wide, so it is gated
                company-wide. */}
            {canSeeCompanyFinances && (
              <Link
                href="/budgets"
                className="text-xs font-medium text-primary-strong hover:underline"
              >
                All company budgets →
              </Link>
            )}
          </header>
          {budgets.length === 0 ? (
            <p className="text-sm text-fg-muted">No budgets set for this project yet.</p>
          ) : (
            <ul className="space-y-3">
              {budgets.map((b) => {
                // Feeds the CSS `width` below and nothing else — a length, not a
                // number any reader sees, so it stays unformatted on purpose.
                const pct = Math.min(1, b.percentUsed) * 100;
                const over = b.percentUsed >= 1;
                const warn = b.percentUsed >= 0.8 && !over;
                return (
                  <li key={b.id} className="rounded-xl border border-border bg-bg px-4 py-3">
                    <div className="mb-1 flex items-center justify-between">
                      <p className="text-sm font-semibold">{b.category}</p>
                      <span className="font-mono text-xs text-fg-muted">
                        {money(b.monthToDateSpend)} / {money(b.monthlyLimit)}
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
          {n.number(project.memberCount)} {t.projects.members.toLowerCase()} · created{" "}
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

      {/* Create a task pre-scoped to this project — TaskForm locks the project
          field via forcedProjectId so it can't be filed against another one. */}
      <Modal
        open={newTaskOpen}
        onClose={() => setNewTaskOpen(false)}
        title="New task"
        description={`Add a task to ${project.name}`}
        size="lg"
      >
        <TaskForm
          users={users}
          projects={[{ id: project.id, name: project.name }]}
          currentUserId={currentUserId}
          forcedProjectId={project.id}
          onClose={() => setNewTaskOpen(false)}
          onSuccess={() => {
            setNewTaskOpen(false);
            refresh();
          }}
        />
      </Modal>

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
  tone: "primary" | "forest" | "mint";
}) {
  const toneText =
    tone === "forest"
      ? "text-forest-strong"
      : tone === "mint"
        ? "text-mint-strong"
        : "text-primary-strong";
  const toneFill =
    tone === "forest" ? "bg-forest/10" : tone === "mint" ? "bg-mint/10" : "bg-primary/10";
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

/**
 * Header status dropdown — the discoverable, one-click way to move a project
 * through its lifecycle (Active → On hold → Completed). Archiving keeps its own
 * button since it also hides the project; this menu is only the working states.
 */
function StatusMenu({
  current,
  onSelect,
  disabled,
}: {
  current: ProjectStatus;
  onSelect: (status: ProjectStatus) => void;
  /** True while a header write is in flight — see `headerBusy`. */
  disabled?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const options: { value: ProjectStatus; label: string; dot: string }[] = [
    { value: "active", label: t.projects.statusActive, dot: "bg-primary" },
    { value: "on_hold", label: t.projects.statusOnHold, dot: "bg-warning" },
    { value: "completed", label: t.projects.statusCompleted, dot: "bg-forest" },
  ];
  const currentOpt = options.find((o) => o.value === current);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-full border border-border bg-bg px-3 py-1.5 text-xs font-medium text-fg-muted transition hover:bg-surface-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-60"
      >
        <span
          className={cn("h-2 w-2 rounded-full", currentOpt?.dot ?? "bg-fg-muted")}
          aria-hidden="true"
        />
        <span className="font-mono text-[10px] uppercase tracking-wider">{t.projects.status}</span>
        <span className="font-semibold text-fg">
          {currentOpt?.label ?? t.projects.statusActive}
        </span>
        <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.97 }}
            transition={{ duration: 0.14 }}
            className="absolute start-0 z-popover mt-2 w-44 overflow-hidden rounded-xl border border-border bg-surface p-1 shadow-card-hover"
          >
            {options.map((o) => {
              const active = o.value === current;
              return (
                <button
                  key={o.value}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpen(false);
                    onSelect(o.value);
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-start text-sm transition-colors hover:bg-surface-hover",
                    active ? "text-fg" : "text-fg-muted"
                  )}
                >
                  <span className={cn("h-2 w-2 rounded-full", o.dot)} aria-hidden="true" />
                  <span className="flex-1">{o.label}</span>
                  {active && <Check className="h-4 w-4 text-primary-strong" aria-hidden="true" />}
                </button>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
