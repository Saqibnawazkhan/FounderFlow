"use server";

/**
 * Team / user server actions. This module only has the read for now —
 * inviteUser, removeUser, updateUserRole land in Phase 1.D where the
 * write paths get full role-based enforcement and a proper invite flow.
 */

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import type { User } from "@/lib/types";

export type ActionResult<T = void> = { success: true; data: T } | { success: false; error: string };

/** Strip the passwordHash before returning to the client. */
function toClient(u: {
  id: string;
  name: string;
  email: string;
  role: string;
  avatar: string | null;
  companyId: string;
  createdAt: Date;
}): User {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    password: "", // legacy field; never populated server-side
    role: u.role as User["role"],
    avatar: u.avatar ?? undefined,
    companyId: u.companyId,
    createdAt: u.createdAt.toISOString(),
  };
}

export async function listCompanyUsersAction(): Promise<ActionResult<User[]>> {
  const session = await auth();
  if (!session?.user?.companyId) return { success: false, error: "Not authenticated" };

  const rows = await db.user.findMany({
    where: { companyId: session.user.companyId },
    orderBy: [{ role: "asc" }, { name: "asc" }],
  });
  return { success: true, data: rows.map(toClient) };
}
