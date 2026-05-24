/**
 * /tasks — Server Component. Fetches tasks + users + session in parallel.
 * The client component owns kanban DnD (with optimistic updates) and the
 * new-task modal.
 */

import type { Metadata } from "next";
import { getTasks } from "@/lib/queries/tasks";
import { getCompanyUsers } from "@/lib/queries/users";
import { requireScopedSession } from "@/lib/queries/session";
import { TasksClient } from "./tasks-client";

export const metadata: Metadata = {
  title: "Tasks",
  description: "Assign work, set deadlines, and track progress across your team.",
};

export default async function TasksPage() {
  const [session, tasks, users] = await Promise.all([
    requireScopedSession(),
    getTasks(),
    getCompanyUsers(),
  ]);

  return (
    <TasksClient
      initialTasks={tasks}
      users={users}
      currentUserId={session.userId}
      currentUserRole={session.role}
    />
  );
}
