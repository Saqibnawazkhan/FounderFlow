"use server";

/**
 * Notification server actions. Reads + read-state mutations.
 *
 * Reads are scoped to session.user.id (notifications are per-user, not
 * per-company). Mutations check the notification belongs to the caller
 * before touching it — guards against a forged ID.
 */

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { canSeeFinances, isMemberBlockedRoute, type Role } from "@/lib/auth/role-gates";
import type { Notification } from "@/lib/types";

export type ActionResult<T = void> = { success: true; data: T } | { success: false; error: string };

function toClient(n: {
  id: string;
  userId: string;
  companyId: string;
  title: string;
  message: string;
  type: string;
  category: string;
  read: boolean;
  link: string | null;
  createdAt: Date;
}): Notification {
  return {
    id: n.id,
    userId: n.userId,
    companyId: n.companyId,
    title: n.title,
    message: n.message,
    type: n.type as Notification["type"],
    category: n.category as Notification["category"],
    read: n.read,
    link: n.link ?? undefined,
    createdAt: n.createdAt.toISOString(),
  };
}

export async function listNotificationsAction(): Promise<ActionResult<Notification[]>> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Not authenticated" };

  const rows = await db.notification.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "desc" },
    take: 200, // cap; the bell icon shows a count + the dropdown shows top 10
  });

  // Members can't open finance pages, so a notification pointing at one is
  // just noise (and a leaked PKR figure in the message). Drop them. We do
  // this on read instead of pruning on write so an admin-only conversation
  // doesn't break if a recipient's role flips later.
  const role = (session.user.role as Role | undefined) ?? "member";
  const visible = canSeeFinances(role)
    ? rows
    : rows.filter((n) => {
        if (!n.link) return true;
        const path = n.link.split("?")[0];
        return !isMemberBlockedRoute(path);
      });

  return { success: true, data: visible.map(toClient) };
}

export async function markNotificationReadAction(id: string): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Not authenticated" };

  const n = await db.notification.findUnique({ where: { id } });
  if (!n) return { success: false, error: "Notification not found" };
  if (n.userId !== session.user.id) return { success: false, error: "Not authorized" };

  await db.notification.update({ where: { id }, data: { read: true } });
  revalidatePath("/notifications");

  return { success: true, data: undefined };
}

export async function markAllNotificationsReadAction(): Promise<ActionResult<{ changed: number }>> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Not authenticated" };

  // updateMany returns { count } — surface it so the caller can decide
  // whether to toast "marked all read" vs "no unread notifications" and
  // skip an unnecessary router.refresh when nothing changed.
  const { count } = await db.notification.updateMany({
    where: { userId: session.user.id, read: false },
    data: { read: true },
  });
  if (count > 0) revalidatePath("/notifications");

  return { success: true, data: { changed: count } };
}

export async function clearNotificationsAction(): Promise<ActionResult<{ deleted: number }>> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Not authenticated" };

  const { count } = await db.notification.deleteMany({
    where: { userId: session.user.id },
  });
  if (count > 0) revalidatePath("/notifications");

  return { success: true, data: { deleted: count } };
}
