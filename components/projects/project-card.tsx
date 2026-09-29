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
import { formatDuration } from "@/lib/time/thresholds";
import type { ProjectListItem } from "@/lib/queries/projects";
import type { ProjectStatus } from "@/lib/schemas/project";
import { canSeeProjectFinances } from "@/lib/auth/project-permissions";
import type { Role } from "@/lib/auth/role-gates";
import { useT } from "@/lib/i18n/use-t";
import { useMoney } from "@/lib/hooks/useMoney";
import { useNumberFormat } from "@/lib/i18n/use-t";

type Props = {
  project: ProjectListItem;
  currentUserId: string;
  currentUserRole: Role;
};

// Maps the color slug stored on the project to a Tailwind class trio
// (stripe / accent text / chip background). Stored here so adding a palette
// entry is a one-file change. Exported so tests/lib/brand.test.ts can assert
// every PROJECT_COLORS slug has a swatch — a colour added to the tuple
// without an entry here would silently render the fallback.
//
// "emerald" deliberately reuses the `primary` tokens rather than getting its
// own Tailwind colour: emerald IS the primary brand green, so a parallel
// token would be a second source of truth free to drift from --primary.
// The slug stays "emerald" because that is the palette name users pick.
export const COLOR_CLASSES: Record<string, { stripe: string; text: string; chipBg: string }> = {
  emerald: { stripe: "bg-primary", text: "text-primary-strong", chipBg: "bg-primary/10" },
  forest: { stripe: "bg-forest", text: "text-forest-strong", chipBg: "bg-forest/10" },
  mint: { stripe: "bg-mint", text: "text-mint-strong", chipBg: "bg-mint/10" },
  slate: { stripe: "bg-slate", text: "text-slate-strong", chipBg: "bg-slate/10" },
  warning: { stripe: "bg-warning", text: "text-warning", chipBg: "bg-warning/10" },
};

const STATUS_CLASSES: Record<string, string> = {
  active: "border-primary/30 bg-primary/10 text-primary-strong",
  on_hold: "border-warning/30 bg-warning/10 text-warning",
  completed: "border-mint/30 bg-mint/10 text-mint-strong",
  archived: "border-border bg-bg/40 text-fg-muted",
};

/**
 * Project status → the i18n key that labels it (projects-002).
 *
 * WHAT THIS REPLACES. Four call sites — this file, projects-client.tsx:101,
 * project-detail-client.tsx:233 and edit-project-modal.tsx:128 — derived the key
 * from the slug:
 *
 *     `status${s.charAt(0).toUpperCase()}${s.slice(1).replace("_", "")}`
 *
 * For `"on_hold"` that produces `"statusOnhold"` — lowercase h, because
 * `.replace("_", "")` deletes the underscore without capitalising what follows.
 * lib/i18n/strings.ts defines `statusOnHold` and nothing named `statusOnhold`,
 * so the lookup was `undefined` and React rendered NOTHING: an empty pill on the
 * card, a filter chip that was a bare number, and an option with no text at all
 * in the Edit dialog's status `<select>` — which a user could pick, changing the
 * project's lifecycle state with no idea what they had chosen. It shipped in both
 * English and Urdu.
 *
 * WHY IT SURVIVED REVIEW, `tsc` AND `next build`. Every site cast the computed
 * string to the union it was meant to produce (`as "statusActive" | …`). An `as`
 * on a computed string is an assertion, not a check. Typing the map
 * `Record<ProjectStatus, keyof …>` instead means a fifth status is a COMPILE
 * ERROR here rather than a blank badge in production.
 *
 * Exported so the other three sites import one source of truth. It lives beside
 * COLOR_CLASSES because that is already the precedent for shared
 * project-presentation tables in this file.
 */
export const STATUS_LABEL_KEY: Record<
  ProjectStatus,
  "statusActive" | "statusOnHold" | "statusCompleted" | "statusArchived"
> = {
  active: "statusActive",
  on_hold: "statusOnHold",
  completed: "statusCompleted",
  archived: "statusArchived",
};

export function ProjectCard({ project, currentUserId, currentUserRole }: Props) {
  const t = useT();
  const money = useMoney();
  const n = useNumberFormat();
  const c = COLOR_CLASSES[project.color] ?? COLOR_CLASSES.emerald;
  // A lookup, not a string built from the slug — see STATUS_LABEL_KEY. The
  // `?? statusActive` fallback covers a status persisted before it was added to
  // the union, so the pill is never blank even for a row this build has never
  // heard of.
  const statusKey = STATUS_LABEL_KEY[project.status] ?? STATUS_LABEL_KEY.active;

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
      <span aria-hidden="true" className={`absolute inset-y-0 start-0 w-1 ${c.stripe}`} />

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
          value={`${n.number(project.openTaskCount)}/${n.number(project.totalTaskCount)}`}
        />
        <Stat
          label={t.projects.monthSpend}
          value={canSeeMoney ? money(project.monthToDateSpendPkr) : "—"}
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
