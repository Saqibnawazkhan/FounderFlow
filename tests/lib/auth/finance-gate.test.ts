/**
 * The finance gate, tested where the DATA is decided — not where it is painted.
 *
 * ONE BUG IN FOUR PLACES. "Members never see finance pages" is audit-flow #1 of
 * the rebuild plan, and the product implemented it almost entirely at render
 * time: middleware redirects a member off /expenses, components paint an
 * em-dash over a figure, the notification dropdown filters rows by their link.
 * Every one of those happens AFTER the money has been read, and three of them
 * happen after it has left the server. So the money reached members anyway —
 * through the notification bell, through email and push, and through the RSC
 * payload of a project page. Findings sec-002, sec-004, sec-005, sec-006,
 * auth-003.
 *
 * WHY THESE SUITES SHARE A FILE. They are halves of one boundary and they only
 * mean something together: the middleware suite proves the route gate fails
 * CLOSED (it is the layer the other findings all leaned on), the notification
 * and budget suites prove a figure is not handed to a role that may not see it,
 * the team suite proves a privilege change actually takes effect instead of
 * waiting for a cookie to expire, and the export suite proves the same "read it
 * scoped, not filtered later" rule for the one endpoint that hands a whole
 * workspace over as a file. Splitting them across five files would let one rot
 * while the others stayed green, which is how the gap survived this long.
 *
 * WHAT IS AND IS NOT MOCKED. `lib/auth/role-gates.ts` and
 * `lib/auth/project-permissions.ts` are the REAL predicates throughout —
 * stubbing them would assert that the code calls a stub, not that it obeys the
 * rule the rest of the product obeys. Prisma is a recorder, because the
 * properties at stake are properties of the questions asked and of the
 * arguments passed, both of which are visible in the recording.
 *
 * `captureServerError` is mocked and ASSERTED NOT CALLED in the budget suite.
 * `checkBudgetThresholdAfterExpense` swallows everything it throws, by design —
 * a budget-check crash must never roll back somebody's expense — so a fake
 * client that answered wrongly would produce "zero notifications sent" and a
 * green test for the wrong reason.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { authConfig } from "@/auth.config";
import { checkBudgetThresholdAfterExpense } from "@/lib/budgets/check";
import { getNotifications } from "@/lib/queries/notifications";
import { acceptInviteAction, updateUserRoleAction } from "@/lib/actions/team";
import type { ScopedSession } from "@/lib/queries/session";

/* ─────────────────────────── the fake Prisma client ─────────────────────── */

type RecordedCall = { delegate: string; method: string; args: unknown[] };

const prisma = vi.hoisted(() => {
  const calls: { delegate: string; method: string; args: unknown[] }[] = [];
  /** What a delegate answers with, keyed "notification.findMany". */
  const answers = new Map<string, unknown>();

  function record(delegate: string, method: string, args: unknown[]) {
    calls.push({ delegate, method, args });
    const key = delegate + "." + method;
    // `has`, not `??`: a deliberate `null` answer (a findFirst that must miss)
    // has to be distinguishable from "not stubbed".
    if (answers.has(key)) return Promise.resolve(answers.get(key));
    return Promise.resolve(null);
  }

  // A Proxy rather than a hand-written `{ budget: { findFirst } }` fake, for the
  // reason tests/lib/queries/search-scoping.test.ts gives: a literal fake only
  // knows the delegates that existed the day it was written, so a query added
  // later throws here (best case) or, once somebody "fixes" the fake, joins the
  // module without any of the invariants below ever applying to it.
  const delegates = new Map<string, unknown>();
  function delegateFor(name: string) {
    const existing = delegates.get(name);
    if (existing) return existing;
    const made = new Proxy(
      {},
      {
        get(_target, method) {
          if (typeof method !== "string") return undefined;
          return (...args: unknown[]) => record(name, method, args);
        },
      }
    );
    delegates.set(name, made);
    return made;
  }

  const db: Record<string, unknown> = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== "string") return undefined;
        // Interactive transactions run their callback against the same fake, so
        // a `tx.user.update` is recorded exactly like a `db.user.update`. The
        // real client hands the callback a scoped client; for the questions
        // these tests ask, the distinction does not exist.
        if (prop === "$transaction") {
          return (cb: (tx: unknown) => unknown) => Promise.resolve(cb(db));
        }
        return delegateFor(prop);
      },
    }
  );

  return { calls, answers, db };
});

const notify = vi.hoisted(() => ({
  // The parameter is declared even though the body ignores it: without it the
  // mock's call tuple is `[]` and reading `mock.calls[0][0]` is a TS2493 at
  // typecheck (it passes fine under vitest, which is the trap).
  notifyUsers: vi.fn((_input: unknown) => Promise.resolve({ notified: 0 })),
}));

const sentry = vi.hoisted(() => ({ captureServerError: vi.fn() }));

const session = vi.hoisted(() => ({
  scoped: {
    userId: "u_admin",
    userName: "Ayesha",
    email: "ayesha@nimbus.app",
    companyId: "c_nimbus",
    role: "admin",
  } as ScopedSession,
}));

vi.mock("@/lib/db", () => ({ db: prisma.db }));
vi.mock("@/lib/notify/fan-out", () => ({ notifyUsers: notify.notifyUsers }));
vi.mock("@/lib/sentry-server", () => ({ captureServerError: sentry.captureServerError }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// auth-008 put a `tokenRedeem` gate on acceptInviteAction, which reads the
// client address through `next/headers`. That throws outside a request scope,
// so every test touching a rate-limited action mocks this module - see
// password-reset-deleted-account.test.ts for the same line. A fixed address is
// right here: this file asserts the FINANCE gate, not the throttle, and a
// stable key keeps one test from spending another's budget.
vi.mock("@/lib/client-ip", () => ({ getClientIp: () => Promise.resolve("203.0.113.7") }));
vi.mock("@/lib/queries/session", () => ({
  requireScopedSession: () => Promise.resolve(session.scoped),
}));
// lib/actions/team.ts reaches its gate through `auth()`, and imports signIn for
// the post-acceptance auto-login. Neither test below gets far enough to sign
// anyone in.
vi.mock("@/lib/auth", () => ({
  auth: () =>
    Promise.resolve({
      user: {
        id: session.scoped.userId,
        companyId: session.scoped.companyId,
        role: session.scoped.role,
      },
    }),
  signIn: vi.fn(),
  signOut: vi.fn(),
}));
// `import { AuthError } from "next-auth"` drags next-auth's env module in, which
// imports "next/server" in a form vitest cannot resolve from node_modules. The
// class identity is all team.ts uses it for.
vi.mock("next-auth", () => ({ AuthError: class AuthError extends Error {} }));

function asRole(role: ScopedSession["role"], userId = "u_admin") {
  session.scoped = {
    userId,
    userName: "Tester",
    email: "tester@nimbus.app",
    companyId: "c_nimbus",
    role,
  };
}

function callsTo(delegate: string, method?: string): RecordedCall[] {
  return prisma.calls.filter((c) => c.delegate === delegate && (!method || c.method === method));
}

beforeEach(() => {
  prisma.calls.length = 0;
  prisma.answers.clear();
  notify.notifyUsers.mockClear();
  sentry.captureServerError.mockClear();
  asRole("admin");
});

/* ───────────────── 1. the route gate must fail CLOSED ───────────────────── */

type AuthorizedFn = NonNullable<NonNullable<typeof authConfig.callbacks>["authorized"]>;
type AuthorizedArg = Parameters<AuthorizedFn>[0];

/**
 * Ask the middleware callback about one path as one user. `user: null` is an
 * anonymous request; anything else is the shape Auth.js hands us out of the
 * SIGNED COOKIE — which is the whole problem the suite is about, since the Edge
 * jwt callback does no database read.
 */
async function ask(path: string, user: Record<string, unknown> | null) {
  // `async` because the callback itself is synchronous — it returns a boolean,
  // not a promise — and `.resolves` needs one either way.
  const authorized = (authConfig.callbacks as { authorized: AuthorizedFn }).authorized;
  return authorized({
    auth: user === null ? null : { user, expires: "2099-01-01T00:00:00.000Z" },
    request: { nextUrl: new URL("https://app.founderflow.test" + path) },
  } as unknown as AuthorizedArg);
}

/** The redirect target, or null when the answer was a plain allow/deny. */
function redirectedTo(result: unknown): string | null {
  if (typeof result === "boolean" || result === undefined || result === null) return null;
  const headers = (result as { headers?: { get(name: string): string | null } }).headers;
  return headers ? headers.get("location") : null;
}

const ADMIN = { id: "u1", companyId: "c_nimbus", role: "admin" };
const MEMBER = { id: "u2", companyId: "c_nimbus", role: "member" };

describe("authorized() — the middleware gate", () => {
  it("lets anonymous requests reach the public surface", async () => {
    await expect(ask("/", null)).resolves.toBe(true);
    await expect(ask("/login", null)).resolves.toBe(true);
    await expect(ask("/invite/abc123", null)).resolves.toBe(true);
  });

  it("refuses an anonymous request for anything else", async () => {
    await expect(ask("/expenses", null)).resolves.toBe(false);
    await expect(ask("/tasks", null)).resolves.toBe(false);
  });

  it("redirects a member off a finance route, keeping their querystring", async () => {
    const res = await ask("/expenses?ref=newsletter", MEMBER);
    expect(redirectedTo(res)).toContain("/tasks");
    expect(redirectedTo(res)).toContain("ref=newsletter");
  });

  it("lets a member through to their own surfaces", async () => {
    await expect(ask("/tasks", MEMBER)).resolves.toBe(true);
    await expect(ask("/time", MEMBER)).resolves.toBe(true);
  });

  it("lets admin and cofounder through to finance", async () => {
    await expect(ask("/expenses", ADMIN)).resolves.toBe(true);
    await expect(ask("/dashboard", { ...MEMBER, role: "cofounder" })).resolves.toBe(true);
  });

  // ── the three fail-OPEN shapes ────────────────────────────────────────────
  //
  // A CRITICAL next-auth advisory ("Configuration errors can cause
  // existence-based auth checks to fail open") describes exactly the mistake
  // this callback made: it asked whether a session OBJECT existed and whether a
  // role string equalled "member". Both are existence checks, and both answer
  // "allowed" for a session that carries no identity or a role nobody
  // recognises. The gate has to be an allow-list of roles that PASS
  // canSeeFinances, over a session that actually identifies somebody.

  it("refuses a session object that carries no user", async () => {
    await expect(ask("/tasks", {})).resolves.toBe(false);
    await expect(ask("/expenses", {})).resolves.toBe(false);
  });

  it("refuses a session whose user has no id", async () => {
    await expect(ask("/tasks", { companyId: "c_nimbus", role: "admin" })).resolves.toBe(false);
  });

  it("refuses a session whose user has no companyId", async () => {
    // Every scoped query throws on this token anyway; a 500 inside an RSC is a
    // worse answer than a bounce to /login.
    await expect(ask("/tasks", { id: "u1", role: "admin" })).resolves.toBe(false);
  });

  it("treats an unrecognised role as a member on finance routes", async () => {
    // The shape that fails open: `role === "member"` is false for
    // "accountant", so the old gate returned true and handed a role nobody has
    // implemented the full company ledger.
    const res = await ask("/expenses", { id: "u3", companyId: "c_nimbus", role: "accountant" });
    expect(redirectedTo(res)).toContain("/tasks");
  });

  it("treats a missing role as a member on finance routes", async () => {
    const res = await ask("/budgets", { id: "u4", companyId: "c_nimbus" });
    expect(redirectedTo(res)).toContain("/tasks");
  });
});

/* ──────── 2. the notification dropdown must not carry finance rows ──────── */

function notificationRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "n1",
    userId: "u_member",
    companyId: "c_nimbus",
    projectId: null,
    title: "Ayesha logged an expense",
    message: "Ayesha logged 743,219 PKR",
    type: "info",
    category: "finance",
    read: false,
    link: "/projects/p1",
    createdAt: new Date("2026-09-20T10:00:00.000Z"),
    ...overrides,
  };
}

describe("getNotifications — finance rows are stripped by CATEGORY, not by link", () => {
  it("drops a project-linked finance ping from a plain member", async () => {
    // The exact row addTransactionAction fans out: category "finance", a rupee
    // figure in the body, and a link to /projects/<id> — which is NOT in
    // MEMBER_BLOCKED_ROUTES, so the link-based filter waved it straight
    // through to the member's bell.
    prisma.answers.set("notification.findMany", [notificationRow()]);
    prisma.answers.set("project.findMany", []); // supervises nothing
    asRole("member", "u_member");

    const rows = await getNotifications();

    expect(rows).toHaveLength(0);
  });

  it("keeps it for the supervisor of that project, even though they are a member", async () => {
    // The supervisor escape hatch: canSeeProjectFinances admits them, so the
    // figure is theirs to see.
    prisma.answers.set("notification.findMany", [notificationRow({ projectId: "p1" })]);
    prisma.answers.set("project.findMany", [{ id: "p1" }]);
    asRole("member", "u_supervisor");

    const rows = await getNotifications();

    expect(rows).toHaveLength(1);
    expect(rows[0].message).toContain("743,219");
  });

  it("drops a finance row whose project the member merely works in", async () => {
    prisma.answers.set("notification.findMany", [notificationRow({ projectId: "p_other" })]);
    prisma.answers.set("project.findMany", [{ id: "p1" }]); // supervises p1, not p_other
    asRole("member", "u_supervisor");

    await expect(getNotifications()).resolves.toHaveLength(0);
  });

  it("still drops a finance row that links to a blocked route", async () => {
    // The original filter, kept as belt and braces.
    prisma.answers.set("notification.findMany", [
      notificationRow({ link: "/expenses?highlight=x" }),
    ]);
    prisma.answers.set("project.findMany", []);
    asRole("member", "u_member");

    await expect(getNotifications()).resolves.toHaveLength(0);
  });

  it("keeps non-finance rows for a member", async () => {
    prisma.answers.set("notification.findMany", [
      notificationRow({ category: "task", title: "Task assigned", link: "/tasks" }),
      notificationRow({ id: "n2", category: "team", title: "Your role changed", link: "/team" }),
    ]);
    prisma.answers.set("project.findMany", []);
    asRole("member", "u_member");

    await expect(getNotifications()).resolves.toHaveLength(2);
  });

  it("gives an admin everything, and does not pay for the supervisor lookup", async () => {
    prisma.answers.set("notification.findMany", [notificationRow()]);
    asRole("admin");

    const rows = await getNotifications();

    expect(rows).toHaveLength(1);
    expect(callsTo("project")).toHaveLength(0);
  });

  it("does not look up supervised projects when the member has no finance rows", async () => {
    prisma.answers.set("notification.findMany", [
      notificationRow({ category: "task", link: "/tasks" }),
    ]);
    asRole("member", "u_member");

    await getNotifications();

    expect(callsTo("project")).toHaveLength(0);
  });
});

/* ─────────── 3. budget breach figures must not be mailed to members ─────── */

/** A Prisma.Decimal stand-in — only `.toNumber()` is ever called on it. */
function decimal(n: number) {
  return { toNumber: () => n };
}

const SUPERVISOR_ID = "u_supervisor";
const PLAIN_MEMBER_ID = "u_plain_member";
const COFOUNDER_ID = "u_cofounder";

/**
 * A Marketing budget capped at 800,000 with 743,219 spent — over the 80%
 * warning line, so `decideThreshold` fires. The project's supervisor is a
 * plain member (the escape hatch), and its only tasks belong to a plain member
 * and a cofounder.
 */
function stockBudgetBreach(currency = "PKR") {
  prisma.answers.set("budget.findFirst", {
    id: "b1",
    companyId: "c_nimbus",
    projectId: "p1",
    category: "Marketing",
    monthlyLimit: decimal(800000),
    active: true,
    deletedAt: null,
    lastWarnedMonth: null,
    lastAlertedMonth: null,
  });
  prisma.answers.set("transaction.aggregate", { _sum: { amount: decimal(743219) } });
  prisma.answers.set("project.findUnique", {
    id: "p1",
    name: "Nimbus Rebuild",
    supervisorId: SUPERVISOR_ID,
  });
  prisma.answers.set("company.findFirst", { currency });
  prisma.answers.set("company.findUnique", { currency });
  prisma.answers.set("budget.updateMany", { count: 1 });
  prisma.answers.set("task.findMany", [
    { assignedTo: PLAIN_MEMBER_ID },
    { assignedTo: COFOUNDER_ID },
  ]);
  prisma.answers.set("user.findMany", [
    { id: SUPERVISOR_ID, role: "member" },
    { id: PLAIN_MEMBER_ID, role: "member" },
    { id: COFOUNDER_ID, role: "cofounder" },
  ]);
}

/** The single notifyUsers call the check makes, as a typed object. */
function fannedOut() {
  expect(notify.notifyUsers).toHaveBeenCalledTimes(1);
  return notify.notifyUsers.mock.calls[0][0] as unknown as {
    userIds: string[];
    title: string;
    message: string;
  };
}

describe("checkBudgetThresholdAfterExpense — who is told the cap and the spend", () => {
  it("does not send the figures to a plain assignee", async () => {
    stockBudgetBreach();

    await checkBudgetThresholdAfterExpense({
      companyId: "c_nimbus",
      projectId: "p1",
      category: "Marketing",
    });

    // Nothing was swallowed — see the file header for why this is asserted.
    expect(sentry.captureServerError).not.toHaveBeenCalled();
    const sent = fannedOut();
    // `budget_alert` defaults to email + push ON, so this set is an inbox and
    // a lock screen, not just a dropdown. A plain assignee cannot even open
    // the project's Budgets tab.
    expect(sent.userIds).not.toContain(PLAIN_MEMBER_ID);
    // The supervisor is a member, and keeps their own project's numbers.
    expect(sent.userIds).toContain(SUPERVISOR_ID);
    // A cofounder passes canSeeFinances company-wide.
    expect(sent.userIds).toContain(COFOUNDER_ID);
  });

  it("does not ask for assignees who were soft-deleted", async () => {
    stockBudgetBreach();

    await checkBudgetThresholdAfterExpense({
      companyId: "c_nimbus",
      projectId: "p1",
      category: "Marketing",
    });

    const taskReads = callsTo("task", "findMany");
    expect(taskReads).toHaveLength(1);
    const where = (taskReads[0].args[0] as { where: Record<string, unknown> }).where;
    expect(where.deletedAt).toBeNull();
  });

  it("quotes the workspace currency, not a hardcoded PKR", async () => {
    // Per-workspace currency shipped in 5bb359c; these strings are STORED on
    // the Notification row and EMAILED, so a USD workspace's history keeps the
    // wrong unit forever. Finding money-006.
    stockBudgetBreach("USD");

    await checkBudgetThresholdAfterExpense({
      companyId: "c_nimbus",
      projectId: "p1",
      category: "Marketing",
    });

    const sent = fannedOut();
    expect(sent.message).toContain("USD");
    expect(sent.message).not.toContain("PKR");
  });

  it("still says PKR for a PKR workspace", async () => {
    stockBudgetBreach("PKR");

    await checkBudgetThresholdAfterExpense({
      companyId: "c_nimbus",
      projectId: "p1",
      category: "Marketing",
    });

    expect(fannedOut().message).toContain("PKR");
  });

  it("sends nothing at all when only plain assignees would hear about it", async () => {
    stockBudgetBreach();
    // Supervisor tombstoned, so the live recipient list is a single plain
    // member: the fan-out must be skipped entirely rather than firing with an
    // empty list (and the sentinel is already claimed, which is correct —
    // there is no one to tell this month).
    prisma.answers.set("user.findMany", [{ id: PLAIN_MEMBER_ID, role: "member" }]);

    await checkBudgetThresholdAfterExpense({
      companyId: "c_nimbus",
      projectId: "p1",
      category: "Marketing",
    });

    expect(sentry.captureServerError).not.toHaveBeenCalled();
    expect(notify.notifyUsers).not.toHaveBeenCalled();
  });
});

/* ────────── 4. a privilege change has to end the old session ────────────── */

describe("updateUserRoleAction — a role change invalidates the old token", () => {
  it("bumps sessionVersion in the same update as the role", async () => {
    prisma.answers.set("user.findUnique", {
      id: "u_target",
      name: "Bilal",
      companyId: "c_nimbus",
      role: "cofounder",
      email: "bilal@nimbus.app",
    });
    prisma.answers.set("user.count", 2);

    const res = await updateUserRoleAction({ userId: "u_target", role: "member" });

    expect(res.success).toBe(true);
    const updates = callsTo("user", "update");
    expect(updates).toHaveLength(1);
    const data = (updates[0].args[0] as { data: Record<string, unknown> }).data;
    // ONE update, not two. The role and the revocation must land together or
    // not at all — the same reasoning password-reset.ts:153 gives for bumping
    // inline with the new hash. Without the bump, the demoted user's cookie
    // keeps its old `role` claim (the Edge jwt callback does no DB read) and
    // middleware keeps letting them into /expenses for the token's lifetime.
    expect(data.role).toBe("member");
    expect(data.sessionVersion).toEqual({ increment: 1 });
  });
});

describe("acceptInviteAction — an invite into a deleted workspace", () => {
  it("refuses a token whose workspace has been tombstoned", async () => {
    // Invites live 7 days, so a token can outlive the workspace it was sent
    // for. Accepting one used to mint a LIVE user inside a dead company: some
    // pages throw, others render, and everything they enter is hard-deleted by
    // the purge cron on day 90. Finding data-integrity-003 / acct-003.
    //
    // THIS COMMENT USED TO SAY softDeleteWorkspace "never" touches the
    // InviteToken rows. That is no longer true — acct-003 made the sweep
    // hard-delete every unused token for the company inside the same
    // $transaction as the tombstone (lib/actions/account.ts, pinned in
    // tests/lib/actions/workspace-lifecycle.test.ts) — and a stale present-tense
    // claim about a safety mechanism is this repo's signature defect, so it is
    // corrected rather than left as period detail.
    //
    // The check below is still the one that matters, and not as belt-and-braces
    // theatre: tokens written for workspaces deleted BEFORE that burn shipped
    // are still in the database with nothing having burnt them, and this is the
    // refusal a future delete path cannot bypass by forgetting to clean up.
    prisma.answers.set("inviteToken.findUnique", {
      id: "i1",
      token: "tok_live",
      email: "new@nimbus.app",
      name: "Newcomer",
      role: "member",
      companyId: "c_nimbus",
      invitedBy: "u_admin",
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      usedAt: null,
      company: { deletedAt: new Date("2026-09-01T00:00:00.000Z") },
    });

    const res = await acceptInviteAction({ token: "tok_live", password: "Str0ngPass" });

    expect(res.success).toBe(false);
    // No account was created, and nothing was signed in.
    expect(callsTo("user", "create")).toHaveLength(0);
    expect(sentry.captureServerError).not.toHaveBeenCalled();
  });

  it("reads the workspace's tombstone alongside the token", async () => {
    prisma.answers.set("inviteToken.findUnique", null);

    await acceptInviteAction({ token: "tok_missing", password: "Str0ngPass" });

    const reads = callsTo("inviteToken", "findUnique");
    expect(reads).toHaveLength(1);
    // One round trip, through the relation — not a second query somebody can
    // forget to add to a new code path.
    expect(JSON.stringify(reads[0].args[0])).toContain("deletedAt");
  });
});

/* ───── 5. the workspace export is not a back door into private chat ─────── */

/** Every table the export reads, so nothing 500s on a missing stub. */
function stockExportTables() {
  const tables = [
    "user.findMany",
    "project.findMany",
    "task.findMany",
    "transaction.findMany",
    "budget.findMany",
    "recurringRule.findMany",
    "timeEntry.findMany",
    "comment.findMany",
    "activity.findMany",
    "notification.findMany",
    "inviteToken.findMany",
  ];
  for (const key of tables) prisma.answers.set(key, []);
  prisma.answers.set("company.findFirst", {
    id: "c_nimbus",
    name: "Nimbus",
    deletedAt: null,
  });
}

describe("GET /api/export — notification rows belong to one person", () => {
  it("scopes the notification read to the exporting user", async () => {
    // Notification.message is a COPY of conversation content: chat fan-out
    // stores a 140-char slice of the body on both the DM ping and the @mention
    // ping (lib/actions/chat.ts). Reading the table per-company therefore handed
    // an admin the text of DMs between two other teammates and of mentions
    // inside private channels they were never invited to — the exact back door
    // lib/auth/channel-permissions.ts:46-54 refuses to open in the chat layer.
    // Findings sec-007 / rep-002.
    //
    // Asserted on the WHERE clause, not on the response body: the fake client
    // answers whatever it is stocked with regardless of the filter, so the
    // filter is the only thing that can be wrong here — and it is the thing
    // that is wrong in production.
    stockExportTables();
    asRole("admin", "u_admin");
    const { GET } = await import("@/app/api/export/route");

    const res = await GET();

    expect(res.status).toBe(200);
    const reads = callsTo("notification", "findMany");
    expect(reads).toHaveLength(1);
    const where = (reads[0].args[0] as { where: Record<string, unknown> }).where;
    expect(where.companyId).toBe("c_nimbus");
    expect(where.userId).toBe("u_admin");
  });

  it("still reads the workspace-level tables per company", async () => {
    // The fix must not turn a data-portability export into "my rows only" —
    // transactions, tasks and activities are the company's records.
    stockExportTables();
    asRole("admin", "u_admin");
    const { GET } = await import("@/app/api/export/route");

    await GET();

    for (const delegate of ["transaction", "task", "activity", "comment"]) {
      const where = (callsTo(delegate, "findMany")[0].args[0] as { where: Record<string, unknown> })
        .where;
      expect(where.companyId).toBe("c_nimbus");
      expect(where.userId).toBeUndefined();
    }
  });

  it("refuses a member outright", async () => {
    stockExportTables();
    asRole("member", "u_member");
    const { GET } = await import("@/app/api/export/route");

    const res = await GET();

    expect(res.status).toBe(403);
    expect(prisma.calls).toHaveLength(0);
  });
});
