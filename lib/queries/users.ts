/**
 * Read-side queries for users within the caller's company. Pairs with
 * lib/actions/team.ts which owns invite/role/remove.
 */

import { db } from "@/lib/db";
import { requireScopedSession } from "@/lib/queries/session";
import type { DeactivatedUser, PendingInvite, User } from "@/lib/types";

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
  // Tier 3: hide soft-deleted teammates from the team list, comment
  // @-mention autocomplete, task assignee picker, etc.
  const rows = await db.user.findMany({
    where: { companyId, deletedAt: null },
    orderBy: [{ role: "asc" }, { name: "asc" }],
  });
  return rows.map(toClient);
}

/**
 * Unused invites for the roster's pending-invites panel (X7). Admin-only —
 * returns [] for anyone else so the list never leaks who's been invited even
 * if a non-admin somehow reaches the page. Expired-but-unused invites stay
 * in the list (flagged) so an admin can re-send.
 */
export async function getPendingInvites(): Promise<PendingInvite[]> {
  const { companyId, role } = await requireScopedSession();
  if (role !== "admin") return [];
  const now = new Date();
  const rows = await db.inviteToken.findMany({
    where: { companyId, usedAt: null },
    orderBy: { createdAt: "desc" },
  });
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    name: r.name,
    role: r.role,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    expired: r.expiresAt < now,
  }));
}

/**
 * Soft-deleted teammates for the roster's deactivated panel (X8). Admin-only;
 * [] for anyone else. These are restorable until the 90-day purge cron.
 */
export async function getDeactivatedUsers(): Promise<DeactivatedUser[]> {
  const { companyId, role } = await requireScopedSession();
  if (role !== "admin") return [];
  const rows = await db.user.findMany({
    where: { companyId, deletedAt: { not: null } },
    orderBy: { deletedAt: "desc" },
  });
  return rows.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    deactivatedAt: (u.deletedAt ?? new Date()).toISOString(),
  }));
}

/** The signed-in user's full record — used by /settings for joined-date etc. */
export async function getCurrentUser(): Promise<User> {
  const { userId } = await requireScopedSession();
  // Belt + braces: findFirst with deletedAt filter so a session that
  // outlived its user (edge case: user tombstoned mid-session) throws
  // instead of returning ghost data.
  const row = await db.user.findFirst({ where: { id: userId, deletedAt: null } });
  if (!row) throw new Error("User not found");
  return toClient(row);
}
