/**
 * Read-side queries for users within the caller's company. Pairs with
 * lib/actions/team.ts which owns invite/role/remove.
 */

import { db } from "@/lib/db";
import { requireScopedSession } from "@/lib/queries/session";
import type { User } from "@/lib/types";

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

export async function getCompanyUsers(): Promise<User[]> {
  const { companyId } = await requireScopedSession();
  const rows = await db.user.findMany({
    where: { companyId },
    orderBy: [{ role: "asc" }, { name: "asc" }],
  });
  return rows.map(toClient);
}

/** The signed-in user's full record — used by /settings for joined-date etc. */
export async function getCurrentUser(): Promise<User> {
  const { userId } = await requireScopedSession();
  const row = await db.user.findUnique({ where: { id: userId } });
  if (!row) throw new Error("User not found");
  return toClient(row);
}
