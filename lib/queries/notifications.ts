/**
 * Read-side queries for notifications. Per-USER, not per-company — the bell
 * dropdown is private. Mutations (markRead, markAllRead, clear) stay in
 * lib/actions/notifications.ts.
 */

import { db } from "@/lib/db";
import { requireScopedSession } from "@/lib/queries/session";
import { canSeeFinances, isMemberBlockedRoute, type Role } from "@/lib/auth/role-gates";
import type { Notification } from "@/lib/types";

/**
 * Canonical Notification row -> client shape mapper. Exported because
 * lib/actions/notifications.ts returns the same shape and used to carry a
 * byte-identical copy of this function (consolidated 2026-09-23).
 */
export function toClientNotification(n: {
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

/** The fields the finance filter needs. Structural, so `tx` rows fit too. */
type FilterableNotification = {
  category: string;
  link: string | null;
  projectId: string | null;
};

/**
 * Drop the notification rows this reader is not entitled to see.
 *
 * WHAT WAS WRONG. This used to filter on ONE predicate — is the row's `link` a
 * member-blocked route — and the schema comment on `Notification.projectId`
 * plus lib/notify/fan-out.ts's doc comment both described a project-scoped
 * finance filter that did not exist. So the rows that mattered most sailed
 * straight through: `addTransactionAction` fans `transaction_logged` at every
 * other user in the company with `message: "<name> logged <amount> PKR"`, and
 * when the expense carries a projectId the link is `/projects/<id>` — which is
 * NOT in MEMBER_BLOCKED_ROUTES. Every project-tagged expense therefore
 * broadcast its figure to every member's bell dropdown and /notifications page.
 * Finding sec-005.
 *
 * THE RULE NOW. A `finance`-category row reaches a reader who fails
 * `canSeeFinances` only when it is scoped to a project they SUPERVISE — the
 * escape hatch `canSeeProjectFinances` grants and the one place a member is
 * meant to see money. Category, not link: the category is set at every
 * creation site (lib/notify/events.ts owns the vocabulary) and cannot be
 * dodged by pointing the link somewhere harmless, which is exactly how the
 * rupee figures got out.
 *
 * WHAT THIS DOES NOT FIX. Read-time filtering is the last line, not the first.
 * `notifyUsers` fires push and email BEFORE any reader ever calls this, so a
 * member with `transaction_logged` email or push switched on still receives the
 * figure where no filter can reach it. That has to be fixed at the fan-out /
 * call sites (lib/actions/transactions.ts); this keeps the in-app surface
 * honest meanwhile, and keeps the historical rows already in the table from
 * being served.
 *
 * Exported so lib/actions/notifications.ts — which serves the topbar dropdown
 * and carried a copy of the old half-filter — can call the same function
 * instead of a second, drifting implementation of the same rule.
 */
export async function visibleNotifications<T extends FilterableNotification>(
  rows: T[],
  reader: { userId: string; companyId: string; role: Role }
): Promise<T[]> {
  if (canSeeFinances(reader.role)) return rows;

  const financeRows = rows.filter((n) => n.category === "finance");
  // Only pay for the supervisor lookup when there is a finance row to judge —
  // the common case for a member is none at all.
  let supervisedProjectIds: string[] = [];
  if (financeRows.length > 0) {
    const supervised = await db.project.findMany({
      where: { companyId: reader.companyId, supervisorId: reader.userId, deletedAt: null },
      select: { id: true },
    });
    supervisedProjectIds = supervised.map((p) => p.id);
  }

  return rows.filter((n) => {
    if (n.category === "finance") {
      // No project scope at all → a company-wide money ping. Never a member's.
      if (!n.projectId) return false;
      // `indexOf` over an array rather than a Set: tsconfig sets `lib` but no
      // `target`, so tsc defaults to ES5 and iterating a Set is TS2802.
      return supervisedProjectIds.indexOf(n.projectId) !== -1;
    }
    // Belt and braces for everything else: a non-finance row that still points
    // at a page this reader cannot open is noise at best.
    if (!n.link) return true;
    return !isMemberBlockedRoute(n.link.split("?")[0]);
  });
}

export async function getNotifications(limit = 200): Promise<Notification[]> {
  const { userId, companyId, role } = await requireScopedSession();
  const rows = await db.notification.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  const visible = await visibleNotifications(rows, { userId, companyId, role });
  return visible.map(toClientNotification);
}
