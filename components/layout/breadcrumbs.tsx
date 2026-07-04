"use client";

/**
 * Path-driven breadcrumbs (N2). Derives the trail from the current pathname
 * so it works on every app route without per-page wiring. Known segments map
 * to their localized nav label; a dynamic id under /projects renders a
 * generic "Project" crumb (the page's own H1 carries the actual name). The
 * leading Home link routes to the role's home so members don't land on a
 * finance page they can't see.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight, Home } from "lucide-react";
import { useStore } from "@/lib/store";
import { homeRouteForRole, type Role } from "@/lib/auth/role-gates";
import { useT } from "@/lib/i18n/use-t";

export function Breadcrumbs() {
  const pathname = usePathname();
  const t = useT();
  const role = (useStore((s) => s.currentUser?.role) as Role | undefined) ?? "member";
  const home = homeRouteForRole(role);

  if (!pathname) return null;
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return null;

  const navLabels: Record<string, string> = {
    dashboard: t.nav.dashboard,
    expenses: t.nav.expenses,
    investments: t.nav.investments,
    recurring: t.nav.recurring,
    budgets: t.nav.budgets,
    projects: t.nav.projects,
    tasks: t.nav.tasks,
    time: t.nav.time,
    activities: t.nav.activity,
    team: t.nav.team,
    reports: t.nav.reports,
    notifications: t.nav.notifications,
    settings: t.nav.settings,
  };

  const crumbs = segments.map((seg, i) => {
    const href = "/" + segments.slice(0, i + 1).join("/");
    let label = navLabels[seg];
    if (!label) {
      // Unmapped segment: a project id gets a generic label; anything else is
      // humanized so we never render a raw slug.
      label =
        i > 0 && segments[i - 1] === "projects"
          ? t.breadcrumb.project
          : seg.charAt(0).toUpperCase() + seg.slice(1);
    }
    return { href, label, isLast: i === segments.length - 1 };
  });

  return (
    <nav aria-label="Breadcrumb" className="px-4 pt-4 md:px-6 lg:px-8">
      <ol className="flex flex-wrap items-center gap-1.5 text-xs text-fg-muted">
        <li>
          <Link
            href={home}
            className="inline-flex items-center gap-1 rounded transition-colors hover:text-fg"
          >
            <Home className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="sr-only">{t.breadcrumb.home}</span>
          </Link>
        </li>
        {crumbs.map((c) => (
          <li key={c.href} className="flex items-center gap-1.5">
            <ChevronRight className="h-3 w-3 shrink-0 text-fg-muted/50" aria-hidden="true" />
            {c.isLast ? (
              <span aria-current="page" className="font-semibold text-fg">
                {c.label}
              </span>
            ) : (
              <Link href={c.href} className="rounded transition-colors hover:text-fg">
                {c.label}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
