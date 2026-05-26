"use client";

/**
 * <ProjectCard> — the grid tile rendered on /projects. Pulls together the
 * supervisor, three KPI numbers (open tasks, MTD spend, hours tracked), a
 * status pill, and a colored left stripe.
 *
 * Finance figure rule: MTD spend is hidden from anyone who can't see this
 * project's finances (members who aren't the supervisor). The card still
 * renders — they just don't get the PKR figure. Cheaper than 404-ing them
 * away and matches how /tasks already hides money from members.
 */

import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { AlertCircle, Briefcase } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { formatCurrency } from "@/lib/utils";
import { formatDuration } from "@/lib/time/thresholds";
import type { ProjectListItem } from "@/lib/queries/projects";
import { canSeeProjectFinances } from "@/lib/auth/project-permissions";
import type { Role } from "@/lib/auth/role-gates";
import { useT } from "@/lib/i18n/use-t";

type Props = {
  project: ProjectListItem;
  currentUserId: string;
  currentUserRole: Role;
};

// Maps the color slug stored on the project to a Tailwind class quartet
// (stripe / accent text / chip background / chip border). Stored here so
// adding a palette entry is a one-file change.
const COLOR_CLASSES: Record<string, { stripe: string; text: string; chipBg: string }> = {
  primary: { stripe: "bg-primary", text: "text-primary-strong", chipBg: "bg-primary/10" },
  cyan: { stripe: "bg-cyan", text: "text-cyan-strong", chipBg: "bg-cyan/10" },
  pink: { stripe: "bg-pink", text: "text-pink-strong", chipBg: "bg-pink/10" },
  warning: { stripe: "bg-warning", text: "text-warning", chipBg: "bg-warning/10" },
  info: { stripe: "bg-info", text: "text-info", chipBg: "bg-info/10" },
};

const STATUS_CLASSES: Record<string, string> = {
  active: "border-primary/30 bg-primary/10 text-primary-strong",
  on_hold: "border-warning/30 bg-warning/10 text-warning",
  completed: "border-cyan/30 bg-cyan/10 text-cyan-strong",
  archived: "border-border bg-bg/40 text-fg-muted",
};

export function ProjectCard({ project, currentUserId, currentUserRole }: Props) {
  const t = useT();
  const c = COLOR_CLASSES[project.color] ?? COLOR_CLASSES.primary;
  const statusKey =
    `status${project.status.charAt(0).toUpperCase()}${project.status.slice(1).replace("_", "")}` as
      | "statusActive"
      | "statusOnHold"
      | "statusCompleted"
      | "statusArchived";

  const canSeeMoney = canSeeProjectFinances({
    userId: currentUserId,
    role: currentUserRole,
    project: { supervisorId: project.supervisorId },
  });

  const isOverdue =
    project.status === "active" &&
    project.targetEndDate !== null &&
    new Date(project.targetEndDate).getTime() < Date.now();

  return (
    <Link
      href={`/projects/${project.id}`}
      aria-label={`Open project ${project.name}`}
      className="group relative flex flex-col gap-4 overflow-hidden rounded-2xl border border-border bg-surface p-5 transition-colors hover:border-primary/40"
    >
      {/* Color stripe — pure decoration, marks the project family. */}
      <span aria-hidden="true" className={`absolute inset-y-0 left-0 w-1 ${c.stripe}`} />

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-2">
            <Briefcase className={`h-3.5 w-3.5 shrink-0 ${c.text}`} aria-hidden="true" />
            <span
              className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider ${
                STATUS_CLASSES[project.status] ?? STATUS_CLASSES.active
              }`}
            >
              {t.projects[statusKey]}
            </span>
            {isOverdue && (
              <span
                className="inline-flex items-center gap-0.5 rounded-full border border-danger/30 bg-danger/10 px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-danger"
                title={`Target: ${project.targetEndDate ? new Date(project.targetEndDate).toLocaleDateString() : ""}`}
              >
                <AlertCircle className="h-2.5 w-2.5" aria-hidden="true" />
                {t.projects.targetEndDateOverdue}
              </span>
            )}
          </div>
          <h3 className="truncate text-base font-bold tracking-tight text-fg">{project.name}</h3>
          {project.description && (
            <p className="mt-1 line-clamp-2 text-xs text-fg-muted">{project.description}</p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 border-t border-border pt-3">
        <Stat
          label={t.projects.openTasks}
          value={`${project.openTaskCount}/${project.totalTaskCount}`}
        />
        <Stat
          label={t.projects.monthSpend}
          value={canSeeMoney ? formatCurrency(project.monthToDateSpendPkr) : "—"}
        />
        <Stat label={t.projects.hoursTracked} value={formatDuration(project.trackedMs)} />
      </div>

      <div className="flex items-center justify-between border-t border-border pt-3">
        <div className="flex min-w-0 items-center gap-2">
          <Avatar name={project.supervisorName} size="xs" />
          <div className="min-w-0">
            <p className="font-mono text-[9px] uppercase tracking-wider text-fg-muted">
              {t.projects.supervisor}
            </p>
            <p className="truncate text-xs font-semibold text-fg">{project.supervisorName}</p>
          </div>
        </div>
        <p
          className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-fg-muted"
          title={new Date(project.createdAt).toLocaleString()}
        >
          {formatDistanceToNow(new Date(project.createdAt), { addSuffix: true })}
        </p>
      </div>
    </Link>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="truncate font-mono text-[9px] uppercase tracking-wider text-fg-muted">
        {label}
      </p>
      <p className="mt-0.5 truncate font-mono text-sm font-bold tabular-nums text-fg">{value}</p>
    </div>
  );
}
