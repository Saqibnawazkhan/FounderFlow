/**
 * What a signup owes the person doing it — driven through `signupAction` with a
 * recording Prisma fake, because both defects here are about WHICH query is
 * asked and WHAT the transaction commits, not about a return value.
 *
 * TWO FINDINGS, FOUR IDS.
 *
 * acct-001 / auth-006 — THE ONE-WAY DOOR. `User.email` is globally `@unique`
 * and a soft-deleted row keeps its address for the whole 90-day retention
 * window (longer, in practice: the purge cron is DRY-RUN by default and
 * CLAUDE.md says that default is deliberate). Three queries then disagreed
 * about what a tombstone means. `signupAction`'s duplicate check had no
 * `deletedAt` filter, so it answered "An account with this email already
 * exists"; `authorize()` filters `deletedAt: null`, so signing in answered
 * "Invalid email or password"; and both password-reset lookups also skipped the
 * filter, so a reset ran to completion, wrote a new hash, bumped
 * sessionVersion, said "your password is set" — and sign-in still refused. A
 * customer who deleted an account was locked out of their own email address
 * with a message that flatly contradicted their experience, and the recovery
 * flow lied about having fixed it.
 *
 * The fix here is the honest message, NOT a filter on the pre-check. Adding
 * `deletedAt: null` to this lookup is the tempting one-liner and it is worse
 * than the bug: the unique index is global and does not care about tombstones,
 * so the insert would fail with P2002 and the user would get "Couldn't create
 * your account right now. The team has been notified." — the same lockout,
 * now wearing a server error. One test below exists purely to forbid that.
 *
 * projects-001 / tasks-and-comments-007 — THE FIRST TASK THAT CANNOT BE
 * SUBMITTED. `Task.projectId` is NOT NULL, `NewTaskSchema` requires it with the
 * message "Pick a project", and the only thing that had ever created a
 * "General" project was the one-shot backfill inside
 * 20260526151502_add_projects. A migration is a statement about the past. So a
 * workspace created today has zero projects, `listProjectOptions()` returns [],
 * the task form renders a single dead `<option value="">No projects yet</option>`
 * — and /tasks invites the founder to "Create your first task" with a CTA that
 * opens exactly that unsubmittable form. Members cannot create a project at
 * all (`canCreateProject`), so an invited teammate is stuck until an admin
 * happens to make one. This is the identical shape of the #general gap already
 * fixed two lines away, and lib/user/handle.ts already names the lesson: "a
 * backfill without a write path is a fix with an expiry date".
 *
 * WHY THE ASSERTIONS ARE ABOUT THE TRANSACTION. A project created AFTER the
 * commit would be the same bug with extra steps — a workspace that exists
 * without the thing the product immediately asks it to use. So the fake records
 * whether each call happened inside `$transaction`, and the test asserts that,
 * not merely that a row was written.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

/* ─────────────────────────────────────────────────────────────────────────── */
/* Fake Prisma client                                                          */
/* ─────────────────────────────────────────────────────────────────────────── */

/**
 * `vi.mock` factories are hoisted above the imports, so anything they close
 * over has to be built inside `vi.hoisted` — a plain module-scope `const` is
 * still undefined when the factory runs, and the failure then looks like the
 * action calling a method on undefined rather than like a test-setup mistake.
 */
const H = vi.hoisted(() => {
  type Call = { path: string; args: Record<string, unknown>; inTx: boolean };
  const calls: Call[] = [];
  /** "model.op" → the value to resolve with, or a function of the call args. */
  const results = new Map<string, unknown>();
  const state = { inTx: false };

  // Only the models + operations this action actually touches. A short,
  // explicit list means a signup that starts reaching for a NEW table fails
  // loudly ("db.budget is undefined") instead of silently recording nothing.
  const MODELS = ["user", "company", "activity", "project", "channel", "channelMember"];
  const OPS = ["findUnique", "findFirst", "findMany", "create", "createMany", "update", "count"];

  const db: Record<string, Record<string, (args: Record<string, unknown>) => Promise<unknown>>> &
    Record<string, unknown> = {};

  MODELS.forEach((model) => {
    const ops: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {};
    OPS.forEach((op) => {
      ops[op] = (args: Record<string, unknown>) => {
        calls.push({ path: model + "." + op, args: args ?? {}, inTx: state.inTx });
        const key = model + "." + op;
        const stub = results.has(key) ? results.get(key) : undefined;
        const value = typeof stub === "function" ? (stub as (a: unknown) => unknown)(args) : stub;
        if (value !== undefined) return Promise.resolve(value);
        // Sensible defaults: a read finds nothing, a write returns a row with
        // a recognisable id, a count is zero.
        if (op === "findUnique" || op === "findFirst") return Promise.resolve(null);
        if (op === "findMany") return Promise.resolve([]);
        if (op === "count") return Promise.resolve(0);
        if (op === "createMany") return Promise.resolve({ count: 0 });
        return Promise.resolve({ id: model + "_new" });
      };
    });
    db[model] = ops;
  });

  // Cast: `db` is indexed as a map of model delegates, and $transaction
  // is not one of those — it takes a callback, not an args object.
  (db as unknown as Record<string, unknown>).$transaction = async (
    fn: (tx: unknown) => Promise<unknown>
  ) => {
    state.inTx = true;
    try {
      return await fn(db);
    } finally {
      state.inTx = false;
    }
  };

  return { calls, results, db };
});

const signIn = vi.hoisted(() => vi.fn(() => Promise.resolve(undefined)));
const sentry = vi.hoisted(() => ({ captureServerError: vi.fn() }));
const mail = vi.hoisted(() => ({ sendVerificationEmail: vi.fn(() => Promise.resolve(undefined)) }));

vi.mock("@/lib/db", () => ({ db: H.db }));
vi.mock("@/lib/auth", () => ({ signIn, signOut: vi.fn() }));
// The real `AuthError` pulls the whole next-auth entry point into a jsdom run
// for one `instanceof`; this is the only shape the action inspects.
vi.mock("next-auth", () => ({ AuthError: class AuthError extends Error {} }));
vi.mock("@/lib/sentry-server", () => ({ captureServerError: sentry.captureServerError }));
vi.mock("@/lib/email/verification", () => ({
  sendVerificationEmail: mail.sendVerificationEmail,
}));
// Real limiters would let five signups through and then start failing tests
// from their own side effects.
vi.mock("@/lib/rate-limit", () => ({
  limiters: { auth: { consume: () => ({ allowed: true }) } },
}));
vi.mock("@/lib/client-ip", () => ({ getClientIp: () => Promise.resolve("203.0.113.7") }));
// bcrypt at cost 12 is ~300ms per call and nothing here asserts on the hash.
vi.mock("bcryptjs", () => ({
  default: { hash: () => Promise.resolve("bcrypt$hash"), compare: () => Promise.resolve(true) },
}));

import { signupAction } from "@/lib/actions/auth";

/** A valid signup payload — the form always supplies all six fields. */
const INPUT = {
  name: "Ayesha Khan",
  email: "ayesha@nimbus.app",
  password: "Str0ng-Passw0rd!",
  companyName: "Nimbus Labs",
  industry: "SaaS",
  currency: "PKR",
};

function callsTo(path: string) {
  return H.calls.filter((c) => c.path === path);
}

/** The lookup the action uses to answer "is this address taken?". */
function duplicateCheck() {
  const found = H.calls.filter((c) => c.path === "user.findUnique" || c.path === "user.findFirst");
  return found[0];
}

beforeEach(() => {
  H.calls.length = 0;
  H.results.clear();
  signIn.mockClear();
  sentry.captureServerError.mockClear();
  mail.sendVerificationEmail.mockClear();
  // The two writes whose ids later assertions follow.
  H.results.set("company.create", { id: "c_nimbus" });
  H.results.set("user.create", { id: "u_ayesha" });
});

/* ─────────────────────────────────────────────────────────────────────────── */
/* acct-001 / auth-006 — the address held by a deleted account                 */
/* ─────────────────────────────────────────────────────────────────────────── */

describe("signupAction — an address whose account was deleted", () => {
  it("names the real reason instead of claiming the account still exists", async () => {
    H.results.set("user.findFirst", { id: "u_gone", deletedAt: new Date("2026-09-01") });
    H.results.set("user.findUnique", { id: "u_gone", deletedAt: new Date("2026-09-01") });

    const result = await signupAction(INPUT);

    expect(result.success).toBe(false);
    const error = result.success ? "" : result.error;
    // The user deleted this account themselves and is being told it exists.
    // Whatever the wording, it has to say the account was deleted and point
    // somewhere — the old message sent them to a login that then refused them.
    expect(error).not.toBe("An account with this email already exists");
    expect(error.toLowerCase()).toContain("deleted");
    expect(error.toLowerCase()).toMatch(/support|restore/);
  });

  it("does not half-create a workspace on the way to that message", async () => {
    H.results.set("user.findFirst", { id: "u_gone", deletedAt: new Date("2026-09-01") });
    H.results.set("user.findUnique", { id: "u_gone", deletedAt: new Date("2026-09-01") });
    await signupAction(INPUT);
    expect(callsTo("company.create")).toHaveLength(0);
    expect(callsTo("project.create")).toHaveLength(0);
    expect(signIn).not.toHaveBeenCalled();
  });

  it("still gives a live duplicate the plain message", async () => {
    H.results.set("user.findFirst", { id: "u_live", deletedAt: null });
    H.results.set("user.findUnique", { id: "u_live", deletedAt: null });
    const result = await signupAction(INPUT);
    expect(result).toEqual({
      success: false,
      error: "An account with this email already exists",
    });
  });

  it("asks a question that can see a tombstone, and does not filter it away", async () => {
    // The tempting one-liner is `where: { email, deletedAt: null }`. It would
    // make this lookup miss the tombstone, and then the INSERT fails on the
    // global unique index with P2002 — so the user gets "the team has been
    // notified" instead of a message about their own deleted account. Same
    // lockout, now wearing a server error.
    await signupAction(INPUT);
    const check = duplicateCheck();
    expect(check, "signupAction must look the address up before inserting").toBeTruthy();
    const where = check.args.where as Record<string, unknown>;
    expect(where.email).toBe(INPUT.email);
    expect(where).not.toHaveProperty("deletedAt");
    // …and it has to READ the tombstone, or it cannot tell the two cases apart.
    const select = check.args.select as Record<string, unknown> | undefined;
    expect(select === undefined || select.deletedAt === true).toBe(true);
  });
});

/* ─────────────────────────────────────────────────────────────────────────── */
/* projects-001 / tasks-and-comments-007 — a workspace that can hold a task    */
/* ─────────────────────────────────────────────────────────────────────────── */

describe("signupAction — the workspace commits able to take its first task", () => {
  it("creates a project, so the first task form has something to submit", async () => {
    const result = await signupAction(INPUT);
    expect(result.success).toBe(true);
    expect(callsTo("project.create")).toHaveLength(1);
  });

  it("names it 'General', the name the add_projects backfill used", async () => {
    // Old and new workspaces have to read alike: the backfill created
    // 'General' per company, lib/schemas/task.ts says the UI "auto-prefills
    // with 'General' when there's no other context", and a workspace whose
    // first project is called something else makes that comment false.
    await signupAction(INPUT);
    const data = callsTo("project.create")[0].args.data as Record<string, unknown>;
    expect(data.name).toBe("General");
    expect(data.companyId).toBe("c_nimbus");
  });

  it("puts the founder in charge of it", async () => {
    // supervisorId + createdBy are both NOT NULL, and the supervisor is who
    // `canSeeProject` lets in — a project supervised by nobody would be
    // invisible to the only person in the workspace.
    await signupAction(INPUT);
    const data = callsTo("project.create")[0].args.data as Record<string, unknown>;
    expect(data.supervisorId).toBe("u_ayesha");
    expect(data.createdBy).toBe("u_ayesha");
  });

  it("commits it with the workspace, not after it", async () => {
    // A project written after the transaction is the same bug with extra
    // steps: the workspace can commit without it. Same argument as
    // ensureGeneralChannel, which is created two statements away.
    await signupAction(INPUT);
    const project = callsTo("project.create")[0];
    const channel = callsTo("channel.create")[0];
    expect(project.inTx).toBe(true);
    expect(channel.inTx).toBe(true);
  });

  it("does not write an Activity row for it", async () => {
    // Nobody performed this action, and `ACTIVITY_META` is indexed without a
    // fallback — the same reason ensureGeneralChannel stays silent. One row:
    // company_created.
    await signupAction(INPUT);
    const types = callsTo("activity.create").map(
      (c) => (c.args.data as Record<string, unknown>).type
    );
    expect(types).toEqual(["company_created"]);
  });

  it("still signs the founder in", async () => {
    await signupAction(INPUT);
    expect(signIn).toHaveBeenCalledWith("credentials", {
      email: INPUT.email,
      password: INPUT.password,
      redirect: false,
    });
  });
});
