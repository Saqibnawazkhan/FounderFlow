"use client";

/**
 * /projects client. Renders the filterable grid, the "New project" CTA, and
 * the per-card Duplicate affordance.
 *
 * Filter chips stay client-side — the RSC fetched every visible project
 * once; chips just toggle which subset gets rendered. Cheap, snappy, and
 * keeps the back-button behaving sensibly when users page back from a
 * detail page.
 */

import { useEffect, useId, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";
import { Briefcase, Copy, Plus, RotateCcw, Trash2 } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { Modal } from "@/components/ui/modal";
import { PillBadge } from "@/components/landing/pill-badge";
import { ProjectCard } from "@/components/projects/project-card";
import { NewProjectModal } from "./new-project-modal";
import { canCreateProject } from "@/lib/auth/project-permissions";
import { duplicateProjectAction, restoreProjectAction } from "@/lib/actions/projects";
import { useT } from "@/lib/i18n/use-t";
import { cn } from "@/lib/utils";
import type { DeletedProjectListItem, ProjectListItem } from "@/lib/queries/projects";
import type { Role } from "@/lib/auth/role-gates";
import type { User } from "@/lib/types";

type Props = {
  projects: ProjectListItem[];
  /**
   * Tombstoned projects this caller may restore (data-integrity-010). Empty for
   * the overwhelming majority of visits, and the panel below renders nothing at
   * all when it is — a "Recently deleted (0)" heading on every workspace that has
   * never deleted anything is noise on the one screen people scan for their work.
   */
  deletedProjects: DeletedProjectListItem[];
  users: User[];
  currentUserId: string;
  currentUserRole: Role;
};

type StatusFilter = "all" | "active" | "on_hold" | "completed" | "archived";

export function ProjectsClient({
  projects,
  deletedProjects,
  users,
  currentUserId,
  currentUserRole,
}: Props) {
  const t = useT();
  const router = useRouter();
  const canCreate = canCreateProject(currentUserRole);

  const [filter, setFilter] = useState<StatusFilter>("active");
  const [newOpen, setNewOpen] = useState(false);
  // The project the duplicate modal is pointed at. Null = closed. Held as the
  // whole row rather than an id so the modal can pre-fill the name without a
  // second lookup, and so it still renders its source's name during the
  // dialog's close animation.
  const [duplicating, setDuplicating] = useState<ProjectListItem | null>(null);

  const filtered = useMemo(() => {
    if (filter === "all") return projects;
    return projects.filter((p) => p.status === filter);
  }, [projects, filter]);

  const counts = useMemo(() => {
    const c: Record<StatusFilter, number> = {
      all: projects.length,
      active: 0,
      on_hold: 0,
      completed: 0,
      archived: 0,
    };
    for (const p of projects) {
      if (p.status in c) c[p.status as StatusFilter]++;
    }
    return c;
  }, [projects]);

  return (
    <div className="mx-auto max-w-[1600px] space-y-8">
      <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <PillBadge tone="primary">
            <Briefcase className="me-1 inline h-3 w-3" aria-hidden="true" />
            {t.projects.badge}
          </PillBadge>
          <h1 className="mt-4 text-balance text-4xl font-bold tracking-tight md:text-5xl">
            {t.projects.title}
          </h1>
          <p className="mt-2 text-sm text-fg-muted md:text-base">{t.projects.subtitle}</p>
        </div>
        {canCreate && (
          <button
            onClick={() => setNewOpen(true)}
            className="inline-flex items-center gap-2 self-start rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-primary-fg shadow-[0_0_30px_rgb(var(--primary)_/_var(--glow-shadow-opacity))] transition-transform hover:scale-[1.02] active:scale-95 md:self-auto"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t.projects.newProject}
          </button>
        )}
      </header>

      {/* Status chips */}
      <div className="inline-flex w-fit flex-wrap gap-1 rounded-full border border-border bg-bg p-1">
        {(["active", "all", "on_hold", "completed", "archived"] as StatusFilter[]).map((key) => {
          const labelKey =
            key === "all"
              ? "statusAll"
              : (`status${key.charAt(0).toUpperCase()}${key.slice(1).replace("_", "")}` as
                  | "statusActive"
                  | "statusOnHold"
                  | "statusCompleted"
                  | "statusArchived");
          const active = filter === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setFilter(key)}
              aria-pressed={active}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
                active ? "bg-surface text-fg shadow-card" : "text-fg-muted hover:text-fg"
              )}
            >
              {t.projects[labelKey]}
              <span className="font-mono text-[10px] text-fg-muted">{counts[key]}</span>
            </button>
          );
        })}
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-2xl border border-border bg-surface">
          <EmptyState
            icon={Briefcase}
            title={t.projects.noProjectsTitle}
            description={
              canCreate ? t.projects.noProjectsAdminDesc : t.projects.noProjectsMemberDesc
            }
            action={
              canCreate ? (
                <button
                  onClick={() => setNewOpen(true)}
                  className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-primary-fg shadow-[0_0_30px_rgb(var(--primary)_/_var(--glow-shadow-opacity))] transition-transform hover:scale-[1.02] active:scale-95"
                >
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  {t.projects.newProject}
                </button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((p) => (
            // The card is one big <Link>; a <button> nested inside an <a> is
            // invalid HTML and swallows the click. So the Duplicate control is
            // an absolutely-positioned SIBLING overlaying the card's top-right
            // padding, which also keeps components/projects/project-card.tsx
            // untouched. Deliberately always visible rather than revealed on
            // hover — a hover-only affordance is invisible on touch.
            <div key={p.id} className="relative">
              <ProjectCard
                project={p}
                currentUserId={currentUserId}
                currentUserRole={currentUserRole}
              />
              {canCreate && (
                <button
                  type="button"
                  onClick={() => setDuplicating(p)}
                  title={t.projects.duplicateProject}
                  aria-label={`${t.projects.duplicateProject}: ${p.name}`}
                  className="absolute end-3 top-3 z-10 rounded-full border border-border bg-surface/90 p-1.5 text-fg-muted backdrop-blur transition-colors hover:border-primary/40 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                >
                  <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {canCreate && (
        <NewProjectModal
          open={newOpen}
          onClose={() => setNewOpen(false)}
          users={users}
          currentUserId={currentUserId}
          onCreated={(projectId) => {
            setNewOpen(false);
            router.push(`/projects/${projectId}`);
          }}
        />
      )}

      <RecentlyDeletedProjects projects={deletedProjects} onRestored={() => router.refresh()} />

      {canCreate && (
        <DuplicateProjectModal
          project={duplicating}
          onClose={() => setDuplicating(null)}
          onDuplicated={(projectId) => {
            setDuplicating(null);
            router.push(`/projects/${projectId}`);
          }}
        />
      )}
    </div>
  );
}

/**
 * "Recently deleted" — the panel that makes the 90-day project tombstone usable
 * (data-integrity-010).
 *
 * `deleteProjectAction` has stamped `Project.deletedAt` since Tier 3, saying in
 * its own comment that it does so "so an accidental project delete has the same
 * 90-day recovery window as every other soft-delete table". Nothing cleared that
 * column and nothing showed the row, so the window was real in the database and
 * invisible in the product: /projects excluded it, /projects/<id> 404'd, search
 * excluded it. A supervisor who deleted the wrong project could not even TELL
 * support which id to resurrect, because they could no longer look it up.
 *
 * Deliberately at the BOTTOM of the page and absent when empty. This is a
 * recovery affordance, not a view of current work — putting it above the grid
 * would make every workspace's projects screen open on a list of things that are
 * gone. The countdown comes from the server (`daysUntilPurge`), because the one
 * number here that must not be wrong is how long is left, and a browser clock an
 * hour fast would tell somebody their window had closed.
 */
function RecentlyDeletedProjects({
  projects,
  onRestored,
}: {
  projects: DeletedProjectListItem[];
  onRestored: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  if (projects.length === 0) return null;

  async function restore(project: DeletedProjectListItem) {
    setBusy(project.id);
    const res = await restoreProjectAction(project.id);
    setBusy(null);
    if (!res.success) {
      toast.error(res.error);
      // A refused restore is usually "somebody else already did it", so the
      // panel is stale either way — re-read rather than leaving a row that no
      // longer needs restoring.
      onRestored();
      return;
    }
    toast.success(`Restored "${project.name}"`);
    onRestored();
  }

  return (
    <section className="mt-10 rounded-2xl border border-border bg-surface/60 p-5">
      <h2 className="flex items-center gap-2 text-sm font-bold text-fg">
        <Trash2 className="h-4 w-4 text-fg-muted" aria-hidden="true" />
        Recently deleted
      </h2>
      <p className="mt-1 text-xs text-fg-muted">
        Deleted projects stay recoverable for 90 days, then they are erased for good.
      </p>
      <ul className="mt-4 flex flex-col gap-2">
        {projects.map((p) => (
          <li
            key={p.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-bg/40 px-3 py-2.5"
          >
            <div className="flex min-w-0 items-center gap-2.5">
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: p.color }}
                aria-hidden="true"
              />
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-fg">{p.name}</p>
                <p className="text-[11px] text-fg-muted">
                  {p.supervisorName ? `${p.supervisorName} · ` : ""}
                  {p.daysUntilPurge > 0
                    ? `${p.daysUntilPurge} day${p.daysUntilPurge === 1 ? "" : "s"} left to restore`
                    : "Being erased in the next nightly run"}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => void restore(p)}
              disabled={busy === p.id}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-semibold text-fg transition-colors hover:border-primary/40 disabled:opacity-60"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              {busy === p.id ? "Restoring…" : "Restore"}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Duplicate modal. Mirrors <NewProjectModal>'s shape — same <Modal>, same
 * field/inputClass styling, same "toast on failure, navigate on success"
 * ending — so Duplicate doesn't feel like a different product from New.
 *
 * Two deliberate departures from its neighbour:
 *
 *  - No react-hook-form. One text field and three checkboxes don't need a
 *    resolver, and `DuplicateProjectSchema` uses `.default()` on the flags,
 *    which splits its input and output types — exactly the mismatch the
 *    comment on NewProjectSchema warns breaks `useForm<T>`. Plain controlled
 *    state sidesteps it and always sends all three booleans explicitly.
 *
 *  - Stays mounted while closed (`project` goes null) instead of being
 *    conditionally rendered, so Radix can play its exit animation. State
 *    resets off the incoming project rather than on close for the same
 *    reason — unmounting to reset would cut the animation short.
 */
function DuplicateProjectModal({
  project,
  onClose,
  onDuplicated,
}: {
  project: ProjectListItem | null;
  onClose: () => void;
  onDuplicated: (projectId: string) => void;
}) {
  const t = useT();
  const nameId = useId();
  const [name, setName] = useState("");
  const [copyTasks, setCopyTasks] = useState(true);
  const [keepAssignees, setKeepAssignees] = useState(false);
  const [shiftDeadlines, setShiftDeadlines] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  // Re-seed whenever a DIFFERENT project is picked. Keyed on the id alone,
  // deliberately: `sourceName` is read-only seed data, and listing it as a
  // dependency would re-run this — discarding whatever the user had typed —
  // if the project list revalidated a rename underneath the open dialog.
  const sourceId = project?.id ?? null;
  const sourceName = project?.name ?? "";
  useEffect(() => {
    if (sourceId === null) return;
    // The suffix is translated too. It is text the user reads (and then edits)
    // inside an otherwise fully translated dialog, so leaving "(copy)" in
    // English would make the one word the modal *seeds* the odd one out. `t`
    // is deliberately NOT a dependency: re-seeding on a locale switch would
    // throw away a name the user had already typed.
    setName(`${sourceName} ${t.projects.duplicateNameSuffix}`);
    setCopyTasks(true);
    setKeepAssignees(false);
    setShiftDeadlines(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!project || submitting) return;
    setSubmitting(true);
    const res = await duplicateProjectAction({
      sourceProjectId: project.id,
      name,
      copyTasks,
      keepAssignees,
      shiftDeadlines,
    });
    setSubmitting(false);
    if (!res.success) {
      toast.error(res.error);
      return;
    }
    toast.success(t.projects.projectDuplicatedToast);
    onDuplicated(res.data.projectId);
  }

  return (
    <Modal
      open={project !== null}
      onClose={onClose}
      title={
        sourceName ? `${t.projects.duplicateProject} "${sourceName}"` : t.projects.duplicateProject
      }
      size="md"
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <div>
          <label
            htmlFor={nameId}
            className="mb-1.5 block font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
          >
            {t.projects.duplicateNameLabel}
          </label>
          <input
            id={nameId}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
            className="w-full appearance-none rounded-xl border border-border bg-bg px-4 py-2.5 text-sm text-fg focus:border-primary/50 focus:bg-surface focus:outline-none"
          />
        </div>

        <div className="space-y-3 rounded-xl border border-border bg-bg/40 p-4">
          <CopyFlag
            label={t.projects.duplicateCopyTasks}
            hint={t.projects.duplicateCopyTasksHint}
            checked={copyTasks}
            onChange={setCopyTasks}
          />
          <CopyFlag
            label={t.projects.duplicateKeepAssignees}
            hint={t.projects.duplicateKeepAssigneesHint}
            checked={keepAssignees}
            onChange={setKeepAssignees}
            // Assignees and deadlines belong to tasks. With the task list
            // switched off they have nothing to act on, so they're disabled
            // rather than left looking live and doing nothing.
            disabled={!copyTasks}
          />
          <CopyFlag
            label={t.projects.duplicateShiftDeadlines}
            hint={t.projects.duplicateShiftDeadlinesHint}
            checked={shiftDeadlines}
            onChange={setShiftDeadlines}
            disabled={!copyTasks}
          />
        </div>

        {/* Says out loud what the server refuses to do, so nobody duplicates a
            project expecting last quarter's budget to come with it. */}
        <p className="text-xs text-fg-muted">{t.projects.duplicateNeverCopied}</p>

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-border px-4 py-2 text-sm font-medium text-fg-muted transition hover:bg-surface-hover hover:text-fg"
          >
            {t.settings.cancel}
          </button>
          <button
            type="submit"
            disabled={submitting || name.trim().length === 0}
            className="inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm font-bold text-primary-fg transition-transform hover:scale-[1.01] active:scale-95 disabled:opacity-60"
          >
            <Copy className="h-4 w-4" aria-hidden="true" />
            {submitting ? t.projects.duplicateSubmitting : t.projects.duplicateSubmit}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** One labelled checkbox + the sentence arguing for its default. */
function CopyFlag({
  label,
  hint,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className={cn("flex gap-3", disabled && "opacity-50")}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-primary disabled:cursor-not-allowed"
      />
      <div className="min-w-0">
        <label htmlFor={id} className="block text-sm font-medium text-fg">
          {label}
        </label>
        <p className="mt-0.5 text-xs text-fg-muted">{hint}</p>
      </div>
    </div>
  );
}
