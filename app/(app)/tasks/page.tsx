/**
 * /tasks — Server Component. Fetches tasks + users + session in parallel.
 * The client component owns kanban DnD (with optimistic updates) and the
 * new-task modal.
 */

import type { Metadata } from "next";
import { getTasks, listFilableProjectOptions } from "@/lib/queries/tasks";
import { getCompanyUsers } from "@/lib/queries/users";
import { getMentionRoster } from "@/lib/comments/roster";
import { listProjectOptions } from "@/lib/queries/projects";
import { requireScopedSession } from "@/lib/queries/session";
import { TasksClient } from "./tasks-client";

export const metadata: Metadata = {
  title: "Tasks",
  description: "Assign work, set deadlines, and track progress across your team.",
};

export default async function TasksPage() {
  const [session, tasks, users, mentionUsers, projects, filableProjects] = await Promise.all([
    requireScopedSession(),
    getTasks(),
    getCompanyUsers(),
    // The roster the comment composer resolves @mentions against. A SEPARATE
    // read from `getCompanyUsers` because the `User` DTO carries no `handle`
    // (tasks-and-comments-002), and without it `mentionToken` falls back to the
    // name slug: no handle can ever be offered, and a teammate whose name has no
    // ASCII letters is dropped from the dropdown altogether.
    getMentionRoster(),
    // Source for the toolbar's Project FILTER: every project the caller can
    // see, which for a member includes ones they merely hold a task in — they
    // need to be able to filter their own work by it.
    listProjectOptions(),
    // Source for the new-task FORM, and for whether its CTA is offered at all.
    // A narrower set: the projects `addTaskAction` will actually accept
    // (tasks-and-comments-008). The two were one list, so a member was given
    // the button, the form and a project the action then refused.
    listFilableProjectOptions(),
  ]);

  return (
    <TasksClient
      initialTasks={tasks}
      users={users}
      mentionUsers={mentionUsers}
      projects={projects.map((p) => ({ id: p.id, name: p.name }))}
      filableProjects={filableProjects}
      currentUserId={session.userId}
      currentUserRole={session.role}
    />
  );
}
