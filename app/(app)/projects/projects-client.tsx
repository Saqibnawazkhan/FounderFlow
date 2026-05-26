"use client";

/**
 * /projects client. Renders the filterable grid + the "New project" CTA.
 *
 * Filter chips stay client-side — the RSC fetched every visible project
 * once; chips just toggle which subset gets rendered. Cheap, snappy, and
 * keeps the back-button behaving sensibly when users page back from a
 * detail page.
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Briefcase, Plus } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { PillBadge } from "@/components/landing/pill-badge";
import { ProjectCard } from "@/components/projects/project-card";
import { NewProjectModal } from "./new-project-modal";
import { canCreateProject } from "@/lib/auth/project-permissions";
import { useT } from "@/lib/i18n/use-t";
import { cn } from "@/lib/utils";
import type { ProjectListItem } from "@/lib/queries/projects";
import type { Role } from "@/lib/auth/role-gates";
import type { User } from "@/lib/types";

type Props = {
  projects: ProjectListItem[];
  users: User[];
  currentUserId: string;
  currentUserRole: Role;
};

type StatusFilter = "all" | "active" | "on_hold" | "completed" | "archived";

export function ProjectsClient({ projects, users, currentUserId, currentUserRole }: Props) {
  const t = useT();
  const router = useRouter();
  const canCreate = canCreateProject(currentUserRole);

  const [filter, setFilter] = useState<StatusFilter>("active");
  const [newOpen, setNewOpen] = useState(false);

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
            <Briefcase className="mr-1 inline h-3 w-3" aria-hidden="true" />
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
            className="inline-flex items-center gap-2 self-start rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-primary-fg shadow-[0_0_30px_rgb(182_244_37_/_var(--glow-shadow-opacity))] transition-transform hover:scale-[1.02] active:scale-95 md:self-auto"
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
                  className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-primary-fg shadow-[0_0_30px_rgb(182_244_37_/_var(--glow-shadow-opacity))] transition-transform hover:scale-[1.02] active:scale-95"
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
            <ProjectCard
              key={p.id}
              project={p}
              currentUserId={currentUserId}
              currentUserRole={currentUserRole}
            />
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
    </div>
  );
}
