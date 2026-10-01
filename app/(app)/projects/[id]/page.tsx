/**
 * /projects/[id] — Server Component. Loads the project overview, the
 * scoped task list, and (when permitted) the project's budgets. 404s for
 * users who can't see the project — matches `getProjectForUser` returning
 * null instead of leaking existence.
 */

import { notFound } from "next/navigation";
import type { Metadata } from "next";
import {
  getProjectOverview,
  getProjectTitleForUser,
  visibleProjectTasks,
} from "@/lib/queries/projects";
import { getTasks } from "@/lib/queries/tasks";
import { getBudgetsWithSpend } from "@/lib/queries/budgets";
import { getCompanyUsers } from "@/lib/queries/users";
import { requireScopedSession } from "@/lib/queries/session";
import { canSeeProjectFinances } from "@/lib/auth/project-permissions";
import { ProjectDetailClient } from "./project-detail-client";

/**
 * The title goes through the SCOPED query, like every other read driven by a
 * client-supplied id. Finding sec-003.
 *
 * WHAT WAS WRONG. This ran its own `db.project.findUnique({ where: { id:
 * params.id }, select: { name: true } })` — no `companyId`, no
 * `deletedAt: null`, no session check at all — and used the row's name as the
 * document `<title>`. The page body below 404s correctly via
 * `getProjectForUser`, but by then the metadata read had already fetched a row
 * from an arbitrary tenant: a signed-in user who typed another company's
 * project URL got a page reading "not found" whose browser tab carried the
 * other company's project name, usually a client or a deal name. It also made
 * the deliberate 404-rather-than-403 choice pointless, since the title
 * confirmed both that the id existed and what it was.
 *
 * There is now no `db` import in this file, deliberately: a page that cannot
 * reach the Prisma client cannot reintroduce an unscoped read. Tenancy and
 * in-tenant visibility come from `getProjectTitleForUser`, which reuses the one
 * audited predicate rather than a second, drifting copy, and returns null
 * rather than throwing when there is no session (a throw inside
 * `generateMetadata` is a 500 on a page that would otherwise render its own
 * not-found). app/(app)/chat/[slug]/page.tsx does the same thing via
 * `getChannelBySlug`.
 */
export async function generateMetadata({ params }: { params: { id: string } }): Promise<Metadata> {
  const name = await getProjectTitleForUser(params.id);
  return {
    title: name ?? "Project",
    description: "Project overview, tasks, budgets, and time tracked.",
  };
}

export default async function ProjectDetailPage({ params }: { params: { id: string } }) {
  const session = await requireScopedSession();
  const overview = await getProjectOverview(params.id);
  if (!overview) notFound();

  const canSeeBudgets = canSeeProjectFinances({
    userId: session.userId,
    role: session.role,
    project: { supervisorId: overview.supervisorId },
  });

  const [allTasks, budgets, users] = await Promise.all([
    getTasks({ projectId: params.id }),
    canSeeBudgets ? getBudgetsWithSpend({ projectId: params.id }) : Promise.resolve([]),
    getCompanyUsers(),
  ]);

  /**
   * projects-017. `getTasks({ projectId })` returns the project's WHOLE board:
   * `taskScopeWhere` in lib/queries/tasks.ts applies its `assignedTo: userId`
   * narrowing only when no `projectId` is passed, so the confidentiality rule
   * /tasks enforces at the data boundary switched itself off for this page. A
   * plain member holding one task here received every teammate's task, and the
   * client component renders the first ten of them.
   *
   * Filtered here, not masked in the component: the RSC hands its props to the
   * client through the Flight payload, so a row that reaches this call is in the
   * served HTML whether or not anything paints it — the same argument
   * `getProjectOverview` makes for SKIPPING the spend aggregate rather than
   * em-dashing it.
   *
   * `visibleProjectTasks` leaves admin, cofounder and this project's supervisor
   * with the full board, which is what the escape hatch is for.
   */
  const tasks = visibleProjectTasks({
    userId: session.userId,
    role: session.role,
    project: { supervisorId: overview.supervisorId },
    tasks: allTasks,
  });

  return (
    <ProjectDetailClient
      project={overview}
      tasks={tasks}
      budgets={budgets}
      users={users}
      canSeeBudgets={canSeeBudgets}
      currentUserId={session.userId}
      currentUserRole={session.role}
    />
  );
}
