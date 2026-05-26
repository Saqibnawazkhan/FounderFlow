/**
 * /projects — Server Component. Lists every project the caller can see
 * (admin/cofounder: all; members: their own subset, derived in the query
 * via supervisor + assigned-task OR clause).
 */

import type { Metadata } from "next";
import { listProjectsForUser } from "@/lib/queries/projects";
import { getCompanyUsers } from "@/lib/queries/users";
import { requireScopedSession } from "@/lib/queries/session";
import { ProjectsClient } from "./projects-client";

export const metadata: Metadata = {
  title: "Projects",
  description: "Group tasks, budgets, and time under the initiatives your team is running.",
};

export default async function ProjectsPage() {
  const [session, projects, users] = await Promise.all([
    requireScopedSession(),
    listProjectsForUser(),
    getCompanyUsers(),
  ]);

  return (
    <ProjectsClient
      projects={projects}
      users={users}
      currentUserId={session.userId}
      currentUserRole={session.role}
    />
  );
}
