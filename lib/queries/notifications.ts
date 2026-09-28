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
 * figure where no filter can reach it. That is what `financeRecipients` below
 * is for, and it has to be CALLED from lib/notify/fan-out.ts to take effect;
 * this keeps the in-app surface honest meanwhile, and keeps the historical rows
 * already in the table from being served.
 *
 * WHAT ELSE IS STILL OPEN, stated plainly because the previous version of this
 * comment claimed otherwise. It said this function was "Exported so
 * lib/actions/notifications.ts … can call the same function instead of a
 * second, drifting implementation of the same rule." It is exported for that,
 * but `listNotificationsAction` — the action behind the TOPBAR BELL DROPDOWN,
 * the most-read notification surface in the app — still carries its own copy of
 * the old link-only half-filter and does NOT call this. So the leak described
 * above is closed on /notifications and open in the bell. A comment that
 * asserts a safety property instead of enforcing it is this repo's most
 * recurrent defect; see CLAUDE.md. The remedy is two lines in
 * lib/actions/notifications.ts, not a sentence here.
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

/**
 * The same rule, applied one step earlier: which of these people may be TOLD
 * about a finance-category event at all.
 *
 * WHY THIS EXISTS SEPARATELY FROM `visibleNotifications`. A read filter is the
 * last line, and for two of the three delivery channels it is no line at all.
 * `notifyUsers` writes the in-app row, then fires push, then sends email — all
 * before any reader ever calls a read filter. So a member who has
 * `transaction_logged` push or email switched on in /settings receives
 * "<name> logged 2,500,000 PKR" on their lock screen and in their inbox, where
 * nothing downstream can ever reach it. Filtering the RECIPIENT LIST is the only
 * place that covers in-app, push and email at once.
 *
 * THE RULE, deliberately identical to the read-time one: a finance event reaches
 * someone who fails `canSeeFinances` only when it is scoped to a project they
 * SUPERVISE — the escape hatch `canSeeProjectFinances` grants. It lives here,
 * beside the read rule, rather than in lib/notify/, because the two have to
 * agree and a second copy is how they would drift.
 *
 * Tombstoned accounts are dropped as a side effect of the roster lookup, which
 * matters on this path: the recipient query in `addTransactionAction` does not
 * filter `deletedAt`, so a deactivated teammate's phone kept receiving figures
 * from a workspace they had been removed from (data-integrity-004).
 *
 * CALLERS: lib/notify/fan-out.ts must narrow `userIds` through this whenever
 * `category === "finance"`. Until it does, this function is correct and unused —
 * which is why the doc comment above says so out loud instead of implying
 * otherwise.
 */
export async function financeRecipients(
  userIds: string[],
  scope: { companyId: string; projectId?: string | null }
): Promise<string[]> {
  // `Array.from` over the Set rather than a spread: tsconfig sets `lib` but no
  // `target`, so tsc defaults to ES5 where iterating a Set is TS2802 (the same
  // reason lib/notify/fan-out.ts writes its dedupe this way).
  const ids = Array.from(new Set(userIds.filter((id) => Boolean(id))));
  if (ids.length === 0) return [];

  const people = await db.user.findMany({
    where: { id: { in: ids }, companyId: scope.companyId, deletedAt: null },
    select: { id: true, role: true },
  });

  // Only pay for the supervisor lookup when the event actually names a project.
  let supervisorId: string | null = null;
  if (scope.projectId) {
    const project = await db.project.findFirst({
      where: { id: scope.projectId, companyId: scope.companyId, deletedAt: null },
      select: { supervisorId: true },
    });
    supervisorId = project ? project.supervisorId : null;
  }

  return people
    .filter(
      (p) => canSeeFinances(p.role as Role) || (supervisorId !== null && p.id === supervisorId)
    )
    .map((p) => p.id);
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
