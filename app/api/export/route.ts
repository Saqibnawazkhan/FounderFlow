/**
 * GET /api/export — data portability (GDPR / CCPA), in two scopes.
 *
 *   ?scope=workspace  (the default, and what a bare /api/export means)
 *       The workspace's own records, for a caller who may see finances. NOT
 *       "every row this workspace owns" — that is what this line used to say,
 *       and rep-005 was filed against it, correctly. `EXPORT_EXCLUDED` below is
 *       the list of what is left out and why, `meta.notIncluded` puts that list
 *       in the file, and the /settings card that offers the download says so
 *       too (lib/i18n/strings.ts `exportWorkspaceDesc`).
 *   ?scope=me
 *       Every row about the CALLER, for any signed-in role.
 *
 * WHY TWO SCOPES AND NOT ONE WIDENED GATE (acct-009). The workspace export is
 * admin/cofounder-only for a sound reason: a full-workspace JSON carries every
 * transaction, and handing that to a member would walk the app's finance wall
 * (audit-flow #1) straight out through a download link. But until 2026-09-29
 * nothing narrower existed, so /settings offered a member exactly ONE data
 * operation — "Delete my account". The people with the least power in a
 * workspace were the only ones who could not get their data out, which is the
 * portability half of the same regulation this route was built for.
 *
 * So the fix widens WHO may export without widening WHAT a member sees, and it
 * does that by making the SCOPE depend on the role rather than by relaxing the
 * gate:
 *
 *   • `scope=workspace` keeps the exact gate it had. A member gets the same
 *     403, with the same zero database reads, and so does a scope-less request.
 *   • `scope=me` builds a different payload from different queries. It never
 *     asks the transaction / budget / recurringRule delegates AT ALL, so there
 *     is no filter for a later edit to forget: the money tables are absent from
 *     the code path, not stripped from its result.
 *   • The three tables that CAN carry a figure without being a money table —
 *     a Comment hanging off a Transaction, a finance Activity, a finance
 *     Notification — are narrowed in the WHERE clause when the caller may not
 *     see finances. Read it scoped, never filter it afterwards; that is the
 *     rule tests/lib/auth/finance-gate.test.ts already enforces here.
 *
 * MEMBER-SCOPED EXPORT vs PER-USER DOWNLOAD — this is the latter, deliberately.
 * A "member-scoped workspace export" (everything a member is allowed to look
 * at, minus finance) is a moving target: it would have to track every role gate
 * in the product for ever, and the day someone adds a surface a member can see
 * is the day the export is wrong. "Rows about me" is a stable predicate the
 * database can answer — `userId = caller` — and it is also what a data-subject
 * access request actually asks for. A departing member wants their own hours,
 * tasks and comments, not a read-only copy of the company.
 *
 * Access control:
 *   1. Middleware blocks unauthenticated /api/* that isn't on the public
 *      allow-list. `requireScopedSession()` re-asks here against the role the
 *      Node jwt callback just refreshed from the live row, so a stale or
 *      revoked cookie cannot carry a demoted co-founder past the gate.
 *   2. Role gate, via the SAME `canSeeFinances` predicate the sidebar, the
 *      middleware and /reports use — not a parallel `role === "member"` check
 *      that a fourth role would slide past.
 *   3. Every query is scoped to `session.companyId`, so no forged request
 *      reaches another workspace's rows.
 *   4. A rate limiter, per caller and per scope, consumed AFTER the role gate and
 *      BEFORE the first read (rep-010). See ./rate-limit.ts for the numbers and
 *      the argument; the ordering is the load-bearing part.
 *
 * PII / secret posture:
 *   - `passwordHash` is stripped from every user row in both scopes. A bcrypt
 *     hash is still credential material; it never leaves the database.
 *   - `InviteToken.token` is stripped. That token is a live join secret —
 *     anyone holding it can accept the invite and enter the workspace. We
 *     keep the invite METADATA (who/when/status) but never the secret.
 *   - `Notification` is read PER-CALLER in both scopes — the one table here
 *     that is not workspace-level data. See the block on that query; this used
 *     to be the quiet compliance hole the chat layer explicitly refused to
 *     open.
 *   - CHAT IS IN NEITHER SCOPE. `Message` / `Channel` are absent on purpose:
 *     lib/auth/channel-permissions.ts:46-54 says a compliance export of
 *     conversation content has to be an explicit, audited, logged path, and a
 *     self-service download is none of those things. A message you authored in
 *     a private channel is still a row in that channel's history.
 *   - Everything else in the workspace IS the customer's data and is
 *     theirs to take.
 *
 * Serialization:
 *   - `Decimal` money columns (Transaction.amount, RecurringRule.amount,
 *     Budget.monthlyLimit) are converted to JS numbers so the export is
 *     plain JSON, not Prisma.Decimal string wrappers. Only the workspace
 *     scope has any of them.
 *   - Dates serialize to ISO 8601 automatically via JSON.stringify.
 *   - Soft-deleted rows (deletedAt != null) are excluded — this exports
 *     the LIVE data, matching what the app shows. Tombstoned rows are
 *     recoverable via ops for 90 days and aren't "current" data.
 *   - EXCEPTION: users are exported regardless of deletedAt. A member who
 *     deletes their own account is soft-deleted, but their activities,
 *     comments, and time entries survive and still reference their userId.
 *     Dropping the user row would leave those references dangling in the
 *     export, so we keep the row (minus passwordHash) and carry its
 *     deletedAt so a consumer can tell they've departed. (Adversarial
 *     review finding, 2026-07-04.) The same holds for the caller's own row
 *     in `scope=me`: someone mid-deletion is exactly who needs this.
 *
 * Known scale ceiling: the workspace handler loads every row of every table
 * into memory and serializes one JSON document. Fine for current workspace
 * sizes (hundreds–low-thousands of rows). If a single workspace ever reaches
 * ~100k+ rows in the append-only tables (activities/notifications/time),
 * rework this to stream NDJSON per table with a keyset cursor + set
 * `maxDuration`. Tracked from the same review. Not attacker-triggerable
 * (auth + finance-role gated), so it's a reliability ceiling, not a risk.
 * `scope=me` is bounded by one person's own rows and is not near that.
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { canSeeFinances } from "@/lib/auth/role-gates";
import { requireScopedSession, type ScopedSession } from "@/lib/queries/session";
import { captureServerError } from "@/lib/sentry-server";
// rep-010. Declared in a sibling module, not here: Next validates a Route
// Handler's export surface and an extra named export is a build error. See that
// file for the numbers and why the bucket is per (scope, caller).
import { exportLimitKey, exportLimiter } from "./rate-limit";

export const runtime = "nodejs"; // Prisma needs Node
export const dynamic = "force-dynamic"; // never cache a per-workspace export
// Give the full-table read + serialize more headroom than the default so a
// medium workspace doesn't hit a premature platform timeout. The real fix
// for very large workspaces is streaming (see header) — this is the guard
// until then.
export const maxDuration = 60;

type ExportScope = "workspace" | "me";

/**
 * The activity types that name a money figure. There is no shared predicate for
 * this in lib/ yet — `lib/actions/notifications.ts` gates on the Notification
 * `category` column, and Activity has no equivalent column — so the list lives
 * with the one reader that needs it. If Activity ever grows a category, delete
 * this and read that instead.
 */
// Typed `string[]`, not `as const`: Prisma's `notIn` takes a mutable
// `string[]`, and a readonly tuple is not assignable to it.
const FINANCE_ACTIVITY_TYPES: string[] = [
  "expense_added",
  "investment_added",
  "revenue_added",
  "transaction_deleted",
];

/** The Notification topic bucket the finance wall is about. */
const FINANCE_CATEGORY = "finance";

/**
 * Workspace tables this export deliberately does NOT contain, and why.
 *
 * data-integrity-008. The four chat tables landed on 2026-09-24 and the export
 * did not learn about them for five days — during which nothing anywhere could
 * tell "deliberately excluded" from "nobody noticed". The exclusion itself was
 * then argued at length in this file's header, which is the right decision in the
 * wrong shape: prose cannot fail a build.
 *
 * So the decision is declared here instead. `tests/lib/db/export-coverage.test.ts`
 * derives the list of `companyId`-bearing models from prisma/schema.prisma and
 * demands that each one is either READ by this route or named below with a
 * reason — so the thirteenth workspace table is covered on the day it lands. The
 * same design as `PURGE_EXCLUDED` in the purge cron.
 *
 * It is also SURFACED IN THE FILE, under `meta.notIncluded`. A customer
 * exercising a portability request is entitled to know what the download does not
 * contain; the silence was the part of the finding that was genuinely wrong.
 *
 * Adding an entry is allowed. Adding one without a reason a customer would accept
 * is not, and the test enforces the length of it.
 */
const EXPORT_EXCLUDED = new Map<string, string>([
  [
    "Channel",
    "Conversation content. lib/auth/channel-permissions.ts refuses to give an " +
      "admin a back door into a private channel they were never invited to, and " +
      "says a compliance export has to be an explicit, audited, logged path — " +
      "which a self-service download is not. Findings sec-007 / rep-002.",
  ],
  [
    "Message",
    "Same reason as Channel: a message you authored in a private channel is " +
      "still a row in that channel's history, and this route is not the audited " +
      "path lib/auth/channel-permissions.ts requires. Notification is ALSO read " +
      "per-caller here, though the reason narrowed: chat used to copy 140 " +
      "characters of a message body onto DM and mention pings, and no longer " +
      "writes in-app rows at all (skipInApp, lib/notify/fan-out.ts). Legacy rows " +
      "from before that change still hold those excerpts, and task and " +
      "transaction comment mentions still quote bodies today, so per-caller " +
      "scoping stays load-bearing either way.",
  ],
  [
    "BillingEvent",
    "Our own ledger of LemonSqueezy webhook DELIVERIES, not a record of the " +
      "workspace's activity: one row per signed provider callback, kept as the " +
      "idempotency key that makes a replayed delivery a no-op (bill-009). Each " +
      "row holds the provider's raw signed payload and its webhook id, which are " +
      "security material for the endpoint rather than the customer's data. The " +
      "billing FACTS a customer would want are already in this file, on the " +
      "company row: plan, subscriptionStatus, currentPeriodEnd, " +
      "billingSubscriptionId. Invoices come from the LemonSqueezy customer " +
      "portal linked in Settings, which is the merchant of record for them.",
  ],
]);

/** The excluded tables, as the export file discloses them to the customer. */
function notIncludedNote(): Array<{ table: string; reason: string }> {
  const out: Array<{ table: string; reason: string }> = [];
  EXPORT_EXCLUDED.forEach((reason, table) => out.push({ table, reason }));
  return out;
}

/**
 * Which export the caller asked for, or `null` for a value we don't recognise.
 *
 * `req` is optional because a Route Handler is also an ordinary async function:
 * the unit tests call `GET()` directly, and a handler that dereferences its
 * argument unconditionally cannot be called that way. No request means no query
 * string, which is the historical default — the workspace file.
 */
function requestedScope(req?: Request): ExportScope | null {
  if (!req?.url) return "workspace";
  let raw: string | null = null;
  try {
    raw = new URL(req.url).searchParams.get("scope");
  } catch {
    // An unparseable URL is not a scope request; fall through to the default
    // rather than 500 on a malformed Request the platform should never hand us.
    raw = null;
  }
  if (raw === null || raw === "") return "workspace";
  if (raw === "workspace" || raw === "me") return raw;
  return null;
}

/** The shared download headers — an export is a file, never a page. */
function download(json: string, filename: string): NextResponse {
  return new NextResponse(json, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

/**
 * DECLARED TWICE ON PURPOSE, and it is load-bearing in two directions.
 *
 * Next's generated route types (.next/types/app/api/export/route.ts) assert
 * that a handler's first parameter is assignable to `Request | NextRequest`,
 * so `GET(req?: Request)` is a BUILD ERROR — `undefined` is not a Request.
 * But a Route Handler is also an ordinary async function, and the export's
 * tests (here and in tests/lib/auth/finance-gate.test.ts) call `GET()`
 * directly, because the questions they ask — which role is refused, which
 * WHERE clause was sent — have nothing to do with an HTTP envelope.
 *
 * Overloads satisfy both: TypeScript infers a conditional type from the LAST
 * call signature, so Next sees the no-argument one and is happy, while callers
 * resolve top-down and may pass a Request. Do not "simplify" this to a single
 * optional parameter — that is the combination neither side accepts.
 */
export async function GET(req: Request): Promise<Response>;
export async function GET(): Promise<Response>;
export async function GET(req?: Request): Promise<Response> {
  const session = await requireScopedSession();
  const scope = requestedScope(req);

  if (scope === null) {
    return NextResponse.json(
      { error: 'Unknown export scope. Use "workspace" or "me".' },
      { status: 400 }
    );
  }

  // The gate, asked once, before any read. `scope=me` is open to every role;
  // `scope=workspace` is not, and a member asking for it gets the same refusal
  // and the same zero database reads it always did.
  if (scope === "workspace" && !canSeeFinances(session.role)) {
    return NextResponse.json(
      {
        error:
          "Only an admin or co-founder can export the workspace. " +
          "Use /api/export?scope=me for a copy of your own data.",
      },
      { status: 403 }
    );
  }

  // ── THE LIMITER (rep-010) ──────────────────────────────────────────────────
  //
  // AFTER the 400 and the 403, BEFORE any read. Both of those refusals do zero
  // database work, so they cost nothing to serve, and charging them would only
  // let a member with no export rights burn a budget they cannot spend.
  // Everything past this line issues twelve unbounded `findMany` calls in one
  // `Promise.all` and serializes the result into a single document, which is why
  // the check has to precede it: a 429 returned after the reads have run prices
  // nothing at all.
  //
  // This endpoint had no limiter of any kind while every other consequential
  // operation in lib/actions/ had one, and while FaultsAudit.md described it as
  // "admin-only, rate-limited". It is the heaviest query in the app and the one
  // that returns every transaction, every email address, every comment and every
  // time entry, so unlimited repeats are both an exfiltration channel and the
  // cheapest self-inflicted denial of service available to a signed-in session.
  const verdict = exportLimiter.consume(exportLimitKey(scope, session.userId));
  if (!verdict.allowed) {
    return NextResponse.json(
      {
        error:
          verdict.error ?? "That's a lot of exports in a short window. Try again in a few minutes.",
      },
      {
        status: 429,
        headers: {
          // Seconds, per RFC 9110. /settings surfaces any non-200 as a toast;
          // this is for anything scripted against the endpoint.
          "Retry-After": String(Math.max(1, Math.ceil(verdict.retryAfterMs / 1000))),
          "Cache-Control": "no-store",
        },
      }
    );
  }

  try {
    return scope === "me" ? await personalExport(session) : await workspaceExport(session);
  } catch (e) {
    captureServerError(e, {
      action: scope === "me" ? "exportMyData" : "exportWorkspace",
      userId: session.userId,
      companyId: session.companyId,
    });
    return NextResponse.json(
      { error: "Couldn't build your export right now. Try again shortly." },
      { status: 500 }
    );
  }
}

/* ───────────────────────── scope=me — the caller's own rows ─────────────── */

/**
 * Everything the product holds ABOUT this person, in their workspace.
 *
 * WHAT IS DELIBERATELY NOT HERE, and why each one is absent rather than
 * filtered:
 *
 *   • Transaction / Budget / RecurringRule — not queried at all, in any role.
 *     Money belongs to the workspace, not to a person, so even an admin taking
 *     a personal download gets their own rows and not the ledger; the ledger is
 *     what `scope=workspace` is for. This is also what makes the finance wall
 *     structural: there is no clause here for a later edit to weaken.
 *   • Company — its row carries the workspace currency, which /settings already
 *     hides from members as finance-adjacent context. `meta.companyId` is
 *     enough to say which workspace the file came from.
 *   • Project — a project is not data about a person. The tasks and time
 *     entries below carry their projectId and projectName.
 *   • Message / Channel — see the module header. Chat export is an audited
 *     path, not a self-service one.
 *
 * NARROWER THAN THE APP, ON PURPOSE, IN ONE PLACE: a per-project supervisor is
 * a member who may see their OWN project's finance notifications
 * (`canSeeProjectFinances`), and this drops those too. Reproducing that escape
 * hatch here would mean duplicating `hiddenFromReaderClauses` against a second
 * reader; being under-inclusive costs a supervisor a handful of pings in a file
 * they can regenerate, and being over-inclusive would be a leak that is
 * permanent once downloaded.
 */
async function personalExport(session: ScopedSession): Promise<NextResponse> {
  const { userId, companyId, role } = session;
  const seesFinances = canSeeFinances(role);
  const live = { deletedAt: null } as const;

  const [me, tasks, timeEntries, comments, activities, notifications, notificationPreferences] =
    await Promise.all([
      // Not filtered on deletedAt: someone mid-account-deletion is exactly the
      // person asking for this file.
      db.user.findFirst({ where: { id: userId, companyId } }),
      // "Mine" through either end of the assignment — the work you were given
      // and the work you handed out are both your record of what you did.
      db.task.findMany({
        where: {
          companyId,
          ...live,
          OR: [{ assignedTo: userId }, { assignedBy: userId }],
        },
        orderBy: { createdAt: "asc" },
      }),
      db.timeEntry.findMany({
        where: { companyId, userId, ...live },
        orderBy: { clockInAt: "asc" },
      }),
      db.comment.findMany({
        where: {
          companyId,
          authorId: userId,
          ...live,
          // Comment.transactionId means the thread hangs off a ledger row, and
          // the body is then the explanation of a money movement. A member
          // cannot reach that surface to write one today, so this clause is
          // belt-and-braces — but it is the cheap kind, and it keeps the wall
          // in the query instead of in an assumption about the UI.
          ...(seesFinances ? {} : { transactionId: null }),
        },
        orderBy: { createdAt: "asc" },
      }),
      db.activity.findMany({
        where: {
          companyId,
          userId,
          ...(seesFinances ? {} : { type: { notIn: FINANCE_ACTIVITY_TYPES } }),
        },
        orderBy: { createdAt: "asc" },
      }),
      db.notification.findMany({
        where: {
          companyId,
          userId,
          // The same row the notifications page already hides from a member —
          // `Notification.message` copies the figure into the title text.
          ...(seesFinances ? {} : { category: { not: FINANCE_CATEGORY } }),
        },
        orderBy: { createdAt: "asc" },
      }),
      // No companyId column on this table — it hangs off the user directly.
      db.notificationPreference.findMany({ where: { userId }, orderBy: { event: "asc" } }),
    ]);

  if (!me) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }

  const { passwordHash: _passwordHash, ...user } = me;

  const payload = {
    meta: {
      format: "founderflow-personal-export",
      scope: "me" as const,
      version: 1,
      exportedAt: new Date().toISOString(),
      exportedBy: { id: userId, role },
      companyId,
      note:
        "Your own data from this workspace: your profile, the tasks you were " +
        "assigned or assigned to others, your tracked time, your comments, " +
        "your activity and your notification settings. Workspace-level " +
        "records (finances, other people's rows) are not included, and " +
        "password hashes are intentionally omitted.",
    },
    user,
    tasks,
    timeEntries,
    comments,
    activities,
    notifications,
    notificationPreferences,
    counts: {
      tasks: tasks.length,
      timeEntries: timeEntries.length,
      comments: comments.length,
      activities: activities.length,
      notifications: notifications.length,
      notificationPreferences: notificationPreferences.length,
    },
  };

  const stamp = new Date().toISOString().slice(0, 10);
  return download(JSON.stringify(payload, null, 2), `founderflow-my-data-${stamp}.json`);
}

/* ──────────────────── scope=workspace — unchanged behaviour ─────────────── */

async function workspaceExport(session: ScopedSession): Promise<NextResponse> {
  const { userId, companyId, role } = session;
  const live = { deletedAt: null } as const;

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
    // ── THE ONE PER-PERSON TABLE IN THIS SCOPE ────────────────────────────
    //
    // `where: { companyId }` alone — every user's rows — was a content leak
    // wearing a portability label. `Notification.message` is a COPY of
    // conversation text: chat fan-out stores a 140-character slice of the
    // message body on the DM ping and on the @mention ping
    // (lib/actions/chat.ts), so a DM between a co-founder and a member, and
    // any mention inside a private channel the exporter was never invited to,
    // landed verbatim in their JSON. lib/auth/channel-permissions.ts:46-54
    // refuses precisely this in the chat layer — "an admin does NOT get a
    // back door into a private channel they were not invited to... If the
    // business ever needs legal/compliance export, that is an explicit,
    // auditable, logged path" — and the export was that back door, unlogged,
    // with nothing in the UI saying it had happened. Findings sec-007 /
    // rep-002.
    //
    // Scoped to the caller rather than stripped of its `message` field,
    // because a notification is addressed to ONE person the way an email is:
    // the other rows are not the exporter's to take in any form. The reads
    // above stay company-scoped — transactions, tasks, comments and
    // activities are the workspace's own records.
    //
    // If a genuine compliance export is ever needed, build it as the separate
    // audited path canSeeChannel describes. Do not widen this one.
    db.notification.findMany({
      where: { companyId, userId },
      orderBy: { createdAt: "asc" },
    }),
    db.inviteToken.findMany({ where: { companyId }, orderBy: { createdAt: "asc" } }),
  ]);

  if (!company) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  const payload = {
    meta: {
      format: "founderflow-workspace-export",
      scope: "workspace" as const,
      version: 1,
      exportedAt: new Date().toISOString(),
      exportedBy: { id: userId, role },
      companyId,
      note:
        "Your workspace data, exported for portability. Money amounts are " +
        "in the workspace currency. Password hashes are intentionally omitted.",
      // data-integrity-008. What this file deliberately does NOT contain, stated
      // in the file. The omissions are privacy decisions (see EXPORT_EXCLUDED),
      // but a customer exercising a portability request cannot evaluate a
      // decision they were never told about — and silence is indistinguishable
      // from a table nobody remembered.
      notIncluded: notIncludedNote(),
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
    // The EXPORTER's notifications only — see the query. `counts.notifications`
    // below counts the same scoped set, so a consumer comparing it against the
    // workspace's roster is not misled into thinking rows went missing.
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

  const stamp = new Date().toISOString().slice(0, 10);
  const safeName = company.name
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  const filename = `founderflow-${safeName || "workspace"}-${stamp}.json`;

  return download(JSON.stringify(payload, null, 2), filename);
}
