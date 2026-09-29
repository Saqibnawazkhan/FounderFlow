// @vitest-environment node

/**
 * acct-005 — every security-relevant account change must reach the address on
 * file AT THE TIME OF THE CHANGE.
 *
 * WHAT WAS ALREADY DONE, AND WHAT WAS NOT. The audit row names three loci. One
 * of them is already closed: `lib/actions/email-change.ts` has warned the OLD
 * address since the acct-004 / auth-005 wave — both on request and on
 * completion — and tests/lib/actions/email-change.test.ts already asserts it.
 * The brief's suggested red-first assertion ("changing the login email notifies
 * the OLD address") therefore passes before any change, which per house rule 3
 * is evidence that third of the finding is wrong. The two that are real:
 *
 *   • `changePasswordAction` (lib/actions/profile.ts) changed the credential and
 *     told nobody.
 *   • `deleteAccountAction` / `deleteWorkspaceAction` (lib/actions/account.ts)
 *     erased a workspace and told nobody — so the customer never received the
 *     one thing that carries the 90-day recovery deadline.
 *
 * WHY THE ASSERTIONS LOOK LIKE THIS. The cheap version of this file is
 * `expect(H.sent.length).toBe(1)`, which a notice mailed to the WRONG address
 * would satisfy, and a notice with no remedy in it would satisfy too. The whole
 * value of a security notice is (a) which inbox it lands in and (b) whether it
 * tells the reader what to do when it was not them. So every case below asserts
 * the recipient and the actionable content, and the password case additionally
 * asserts the new password is NOT in the body — a "your password was changed"
 * mail that quotes the password is a worse bug than the silence it replaces.
 *
 * THE QUOTA. `lib/email/quota.ts` is a 300/day budget with exactly one caller,
 * `lib/notify/email.ts`, and `claimEmailBudget` SILENTLY DROPS what it cannot
 * grant. Dropping a takeover alert is precisely the failure this finding is
 * about, and the quota's own docstring reserves the headroom below Gmail's cap
 * "for transactional mail: verification, password reset, email change,
 * invites". Security notices are that class, so they spend no budget — and the
 * last test in this file fails if anyone later "tidies" them into it.
 *
 * NODE ENVIRONMENT: nothing here renders, and the actions reach bcrypt and
 * `lib/env.ts`; jsdom buys nothing and costs a realm.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

/* ─────────────────────────────────────────────────────────────────────────── */
/* Fakes                                                                       */
/* ─────────────────────────────────────────────────────────────────────────── */

/**
 * `vi.mock` factories hoist above the imports, so everything they close over is
 * built in `vi.hoisted` — a plain module-scope `const` is still undefined when
 * the factory runs. Same note as tests/lib/actions/soft-delete.test.ts.
 */
const H = vi.hoisted(() => {
  const calls: Array<{ path: string; args: Record<string, unknown> }> = [];
  const results = new Map<string, unknown>();
  const sent: Array<{ to: string; subject: string; html: string; text?: string }> = [];

  const MODELS = [
    "transaction",
    "budget",
    "task",
    "project",
    "message",
    "comment",
    "timeEntry",
    "user",
    "company",
    "inviteToken",
    "pushSubscription",
  ];
  const OPS = [
    "findUnique",
    "findFirst",
    "findMany",
    "count",
    "update",
    "updateMany",
    "delete",
    "deleteMany",
  ];

  type Op = (args?: Record<string, unknown>) => Promise<unknown>;
  const db: Record<string, unknown> = {};
  for (const model of MODELS) {
    const delegate: Record<string, Op> = {};
    for (const op of OPS) {
      const path = `${model}.${op}`;
      delegate[op] = async (args?: Record<string, unknown>) => {
        calls.push({ path, args: args ?? {} });
        const canned = results.get(path);
        if (canned instanceof Error) throw canned;
        return typeof canned === "function"
          ? (canned as (a: Record<string, unknown>) => unknown)(args ?? {})
          : canned;
      };
    }
    db[model] = delegate;
  }
  db.$transaction = async (arg: unknown) =>
    typeof arg === "function"
      ? await (arg as (tx: unknown) => Promise<unknown>)(db)
      : await Promise.all(arg as Array<Promise<unknown>>);

  return { db, calls, results, sent, session: { value: null as unknown } };
});

vi.mock("@/lib/db", () => ({ db: H.db }));
vi.mock("@/lib/auth", () => ({
  auth: async () => H.session.value,
  signOut: async () => undefined,
  signIn: async () => undefined,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/sentry-server", () => ({ captureServerError: vi.fn() }));
vi.mock("@/lib/client-ip", () => ({ getClientIp: async () => "203.0.113.9" }));
vi.mock("@/lib/appearance/cookies", () => ({ clearAppearanceCookies: async () => undefined }));
vi.mock("@/lib/safety/bulk-mutation-guard", () => ({ warnBulkMutation: vi.fn() }));
vi.mock("@/lib/lemonsqueezy/config", () => ({
  isBillingConfigured: () => true,
  LS_STORE_ID: "store_1",
  LS_VARIANT_ID_TEAM: "variant_1",
  APP_URL: "https://founderflow.test",
}));
vi.mock("@lemonsqueezy/lemonsqueezy.js", () => ({
  lemonSqueezySetup: () => undefined,
  cancelSubscription: async (id: string | number) => ({ data: { data: { id } }, error: null }),
}));
// Work factor 12 runs several times per case here and the hash is never the
// thing under test. The real compare/hash are covered elsewhere.
vi.mock("bcryptjs", () => ({
  default: { compare: async () => true, hash: async () => "new-hash" },
}));
// Always-open limiters: these tests call the destructive paths more than five
// times from one address, and the buckets have their own coverage in
// tests/lib/rate-limit.test.ts. Spread the real module so a NEW export cannot
// silently break this suite — a factory mock REPLACES the module, and
// lib/actions/profile.ts calls `rateLimiter()` at module scope.
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  limiters: {
    auth: { consume: () => ({ allowed: true }) },
    write: { consume: () => ({ allowed: true }) },
    read: { consume: () => ({ allowed: true }) },
  },
  gateAuthAction: () => ({ allowed: true }),
}));
vi.mock("@/lib/email/send", () => ({
  sendEmail: async (input: { to: string; subject: string; html: string; text?: string }) => {
    H.sent.push(input);
    return { delivered: true, devLogged: false };
  },
}));

import { readFileSync } from "node:fs";
import path from "node:path";

import { changePasswordAction } from "@/lib/actions/profile";
import { deleteAccountAction, deleteWorkspaceAction } from "@/lib/actions/account";
import { remainingEmailBudget, __resetEmailBudget } from "@/lib/email/quota";
import { SECURITY_NOTICE_RETENTION_DAYS } from "@/lib/email/templates/security-notice";

/* ─────────────────────────────────────────────────────────────────────────── */
/* Helpers                                                                     */
/* ─────────────────────────────────────────────────────────────────────────── */

const OWNER_EMAIL = "founder@nimbus.app";
const TEAMMATE_EMAIL = "cofounder@nimbus.app";
const WORKSPACE = "Nimbus Labs";

function when(path: string, value: unknown): void {
  H.results.set(path, value);
}

function signedInAs(role: string, id = "u1"): void {
  H.session.value = { user: { id, companyId: "c1", role, email: OWNER_EMAIL } };
}

function me(over: Record<string, unknown> = {}) {
  return {
    id: "u1",
    name: "Saqib",
    email: OWNER_EMAIL,
    role: "admin",
    companyId: "c1",
    passwordHash: "hash",
    sessionVersion: 0,
    deletedAt: null,
    ...over,
  };
}

/** Every message this run addressed to `address`. */
function mailTo(address: string) {
  return H.sent.filter((m) => m.to.toLowerCase() === address.toLowerCase());
}

/** The one message addressed to `address`, or a failure that names the gap. */
function onlyMailTo(address: string) {
  const box = mailTo(address);
  if (box.length !== 1) {
    throw new Error(
      `expected exactly 1 email to ${address}, got ${box.length}` +
        ` (all recipients: ${H.sent.map((m) => m.to).join(", ") || "none"})`
    );
  }
  return box[0]!;
}

/** Subject + both bodies, lowercased — for "does the notice actually say it?" */
function bodyOf(mail: { subject: string; html: string; text?: string }): string {
  return `${mail.subject}\n${mail.html}\n${mail.text ?? ""}`.toLowerCase();
}

const VALID_PASSWORD_CHANGE = {
  currentPassword: "old-password-1A",
  newPassword: "Str0ngerPassphrase",
  confirmPassword: "Str0ngerPassphrase",
};

beforeEach(() => {
  H.calls.length = 0;
  H.results.clear();
  H.sent.length = 0;
  H.session.value = null;
  __resetEmailBudget();
  vi.clearAllMocks();
});

/* ─────────────────────────────────────────────────────────────────────────── */

describe("acct-005 — a password change tells the address on file", () => {
  beforeEach(() => {
    signedInAs("admin");
    when("user.findUnique", me());
    when("user.update", me({ passwordHash: "new-hash", sessionVersion: 1 }));
  });

  it("emails the account's own address after the password is changed", async () => {
    const res = await changePasswordAction(VALID_PASSWORD_CHANGE);
    expect(res.success).toBe(true);

    const notice = onlyMailTo(OWNER_EMAIL);
    expect(bodyOf(notice)).toContain("password");
  });

  it("tells the reader what to do if it was not them, with a reachable link", async () => {
    await changePasswordAction(VALID_PASSWORD_CHANGE);

    const body = bodyOf(onlyMailTo(OWNER_EMAIL));
    // The remedy has to be actionable, not "contact us": a password the reader
    // did not set means they cannot sign in, so the only door left is reset.
    expect(body).toContain("/forgot-password");
    expect(body).toMatch(/wasn't you|was not you|didn't|did not/);
  });

  it("never puts the new password in the message", async () => {
    await changePasswordAction(VALID_PASSWORD_CHANGE);

    const notice = onlyMailTo(OWNER_EMAIL);
    expect(notice.html).not.toContain(VALID_PASSWORD_CHANGE.newPassword);
    expect(notice.text ?? "").not.toContain(VALID_PASSWORD_CHANGE.newPassword);
  });

  it("sends nothing when the current password is wrong", async () => {
    const bcrypt = (await import("bcryptjs")).default;
    vi.spyOn(bcrypt, "compare").mockResolvedValueOnce(false as never);

    const res = await changePasswordAction(VALID_PASSWORD_CHANGE);
    expect(res.success).toBe(false);
    expect(H.sent).toEqual([]);
  });

  it("still reports success when the notice cannot be sent", async () => {
    // The write has already landed. A mailer fault must not tell the user their
    // password change failed — they would try the old password forever.
    const send = await import("@/lib/email/send");
    vi.spyOn(send, "sendEmail").mockRejectedValueOnce(new Error("smtp exploded"));

    const res = await changePasswordAction(VALID_PASSWORD_CHANGE);
    expect(res.success).toBe(true);
  });
});

describe("acct-005 — deleting an account sends the receipt that carries the deadline", () => {
  it("emails the leaving member when teammates remain", async () => {
    signedInAs("member", "u1");
    when("user.findUnique", me({ role: "member" }));
    when("user.count", 2); // otherUsers AND otherAdmins — both non-zero
    when("user.update", me());
    when("pushSubscription.deleteMany", { count: 0 });

    const res = await deleteAccountAction({ password: "pw" });
    expect(res.success).toBe(true);

    const body = bodyOf(onlyMailTo(OWNER_EMAIL));
    expect(body).toContain("deleted");
    // The receipt's whole job: the recovery window, as a date the reader can
    // act on, plus how to ask.
    expect(body).toMatch(/\b90\b/);
    expect(body).toMatch(/reply/);
  });

  it("emails the solo founder when their delete tears down the whole workspace", async () => {
    signedInAs("admin", "u1");
    when("user.findUnique", me());
    when("user.count", 0);
    when("company.findUnique", {
      id: "c1",
      name: WORKSPACE,
      plan: "free",
      subscriptionStatus: null,
      billingSubscriptionId: null,
    });
    when("user.findMany", [{ id: "u1", name: "Saqib", email: OWNER_EMAIL }]);
    for (const p of [
      "transaction.updateMany",
      "budget.updateMany",
      "task.updateMany",
      "project.updateMany",
      "message.updateMany",
      "comment.updateMany",
      "timeEntry.updateMany",
      "user.updateMany",
    ]) {
      when(p, { count: 0 });
    }
    when("inviteToken.deleteMany", { count: 0 });
    when("pushSubscription.deleteMany", { count: 0 });
    when("company.update", { id: "c1" });

    const res = await deleteAccountAction({ password: "pw", workspaceName: WORKSPACE });
    expect(res.success).toBe(true);

    const body = bodyOf(onlyMailTo(OWNER_EMAIL));
    expect(body).toContain(WORKSPACE.toLowerCase());
    expect(body).toMatch(/\b90\b/);
  });
});

describe("acct-005 — deleting a workspace tells the people who lost it", () => {
  function arrangeWorkspaceDelete(members: Array<{ id: string; name: string; email: string }>) {
    signedInAs("admin", "u1");
    when("user.findUnique", me());
    when("company.findUnique", {
      id: "c1",
      name: WORKSPACE,
      plan: "free",
      subscriptionStatus: null,
      billingSubscriptionId: null,
    });
    when("user.findMany", members);
    for (const p of [
      "transaction.updateMany",
      "budget.updateMany",
      "task.updateMany",
      "project.updateMany",
      "message.updateMany",
      "comment.updateMany",
      "timeEntry.updateMany",
      "user.updateMany",
    ]) {
      when(p, { count: 0 });
    }
    when("inviteToken.deleteMany", { count: 0 });
    when("pushSubscription.deleteMany", { count: 0 });
    when("company.update", { id: "c1" });
  }

  it("emails every live member, not only the admin who pressed the button", async () => {
    arrangeWorkspaceDelete([
      { id: "u1", name: "Saqib", email: OWNER_EMAIL },
      { id: "u2", name: "Ali", email: TEAMMATE_EMAIL },
    ]);

    const res = await deleteWorkspaceAction({ password: "pw", workspaceName: WORKSPACE });
    expect(res.success).toBe(true);

    expect(mailTo(OWNER_EMAIL)).toHaveLength(1);
    expect(mailTo(TEAMMATE_EMAIL)).toHaveLength(1);

    const body = bodyOf(onlyMailTo(TEAMMATE_EMAIL));
    expect(body).toContain(WORKSPACE.toLowerCase());
    expect(body).toMatch(/\b90\b/);
  });

  it("reads the recipients BEFORE the sweep tombstones them", async () => {
    arrangeWorkspaceDelete([{ id: "u1", name: "Saqib", email: OWNER_EMAIL }]);

    await deleteWorkspaceAction({ password: "pw", workspaceName: WORKSPACE });

    const order = H.calls.map((c) => c.path);
    const read = order.indexOf("user.findMany");
    const sweep = order.indexOf("user.updateMany");
    expect(read).toBeGreaterThanOrEqual(0);
    // After the sweep, `deletedAt: null` matches nobody and the notice would
    // reach an empty list — silently, which is how this finding happened.
    expect(read).toBeLessThan(sweep);
  });

  it("sends nothing when the name confirmation does not match", async () => {
    arrangeWorkspaceDelete([{ id: "u1", name: "Saqib", email: OWNER_EMAIL }]);

    const res = await deleteWorkspaceAction({ password: "pw", workspaceName: "Nimbus" });
    expect(res.success).toBe(false);
    expect(H.sent).toEqual([]);
  });
});

describe("acct-005 — security mail does not spend the notification budget", () => {
  /**
   * The decision, stated as a test so it survives the next refactor.
   *
   * `lib/email/quota.ts` exists to stop a NOTIFICATION LOOP from exhausting
   * Gmail's daily cap and taking password reset down with it; its single caller
   * is `lib/notify/email.ts` and it degrades by DROPPING recipients. Routing a
   * takeover alert through it would reintroduce exactly the silence acct-005 is
   * about, on the worst possible day. Security notices are transactional mail,
   * the class the budget's own headroom is reserved for, and their volume is
   * bounded by the destructive-action rate limiters plus the per-teardown
   * recipient cap — not by a shared counter.
   */
  it("leaves the 300/day budget untouched", async () => {
    signedInAs("admin");
    when("user.findUnique", me());
    when("user.update", me({ sessionVersion: 1 }));

    const before = remainingEmailBudget();
    await changePasswordAction(VALID_PASSWORD_CHANGE);
    expect(mailTo(OWNER_EMAIL)).toHaveLength(1);
    expect(remainingEmailBudget()).toBe(before);
  });
});

describe("acct-005 — the deadline in the email is the deadline the cron enforces", () => {
  /**
   * The retention window is stated twice: `RETENTION_DAYS` in the purge cron is
   * the authority, and SECURITY_NOTICE_RETENTION_DAYS is what the customer is
   * told. Importing the route into a server action would drag the cron handler
   * into the action bundle, so the number is mirrored — and mirrored numbers
   * drift. This is the same "assert the source" pattern as
   * tests/lib/cron/purge-invariants, and the drift it guards is the worst kind:
   * a customer waiting out a deadline that already passed.
   */
  it("matches RETENTION_DAYS in app/api/cron/purge-soft-deleted/route.ts", () => {
    const route = readFileSync(
      path.resolve(__dirname, "../../../app/api/cron/purge-soft-deleted/route.ts"),
      "utf8"
    );
    const m = /const\s+RETENTION_DAYS\s*=\s*(\d+)/.exec(route);
    expect(m, "RETENTION_DAYS is no longer declared the way this test reads it").not.toBeNull();
    expect(Number(m![1])).toBe(SECURITY_NOTICE_RETENTION_DAYS);
  });
});
