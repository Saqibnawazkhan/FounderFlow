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
import { toClientNotification } from "@/lib/queries/notifications";
import {
  MEMBER_BLOCKED_ROUTES,
  canSeeFinances,
  isMemberBlockedRoute,
  type Role,
} from "@/lib/auth/role-gates";
import type { Notification } from "@/lib/types";

import type { ActionResult } from "@/lib/actions/types";

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

  return { success: true, data: visible.map(toClientNotification) };
}

/**
 * Prisma `OR` clauses matching every notification link a MEMBER is not allowed
 * to follow — the SQL form of `isMemberBlockedRoute(link.split("?")[0])`.
 *
 * Three shapes per route, because a notification link is rarely a bare path:
 * `/expenses`, `/expenses/<id>` and `/expenses?txId=…` all have to be caught,
 * and the last one is the common case (every deep link in lib/notify/fan-out.ts
 * carries a query string).
 *
 * Derived from `MEMBER_BLOCKED_ROUTES` rather than hand-listed, so a route added
 * to the gate is excluded from the badge on the same commit.
 *
 * Not exported: an export from a `"use server"` module is a public HTTP
 * endpoint (see tests/lib/actions/use-server-exports.test.ts).
 */
function memberBlockedLinkClauses(): { link: string | { startsWith: string } }[] {
  const clauses: { link: string | { startsWith: string } }[] = [];
  for (const route of MEMBER_BLOCKED_ROUTES) {
    clauses.push({ link: route });
    clauses.push({ link: { startsWith: route + "/" } });
    clauses.push({ link: { startsWith: route + "?" } });
  }
  return clauses;
}

/**
 * The unread badge, as ONE INTEGER (perf-004).
 *
 * The sidebar mounts in every authenticated tab and used to poll
 * `listNotificationsAction()` every 30 seconds, then throw the rows away:
 * `res.data.filter((n) => !n.read).length`. That is a User lookup plus
 * `findMany({ take: 200 })` returning every field of every row — two SQL
 * statements and up to ~40KB — twice a minute, per tab, to render one number.
 * Ten seats with three tabs each is 3,600 requests and ~140MB of egress an hour
 * for a badge, and it was the app's only background load, so it also set the
 * floor on database connections at idle. `Notification_userId_read_idx`
 * (prisma/schema.prisma) exists for exactly this count and was used by no read
 * query in the codebase.
 *
 * ON THE SECOND COUNT. `count({ userId, read: false })` is NOT what the sidebar
 * displayed: `listNotificationsAction` drops finance-linked rows for members, so
 * a raw count would show a member a badge of 3 over a dropdown containing 1 — a
 * number pointing at something they are not allowed to open. So for a member the
 * finance-linked unread rows are counted and subtracted.
 *
 * Both queries are POSITIVE conditions, deliberately. `NOT (link = … OR …)` over
 * the NULLABLE `link` column is three-valued logic: a notification with no link
 * makes the predicate NULL rather than TRUE, so a single `NOT`-shaped query
 * would silently drop every link-less notification from a member's badge — the
 * majority of them. Two counts and a subtraction cannot have that bug, and two
 * integers is still nothing next to 200 rows.
 *
 * `Math.max(0, …)` because the two counts are two statements at two instants: a
 * row marked read in between can only ever make the badge negative, which would
 * render as "-1 unread".
 */
export async function unreadNotificationCountAction(): Promise<ActionResult<{ count: number }>> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Not authenticated" };

  const where = { userId: session.user.id, read: false };
  const role = (session.user.role as Role | undefined) ?? "member";

  if (canSeeFinances(role)) {
    const count = await db.notification.count({ where });
    return { success: true, data: { count } };
  }

  const [total, blocked] = await Promise.all([
    db.notification.count({ where }),
    db.notification.count({ where: { ...where, OR: memberBlockedLinkClauses() } }),
  ]);
  return { success: true, data: { count: Math.max(0, total - blocked) } };
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
