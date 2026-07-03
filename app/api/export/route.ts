/**
 * GET /api/export — workspace data export (GDPR / CCPA data portability).
 *
 * Returns a single machine-readable JSON document containing every row this
 * workspace owns, as an attachment download. This is the customer-facing
 * counterpart to the platform's nightly pg_dump: the pg_dump is OUR disaster
 * recovery for the whole DB; this is the CUSTOMER's copy of just their own
 * workspace, on demand.
 *
 * Access control (three independent gates):
 *   1. Middleware already blocks unauthenticated requests to /api/* that
 *      aren't on the public allow-list. We re-check `auth()` here anyway
 *      (belt + braces — a 401 is a cleaner API response than a redirect).
 *   2. Role gate: only admin / cofounder can export. A member can't see
 *      finances in the app, so handing them a JSON with every transaction
 *      would be a finance leak through the side door. Members get 403.
 *   3. Every query is scoped to `session.user.companyId`, so there is no
 *      way to reach another workspace's rows even with a forged request.
 *
 * PII / secret posture:
 *   - `passwordHash` is stripped from every user row. A bcrypt hash is
 *     still credential material; it never leaves the database.
 *   - `InviteToken.token` is stripped. That token is a live join secret —
 *     anyone holding it can accept the invite and enter the workspace. We
 *     keep the invite METADATA (who/when/status) but never the secret.
 *   - Everything else in the workspace IS the customer's data and is
 *     theirs to take.
 *
 * Serialization:
 *   - `Decimal` money columns (Transaction.amount, RecurringRule.amount,
 *     Budget.monthlyLimit) are converted to JS numbers so the export is
 *     plain JSON, not Prisma.Decimal string wrappers.
 *   - Dates serialize to ISO 8601 automatically via JSON.stringify.
 *   - Soft-deleted rows (deletedAt != null) are excluded — this exports
 *     the LIVE workspace, matching what the app shows. Tombstoned rows are
 *     recoverable via ops for 90 days and aren't "current" data.
 *   - EXCEPTION: users are exported regardless of deletedAt. A member who
 *     deletes their own account is soft-deleted, but their activities,
 *     comments, and time entries survive and still reference their userId.
 *     Dropping the user row would leave those references dangling in the
 *     export, so we keep the row (minus passwordHash) and carry its
 *     deletedAt so a consumer can tell they've departed. (Adversarial
 *     review finding, 2026-07-04.)
 *
 * Known scale ceiling: this handler loads every row of every table into
 * memory and serializes one JSON document. Fine for current workspace sizes
 * (hundreds–low-thousands of rows). If a single workspace ever reaches
 * ~100k+ rows in the append-only tables (activities/notifications/time),
 * rework this to stream NDJSON per table with a keyset cursor + set
 * `maxDuration`. Tracked from the same review. Not attacker-triggerable
 * (auth + finance-role gated), so it's a reliability ceiling, not a risk.
 */

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { canSeeFinances, type Role } from "@/lib/auth/role-gates";
import { captureServerError } from "@/lib/sentry-server";

export const runtime = "nodejs"; // Prisma needs Node
export const dynamic = "force-dynamic"; // never cache a per-workspace export
// Give the full-table read + serialize more headroom than the default so a
// medium workspace doesn't hit a premature platform timeout. The real fix
// for very large workspaces is streaming (see header) — this is the guard
// until then.
export const maxDuration = 60;

export async function GET() {
  const session = await auth();
  if (!session?.user?.id || !session.user.companyId) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  if (!canSeeFinances(session.user.role as Role)) {
    return NextResponse.json(
      { error: "Only an admin or co-founder can export the workspace." },
      { status: 403 }
    );
  }

  const companyId = session.user.companyId;
  const live = { deletedAt: null } as const;

  try {
    // One scoped read per table. All filtered to this company; the ones
    // that carry a soft-delete sentinel also filter deletedAt: null.
    const [
      company,
      users,
      projects,
      tasks,
      transactions,
      budgets,
      recurringRules,
      timeEntries,
      comments,
      activities,
      notifications,
      inviteTokens,
    ] = await Promise.all([
      db.company.findFirst({ where: { id: companyId, deletedAt: null } }),
      // Users are NOT filtered by deletedAt — a self-deleted (tombstoned)
      // member is still referenced by their surviving activities/comments/
      // time entries, so keeping the row keeps the export referentially
      // consistent. deletedAt travels with the row for consumers.
      db.user.findMany({ where: { companyId }, orderBy: { createdAt: "asc" } }),
      db.project.findMany({ where: { companyId, ...live }, orderBy: { createdAt: "asc" } }),
      db.task.findMany({ where: { companyId, ...live }, orderBy: { createdAt: "asc" } }),
      db.transaction.findMany({ where: { companyId, ...live }, orderBy: { date: "asc" } }),
      db.budget.findMany({ where: { companyId, ...live }, orderBy: { createdAt: "asc" } }),
      db.recurringRule.findMany({ where: { companyId }, orderBy: { createdAt: "asc" } }),
      db.timeEntry.findMany({ where: { companyId }, orderBy: { clockInAt: "asc" } }),
      db.comment.findMany({ where: { companyId }, orderBy: { createdAt: "asc" } }),
      db.activity.findMany({ where: { companyId }, orderBy: { createdAt: "asc" } }),
      db.notification.findMany({ where: { companyId }, orderBy: { createdAt: "asc" } }),
      db.inviteToken.findMany({ where: { companyId }, orderBy: { createdAt: "asc" } }),
    ]);

    if (!company) {
      return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
    }

    const payload = {
      meta: {
        format: "founderflow-workspace-export",
        version: 1,
        exportedAt: new Date().toISOString(),
        exportedBy: { id: session.user.id, role: session.user.role },
        companyId,
        note:
          "Your workspace data, exported for portability. Money amounts are " +
          "in the workspace currency. Password hashes are intentionally omitted.",
      },
      company,
      // Strip the bcrypt hash from every user — it's credential material,
      // never part of a data export.
      users: users.map(({ passwordHash: _passwordHash, ...u }) => u),
      projects,
      tasks,
      // Decimal → number so the export is plain JSON.
      transactions: transactions.map((t) => ({ ...t, amount: t.amount.toNumber() })),
      budgets: budgets.map((b) => ({ ...b, monthlyLimit: b.monthlyLimit.toNumber() })),
      recurringRules: recurringRules.map((r) => ({ ...r, amount: r.amount.toNumber() })),
      timeEntries,
      comments,
      activities,
      notifications,
      // Strip the join secret; keep the invite metadata (email/name/role/
      // status) so the user can still see who they invited.
      inviteTokens: inviteTokens.map(({ token: _token, ...i }) => i),
      counts: {
        users: users.length,
        projects: projects.length,
        tasks: tasks.length,
        transactions: transactions.length,
        budgets: budgets.length,
        recurringRules: recurringRules.length,
        timeEntries: timeEntries.length,
        comments: comments.length,
        activities: activities.length,
        notifications: notifications.length,
        inviteTokens: inviteTokens.length,
      },
    };

    const json = JSON.stringify(payload, null, 2);
    const stamp = new Date().toISOString().slice(0, 10);
    const safeName = company.name
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase();
    const filename = `founderflow-${safeName || "workspace"}-${stamp}.json`;

    return new NextResponse(json, {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    captureServerError(e, {
      action: "exportWorkspace",
      userId: session.user.id,
      companyId,
    });
    return NextResponse.json(
      { error: "Couldn't build your export right now. Try again shortly." },
      { status: 500 }
    );
  }
}
