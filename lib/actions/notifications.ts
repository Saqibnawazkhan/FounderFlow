"use server";

/**
 * Notification server actions. Reads + read-state mutations.
 *
 * Reads are scoped to `session.user.id` — a notification row belongs to one
 * person, not to a workspace. Mutations check the notification belongs to the
 * caller before touching it, which guards against a forged ID.
 *
 * BOTH READ PATHS ALSO NEED `companyId`, and that is not a widening of scope:
 * the finance wall asks which PROJECTS this reader supervises, and that question
 * only makes sense inside a workspace (sec-005). The two read paths answer the
 * same question in two languages — `visibleNotifications` over rows for the
 * dropdown, `hiddenFromReaderClauses` in SQL for the badge — and the second
 * exists only so the badge never reads 200 rows to render one integer
 * (perf-004). tests/lib/actions/notification-bell-finance-gate.test.ts holds
 * them to the same answer over one fixture inbox, because two implementations of
 * one rule is exactly how the badge came to count what the dropdown hides.
 */

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { toClientNotification, visibleNotifications } from "@/lib/queries/notifications";
import { MEMBER_BLOCKED_ROUTES, canSeeFinances, type Role } from "@/lib/auth/role-gates";
import type { Notification } from "@/lib/types";

import type { ActionResult } from "@/lib/actions/types";

/**
 * The bell dropdown — the most-read notification surface in the app, fetched by
 * every authenticated tab on mount.
 *
 * THE FILTER IS `visibleNotifications`, NOT A SECOND COPY OF IT (sec-005).
 * This used to carry its own older rule, "is the row's LINK a member-blocked
 * route", which is the exact half-filter the /notifications page was moved off:
 * `addTransactionAction` fans `transaction_logged` at every other user in the
 * company with `message: "<name> logged <amount> PKR"`, and a project-tagged
 * expense links to `/projects/<id>` — not a blocked route — while a company-wide
 * burn alert carries no link at all and hit `if (!n.link) return true`. So both
 * of the rows that matter went straight to every member's bell. The shared
 * filter judges the CATEGORY instead, with the supervised-project escape hatch,
 * and it cannot be dodged by pointing a link somewhere harmless.
 *
 * `companyId` is required, not just `id`: the filter resolves which projects
 * this reader supervises, which is a workspace-scoped question. A claim minted
 * before companyId existed fails closed here the same way
 * `requireScopedSession` fails closed for the pages.
 */
export async function listNotificationsAction(): Promise<ActionResult<Notification[]>> {
  const session = await auth();
  if (!session?.user?.id || !session.user.companyId) {
    return { success: false, error: "Not authenticated" };
  }
  const userId = session.user.id;
  const companyId = session.user.companyId;

  const rows = await db.notification.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: 200, // cap; the bell icon shows a count + the dropdown shows top 10
  });

  // Read-time, not prune-on-write, so an admin-era notification does not have
  // to disappear retroactively if a recipient's role flips later.
  const role = (session.user.role as Role | undefined) ?? "member";
  const visible = await visibleNotifications(rows, { userId, companyId, role });

  return { success: true, data: visible.map(toClientNotification) };
}

/**
 * One `OR` clause element, narrow enough to stay assignable to Prisma's
 * `NotificationWhereInput` without importing the generated namespace.
 */
type HiddenClause = {
  category?: string | { not: string };
  projectId?: null | { notIn: string[] };
  link?: string | { startsWith: string };
};

/** The one category the finance wall is about. Matches lib/notify/events.ts. */
const FINANCE_CATEGORY = "finance";

/**
 * The SQL form of `visibleNotifications`' complement: the rows this reader is
 * NOT entitled to see, as positive Prisma clauses.
 *
 * IT HAS TWO ARMS BECAUSE THE RULE DOES (sec-005). This function used to have
 * one — the member-blocked link shapes — which made the badge count exactly the
 * project-tagged expense rows the dropdown is supposed to hide: a badge of 4
 * over a dropdown of 1, a number pointing at something the reader cannot open
 * and cannot clear. Mirroring the read filter:
 *
 *   • a `finance` row is hidden unless it is scoped to a project this reader
 *     SUPERVISES (the `canSeeProjectFinances` escape hatch);
 *   • any OTHER row is hidden only when its link points at a page the reader
 *     cannot open. Three shapes per route, because a notification link is
 *     rarely a bare path: `/expenses`, `/expenses/<id>` and `/expenses?txId=…`
 *     all have to be caught, and the query-string form is the common case.
 *
 * The link arm carries `category: { not: "finance" }` deliberately. Without it
 * a supervisor's own project expense that happens to deep-link into /expenses
 * would be subtracted from a badge whose dropdown still lists it — the same
 * disagreement in the other direction.
 *
 * Route list derived from `MEMBER_BLOCKED_ROUTES`, so a route added to the gate
 * is excluded from the badge on the same commit.
 *
 * EVERY CLAUSE IS POSITIVE. `NOT (link = … OR …)` over the NULLABLE `link`
 * column is three-valued logic: a link-less row makes the predicate NULL rather
 * than TRUE, so a `NOT`-shaped query would silently drop most of a member's
 * notifications from the badge. The same reasoning is why the finance arm spells
 * `projectId: null` out separately from `projectId: { notIn: … }` — in SQL,
 * `NULL NOT IN (…)` is NULL, not true.
 *
 * Not exported: an export from a `"use server"` module is a public HTTP
 * endpoint (see tests/lib/actions/use-server-exports.test.ts).
 */
function hiddenFromReaderClauses(supervisedProjectIds: string[]): HiddenClause[] {
  const clauses: HiddenClause[] = [];

  if (supervisedProjectIds.length === 0) {
    // Supervises nothing, so no finance row is theirs. One clause, and it also
    // avoids `notIn: []`, whose SQL is a tautology in some providers.
    clauses.push({ category: FINANCE_CATEGORY });
  } else {
    clauses.push({ category: FINANCE_CATEGORY, projectId: null });
    clauses.push({ category: FINANCE_CATEGORY, projectId: { notIn: supervisedProjectIds } });
  }

  for (const route of MEMBER_BLOCKED_ROUTES) {
    clauses.push({ category: { not: FINANCE_CATEGORY }, link: route });
    clauses.push({ category: { not: FINANCE_CATEGORY }, link: { startsWith: route + "/" } });
    clauses.push({ category: { not: FINANCE_CATEGORY }, link: { startsWith: route + "?" } });
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
 * ON THE SECOND COUNT. `count({ userId, read: false })` is NOT what the bell
 * displays: `listNotificationsAction` hides the rows this reader is not
 * entitled to see, so a raw count would show a member a badge of 4 over a
 * dropdown containing 1 — a number pointing at something they are not allowed
 * to open, and one they can never clear. So the hidden unread rows are counted
 * and subtracted, by the same rule the dropdown applies
 * (`hiddenFromReaderClauses`, which mirrors `visibleNotifications`). Before
 * sec-005's second half that mirror was only half true: the exclusion was built
 * from link shapes alone, so every project-tagged expense — the majority of the
 * finance traffic — was counted in a member's badge and hidden from their
 * dropdown.
 *
 * Both queries are POSITIVE conditions, deliberately. `NOT (link = … OR …)` over
 * the NULLABLE `link` column is three-valued logic: a notification with no link
 * makes the predicate NULL rather than TRUE, so a single `NOT`-shaped query
 * would silently drop every link-less notification from a member's badge — the
 * majority of them. Two counts and a subtraction cannot have that bug, and two
 * integers is still nothing next to 200 rows.
 *
 * THE THIRD QUERY, for a member only: which projects they supervise. It is one
 * indexed lookup (`Project_supervisorId_idx`) returning ids, and it is the same
 * question `visibleNotifications` asks — asking it differently here is how the
 * badge and the dropdown would drift apart again. Someone who can see finances
 * still costs exactly one `count`.
 *
 * `Math.max(0, …)` because the two counts are two statements at two instants: a
 * row marked read in between can only ever make the badge negative, which would
 * render as "-1 unread".
 */
export async function unreadNotificationCountAction(): Promise<ActionResult<{ count: number }>> {
  const session = await auth();
  if (!session?.user?.id || !session.user.companyId) {
    return { success: false, error: "Not authenticated" };
  }
  const userId = session.user.id;
  const companyId = session.user.companyId;

  const where = { userId, read: false };
  const role = (session.user.role as Role | undefined) ?? "member";

  if (canSeeFinances(role)) {
    const count = await db.notification.count({ where });
    return { success: true, data: { count } };
  }

  const supervised = await db.project.findMany({
    where: { companyId, supervisorId: userId, deletedAt: null },
    select: { id: true },
  });
  const supervisedProjectIds = supervised.map((p) => p.id);

  const [total, hidden] = await Promise.all([
    db.notification.count({ where }),
    db.notification.count({
      where: { ...where, OR: hiddenFromReaderClauses(supervisedProjectIds) },
    }),
  ]);
  return { success: true, data: { count: Math.max(0, total - hidden) } };
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
