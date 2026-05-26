/**
 * /projects/[id] — Server Component. Loads the project overview, the
 * scoped task list, and (when permitted) the project's budgets. 404s for
 * users who can't see the project — matches `getProjectForUser` returning
 * null instead of leaking existence.
 */

import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getProjectOverview } from "@/lib/queries/projects";
import { getTasks } from "@/lib/queries/tasks";
import { getBudgetsWithSpend } from "@/lib/queries/budgets";
import { getCompanyUsers } from "@/lib/queries/users";
import { requireScopedSession } from "@/lib/queries/session";
import { canSeeProjectFinances } from "@/lib/auth/project-permissions";
import { db } from "@/lib/db";
import { ProjectDetailClient } from "./project-detail-client";

export async function generateMetadata({ params }: { params: { id: string } }): Promise<Metadata> {
  const project = await db.project.findUnique({
    where: { id: params.id },
    select: { name: true },
  });
  return {
    title: project ? project.name : "Project",
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

  const [tasks, budgets, users] = await Promise.all([
    getTasks({ projectId: params.id }),
    canSeeBudgets ? getBudgetsWithSpend({ projectId: params.id }) : Promise.resolve([]),
    getCompanyUsers(),
  ]);

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
