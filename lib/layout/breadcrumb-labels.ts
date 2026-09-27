/**
 * The path-segment → localized-label map the breadcrumb trail renders from.
 *
 * WHY IT LIVES OUTSIDE breadcrumbs.tsx: the map is hand-maintained, and the
 * failure mode of a hand-maintained map next to a generated nav list is
 * silent drift — add a route to NAV_ITEMS, forget this map, and the crumb
 * quietly degrades to a humanized slug in English only (an Urdu user sees
 * "Chat" in the middle of an RTL trail). Pulled into a plain module so a
 * unit test can iterate NAV_ITEMS against it and fail the build instead.
 *
 * breadcrumbs.tsx is a client component; this file must stay hook-free and
 * dependency-light so the test can import it without a React environment.
 */

import type { Strings } from "@/lib/i18n/strings";

/**
 * Segments that carry a nav label. Keyed by the FIRST path segment of a
 * route (`/projects/abc123` → `projects`); anything unmapped falls back to
 * the generic/humanized crumb in breadcrumbs.tsx.
 */
export function breadcrumbLabels(t: Strings): Record<string, string> {
  return {
    dashboard: t.nav.dashboard,
    chat: t.nav.chat,
    expenses: t.nav.expenses,
    investments: t.nav.investments,
    revenue: t.nav.revenue,
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
}
