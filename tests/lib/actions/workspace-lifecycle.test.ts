/**
 * Workspace lifecycle — what a delete must take with it, and what a delete must
 * never take by surprise.
 *
 * Four findings, one file, because they are four halves of the same sentence:
 * "this workspace is gone".
 *
 *   • acct-003 / data-integrity-003 — an INVITE outlives the workspace it was
 *     sent for. `acceptInviteAction` now refuses a token whose company carries a
 *     tombstone (lib/actions/team.ts), but the token itself is a live secret in
 *     the database until its own 7-day expiry. `removeUserAction` already burns a
 *     removed teammate's pending invites for exactly this reason; the workspace
 *     sweep never did.
 *   • acct-002 — deleting a PAID workspace left the LemonSqueezy subscription
 *     running. Every user is tombstoned by the same sweep, so "Manage billing"
 *     is unreachable afterwards (createBillingPortalSessionAction needs a live
 *     session AND `company.deletedAt: null`): the customer keeps being charged,
 *     monthly, with no in-app way to stop it.
 *   • acct-008 — the departing user's DEVICES kept their push registration, so a
 *     notification carrying a transaction amount could still arrive on a phone
 *     belonging to someone who deleted their account.
 *   • acct-013 — for a solo founder "Delete my account" runs the identical
 *     whole-workspace cascade that "Delete this workspace" runs, but behind one
 *     password box and copy whose strongest word is "account".
 *
 * WHY THE ASSERTIONS NAME THE FORBIDDEN CALL TOO. The cheap version of every
 * test below is `expect(res.success).toBe(true)`, and that was already true of
 * the buggy code — the delete succeeded, it just left things behind. So each
 * test asserts on the recorded Prisma operation and its `where`, and the
 * subscription tests assert the action REFUSES when the provider call fails,
 * because "deleted the workspace and orphaned a live subscription" is the
 * failure that costs money.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

/* ─────────────────────────────────────────────────────────────────────────── */
/* Fake Prisma client — records every call, in order                            */
/* ─────────────────────────────────────────────────────────────────────────── */

const H = vi.hoisted(() => {
  const calls: Array<{ path: string; args: Record<string, unknown> }> = [];
  const results = new Map<string, unknown>();

  const MODELS = [
    "transaction",
    "budget",
    "task",
    "project",
    "message",
    "user",
    "company",
    "activity",
    "inviteToken",
    "pushSubscription",
    "notification",
    "notificationPreference",
  ];
  const OPS = [
    "findUnique",
    "findFirst",
    "findMany",
    "count",
    "create",
    "createMany",
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
  // Both forms: softDeleteWorkspace passes an array, every team action a callback.
  db.$transaction = async (arg: unknown) =>
    typeof arg === "function"
      ? await (arg as (tx: unknown) => Promise<unknown>)(db)
      : await Promise.all(arg as Array<Promise<unknown>>);

  return {
    db,
    calls,
    results,
    session: { value: null as unknown },
    // Provider state for the LemonSqueezy cancel call.
    ls: {
      configured: true,
      cancelled: [] as Array<string | number>,
      error: null as unknown,
    },
  };
});

vi.mock("@/lib/db", () => ({ db: H.db }));
vi.mock("@/lib/auth", () => ({
  auth: async () => H.session.value,
  signOut: async () => undefined,
  signIn: async () => undefined,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// `lib/actions/team.ts` imports AuthError to tell "auto-sign-in bounced" apart
// from a real fault. The real module reaches for next/server at import time,
// which does not resolve under vitest.
vi.mock("next-auth", () => ({
  AuthError: class AuthError extends Error {},
}));
vi.mock("@/lib/sentry-server", () => ({ captureServerError: vi.fn() }));
vi.mock("@/lib/safety/bulk-mutation-guard", () => ({ warnBulkMutation: vi.fn() }));
vi.mock("@/lib/client-ip", () => ({ getClientIp: async () => "10.0.0.1" }));
// The IP auth bucket is 5/min and these tests call the delete paths more than
// five times. Its own behaviour is covered by tests/lib/rate-limit.test.ts.
vi.mock("@/lib/rate-limit", () => ({
  limiters: {
    auth: { consume: () => ({ allowed: true }) },
    write: { consume: () => ({ allowed: true }) },
  },
}));
vi.mock("bcryptjs", () => ({
  default: { compare: async () => true, hash: async () => "hash" },
}));
vi.mock("@/lib/lemonsqueezy/config", () => ({
  isBillingConfigured: () => H.ls.configured,
  LS_STORE_ID: "store_1",
  LS_VARIANT_ID_TEAM: "variant_1",
  APP_URL: "https://founderflow.test",
}));
vi.mock("@lemonsqueezy/lemonsqueezy.js", () => ({
  lemonSqueezySetup: () => undefined,
  cancelSubscription: async (id: string | number) => {
    H.ls.cancelled.push(id);
    if (H.ls.error) return { data: null, error: H.ls.error };
    return { data: { data: { id } }, error: null };
  },
}));
// Invite acceptance writes chat membership + a welcome notification; both have
// their own tests and would only add noise here.
vi.mock("@/lib/chat/bootstrap", () => ({ joinDefaultChannels: async () => 1 }));
vi.mock("@/lib/notify/fan-out", () => ({ notifyUsers: async () => ({ notified: 1 }) }));
vi.mock("@/lib/email/send", () => ({ sendEmail: async () => ({ delivered: true }) }));

import { deleteAccountAction, deleteWorkspaceAction } from "@/lib/actions/account";
import { acceptInviteAction, removeUserAction } from "@/lib/actions/team";

/* ─────────────────────────────────────────────────────────────────────────── */
/* Helpers                                                                     */
/* ─────────────────────────────────────────────────────────────────────────── */

function when(path: string, value: unknown): void {
  H.results.set(path, value);
}

function callsTo(path: string): Array<Record<string, unknown>> {
  return H.calls.filter((c) => c.path === path).map((c) => c.args);
}

function whereOf(args: Record<string, unknown> | undefined): Record<string, unknown> {
  return (args?.where ?? {}) as Record<string, unknown>;
}

function dataOf(args: Record<string, unknown> | undefined): Record<string, unknown> {
  return (args?.data ?? {}) as Record<string, unknown>;
}

function signedInAs(role: string, id = "u1"): void {
  H.session.value = { user: { id, companyId: "c1", role, email: "founder@nimbus.app" } };
}

/** The caller's own row, as both delete actions read it. */
function me(over: Record<string, unknown> = {}) {
  return {
    id: "u1",
    name: "Saqib",
    email: "founder@nimbus.app",
    role: "admin",
    companyId: "c1",
    passwordHash: "hash",
    deletedAt: null,
    ...over,
  };
}

/** A workspace on the paid plan with a live LemonSqueezy subscription. */
function paidCompany(over: Record<string, unknown> = {}) {
  return {
    id: "c1",
    name: "Nimbus",
    plan: "team",
    subscriptionStatus: "active",
    currentPeriodEnd: new Date("2026-11-03T00:00:00.000Z"),
    billingCustomerId: "cust_1",
    billingSubscriptionId: "sub_1",
    ownerId: "u1",
    deletedAt: null,
    ...over,
  };
}

/** Everything the workspace sweep needs to run to completion. */
function sweepReturns(): void {
  for (const model of ["transaction", "budget", "task", "project", "message", "user"]) {
    when(`${model}.updateMany`, { count: 1 });
  }
  when("inviteToken.deleteMany", { count: 1 });
  when("pushSubscription.deleteMany", { count: 1 });
  when("company.update", { id: "c1" });
}

beforeEach(() => {
  H.calls.length = 0;
  H.results.clear();
  H.session.value = null;
  H.ls.configured = true;
  H.ls.cancelled.length = 0;
  H.ls.error = null;
});

/* ─────────────────────────────────────────────────────────────────────────── */
/* acct-003 / data-integrity-003 — the invites die with the workspace           */
/* ─────────────────────────────────────────────────────────────────────────── */

describe("deleting a workspace invalidates its outstanding invites (acct-003)", () => {
  it("burns every unused InviteToken for the company", async () => {
    signedInAs("admin");
    when("user.findUnique", me());
    when("company.findUnique", paidCompany({ billingSubscriptionId: null, plan: "free" }));
    sweepReturns();

    const res = await deleteWorkspaceAction({ password: "pw", workspaceName: "Nimbus" });
    expect(res.success).toBe(true);

    const burnt = callsTo("inviteToken.deleteMany");
    expect(
      burnt.length,
      "softDeleteWorkspace must delete the workspace's unused invite tokens. A token " +
        "is a live secret, not history: while one survives, a stranger can still join " +
        "a tombstoned company and the 90-day purge will erase the account they just made."
    ).toBe(1);
    expect(whereOf(burnt[0]).companyId).toBe("c1");
    expect(
      whereOf(burnt[0]).usedAt,
      "scoped to UNUSED tokens — a used one is the audit record of a real acceptance"
    ).toBe(null);
  });

  it("burns them on the solo-founder account-delete path too (same cascade)", async () => {
    signedInAs("admin");
    when("user.findUnique", me());
    when("user.count", 0);
    when("company.findUnique", paidCompany({ billingSubscriptionId: null, plan: "free" }));
    sweepReturns();

    const res = await deleteAccountAction({ password: "pw", workspaceName: "Nimbus" });
    expect(res.success).toBe(true);
    expect(callsTo("inviteToken.deleteMany")).toHaveLength(1);
  });
});

/* ─────────────────────────────────────────────────────────────────────────── */
/* acct-002 — the subscription dies with the workspace                          */
/* ─────────────────────────────────────────────────────────────────────────── */

describe("deleting a paid workspace stops the money (acct-002)", () => {
  it("cancels the LemonSqueezy subscription and records the downgrade", async () => {
    signedInAs("admin");
    when("user.findUnique", me());
    when("company.findUnique", paidCompany());
    sweepReturns();

    const res = await deleteWorkspaceAction({ password: "pw", workspaceName: "Nimbus" });
    expect(res.success).toBe(true);

    expect(
      H.ls.cancelled,
      "the workspace is gone and every user with it, so nobody can reach Manage " +
        "billing afterwards. If the delete does not cancel the subscription, the " +
        "card keeps being charged for a workspace the product said was deleted."
    ).toEqual(["sub_1"]);

    const tombstone = callsTo("company.update")[0];
    expect(dataOf(tombstone).deletedAt).toBeInstanceOf(Date);
    expect(
      dataOf(tombstone).plan,
      "the stored plan must reflect the cancellation, in the same transaction"
    ).toBe("free");
    expect(dataOf(tombstone).subscriptionStatus).toBe("cancelled");
  });

  it("refuses the delete when the provider rejects the cancellation", async () => {
    signedInAs("admin");
    when("user.findUnique", me());
    when("company.findUnique", paidCompany());
    sweepReturns();
    H.ls.error = { message: "subscription not found" };

    const res = await deleteWorkspaceAction({ password: "pw", workspaceName: "Nimbus" });
    expect(
      res.success,
      "better to refuse the delete than to tombstone the workspace and leave a live " +
        "subscription nobody can reach"
    ).toBe(false);
    expect(
      callsTo("company.update"),
      "nothing may be tombstoned when the subscription could not be cancelled"
    ).toHaveLength(0);
  });

  it("does not call the provider for a workspace that never subscribed", async () => {
    signedInAs("admin");
    when("user.findUnique", me());
    when(
      "company.findUnique",
      paidCompany({ plan: "free", billingSubscriptionId: null, subscriptionStatus: null })
    );
    sweepReturns();

    const res = await deleteWorkspaceAction({ password: "pw", workspaceName: "Nimbus" });
    expect(res.success).toBe(true);
    expect(H.ls.cancelled).toEqual([]);
  });

  it("cancels on the solo-founder account-delete path too", async () => {
    signedInAs("admin");
    when("user.findUnique", me());
    when("user.count", 0);
    when("company.findUnique", paidCompany());
    sweepReturns();

    const res = await deleteAccountAction({ password: "pw", workspaceName: "Nimbus" });
    expect(res.success).toBe(true);
    expect(
      H.ls.cancelled,
      "the sole-user branch runs the identical cascade, so it owes the identical " +
        "cancellation — this is the shape the target user (a solo founder) actually hits"
    ).toEqual(["sub_1"]);
  });
});

/* ─────────────────────────────────────────────────────────────────────────── */
/* acct-008 / data-integrity-004 — the devices are de-registered                */
/* ─────────────────────────────────────────────────────────────────────────── */

describe("a deleted account stops reaching the person's devices (acct-008)", () => {
  it("deletes the leaving user's push subscriptions", async () => {
    signedInAs("cofounder");
    when("user.findUnique", me({ role: "cofounder" }));
    when("user.count", 2);

    const res = await deleteAccountAction({ password: "pw" });
    expect(res.success).toBe(true);

    const pruned = callsTo("pushSubscription.deleteMany");
    expect(
      pruned.length,
      "a push payload carries the notification title and body verbatim, outside the " +
        "app where no session check applies. Deleting the account must de-register " +
        "the devices, or the person keeps receiving the workspace's figures."
    ).toBe(1);
    expect(whereOf(pruned[0]).userId).toBe("u1");
  });

  it("deletes every device in the workspace when the workspace goes", async () => {
    signedInAs("admin");
    when("user.findUnique", me());
    when("company.findUnique", paidCompany({ billingSubscriptionId: null, plan: "free" }));
    sweepReturns();

    await deleteWorkspaceAction({ password: "pw", workspaceName: "Nimbus" });

    const pruned = callsTo("pushSubscription.deleteMany");
    expect(pruned.length).toBe(1);
    expect(
      whereOf(pruned[0]).user,
      "scoped through the relation, so it covers every teammate's devices"
    ).toEqual({ companyId: "c1" });
  });

  it("deletes a deactivated teammate's devices when an admin removes them", async () => {
    signedInAs("admin");
    when("user.findUnique", (args: Record<string, unknown>) =>
      whereOf(args).id === "u2" ? me({ id: "u2", role: "member", email: "ali@nimbus.app" }) : me()
    );
    when("user.count", 2);
    when("company.findUnique", paidCompany());

    const res = await removeUserAction("u2");
    expect(res.success).toBe(true);

    const pruned = callsTo("pushSubscription.deleteMany");
    expect(
      pruned.length,
      "removeUserAction writes only User.deletedAt, PushSubscription has no tombstone " +
        "of its own, and the purge cron deliberately has no individual-user stage — so " +
        "without this the device rows live forever"
    ).toBe(1);
    expect(whereOf(pruned[0]).userId).toBe("u2");
  });
});

/* ─────────────────────────────────────────────────────────────────────────── */
/* acct-013 — the solo founder's account delete IS a workspace delete           */
/* ─────────────────────────────────────────────────────────────────────────── */

describe("the sole-user account delete asks for the same proof as a workspace delete (acct-013)", () => {
  it("refuses to run the whole-workspace cascade on a password alone", async () => {
    signedInAs("admin");
    when("user.findUnique", me());
    when("user.count", 0);
    when("company.findUnique", paidCompany({ billingSubscriptionId: null, plan: "free" }));
    sweepReturns();

    const res = await deleteAccountAction({ password: "pw" });
    expect(
      res.success,
      "when the caller is the only member, this action tombstones the entire workspace " +
        "— every transaction, task and budget. The identical destruction offered one row " +
        "below makes you type the workspace name; this path must not be the soft way in."
    ).toBe(false);
    expect(String(res.success === false ? res.error : "")).toContain("Nimbus");
    expect(
      callsTo("company.update"),
      "nothing may be tombstoned without the workspace-name confirmation"
    ).toHaveLength(0);
  });

  it("refuses a workspace name that does not match", async () => {
    signedInAs("admin");
    when("user.findUnique", me());
    when("user.count", 0);
    when("company.findUnique", paidCompany({ billingSubscriptionId: null, plan: "free" }));
    sweepReturns();

    const res = await deleteAccountAction({ password: "pw", workspaceName: "nimbus" });
    expect(res.success).toBe(false);
    expect(callsTo("company.update")).toHaveLength(0);
  });

  it("still deletes a lone user from a workspace with teammates on a password alone", async () => {
    // The multi-user branch really does only remove the caller, so one password
    // is the right amount of friction there.
    signedInAs("cofounder");
    when("user.findUnique", me({ role: "cofounder" }));
    when("user.count", 2);

    const res = await deleteAccountAction({ password: "pw" });
    expect(res.success).toBe(true);
    expect(callsTo("company.update")).toHaveLength(0);
  });
});

/* ─────────────────────────────────────────────────────────────────────────── */
/* bill-013 — a downgrade takes the surplus seats away                          */
/* ─────────────────────────────────────────────────────────────────────────── */

describe("the free member cap is enforced on the way IN, not only at invite time (bill-013)", () => {
  function pendingInvite(over: Record<string, unknown> = {}) {
    return {
      id: "inv1",
      token: "t".repeat(64),
      email: "ali@nimbus.app",
      name: "Ali",
      role: "member",
      companyId: "c1",
      invitedBy: "u1",
      expiresAt: new Date(Date.now() + 86_400_000),
      usedAt: null,
      company: {
        deletedAt: null,
        plan: "free",
        subscriptionStatus: null,
        currentPeriodEnd: null,
      },
      ...over,
    };
  }

  it("refuses a token issued while paid once the workspace is back on free and full", async () => {
    when("inviteToken.findUnique", pendingInvite());
    when("user.findUnique", null);
    // Two active members already: the free plan's whole limit.
    when("user.count", 2);
    when("user.findMany", []);

    const res = await acceptInviteAction({ token: "t".repeat(64), password: "Str0ngPass!" });
    expect(
      res.success,
      "one paid month must not buy permanent seats: a token minted on Team still " +
        "created a member after the plan lapsed, because acceptInviteAction never " +
        "asked what the plan allows"
    ).toBe(false);
    expect(callsTo("user.create"), "no member row may be written over the cap").toHaveLength(0);
  });

  it("still accepts an invite that keeps the workspace inside the cap", async () => {
    when("inviteToken.findUnique", pendingInvite());
    when("user.findUnique", null);
    when("user.count", 1);
    when("user.findMany", []);
    when("user.create", { id: "u9", name: "Ali" });
    when("inviteToken.update", { id: "inv1" });
    when("activity.create", { id: "a1" });

    const res = await acceptInviteAction({ token: "t".repeat(64), password: "Str0ngPass!" });
    expect(res.success).toBe(true);
    expect(callsTo("user.create")).toHaveLength(1);
  });

  it("lets a paying workspace past the free limit", async () => {
    when(
      "inviteToken.findUnique",
      pendingInvite({
        company: {
          deletedAt: null,
          plan: "team",
          subscriptionStatus: "active",
          currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
        },
      })
    );
    when("user.findUnique", null);
    when("user.count", 12);
    when("user.findMany", []);
    when("user.create", { id: "u9", name: "Ali" });
    when("inviteToken.update", { id: "inv1" });
    when("activity.create", { id: "a1" });

    const res = await acceptInviteAction({ token: "t".repeat(64), password: "Str0ngPass!" });
    expect(res.success).toBe(true);
  });
});
