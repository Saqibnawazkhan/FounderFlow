// @vitest-environment node

/**
 * data-integrity-009 — two admins closing their own accounts at the same moment
 * left the workspace ALIVE WITH NOBODY IN IT, and nothing in the product could
 * reach that state again.
 *
 * `deleteAccountAction` counts other live users and other live admins, then
 * writes the tombstone on a separate statement. Two admins submitting together
 * each read `otherUsers = 1, otherAdmins = 1`, both pass the sole-admin guard,
 * and both tombstone themselves. The terminal state is `Company.deletedAt = null`
 * with zero live users, and every exit from it is closed:
 *
 *   • the Credentials provider refuses every tombstoned user, so nobody signs in;
 *   • `getDeactivatedUsers` and `reactivateUserAction` are admin-only, and there
 *     is no live admin to call them;
 *   • the purge cron only looks at companies whose `deletedAt` is SET, so the
 *     rows are simultaneously unreachable and unpurgeable — they sit there for
 *     ever, which is also a retention problem for a customer who asked to be
 *     erased.
 *
 * WHAT IS FIXED AND WHAT IS NOT, stated precisely, because the filing's first
 * suggestion does not work. "Do the count and the write in one `$transaction`"
 * does NOT close this race: at READ COMMITTED both transactions read the same
 * committed rows, neither sees the other's uncommitted tombstone, and both still
 * commit. Refusing the LOSER would need a row lock — `SELECT … FOR UPDATE` on the
 * Company row, via raw SQL — and that is a heavier change than the outcome
 * justifies, because the two admins both genuinely intended to leave.
 *
 * So the fix targets the TERMINAL STATE instead, which is the part that is
 * actually unrecoverable: after its own tombstone commits, the action asks
 * whether it has left the workspace with no live members, and if so tombstones
 * the workspace — the same end state the sole-user branch produces, recoverable
 * for 90 days by the documented runbook and collectable by the purge. The claim
 * is an atomic `company.updateMany({ where: { id, deletedAt: null } })`, so
 * exactly one racer wins it and the outbound subscription cancellation cannot
 * happen twice.
 *
 * THE FAKE IS STATEFUL AND CAN ARM STALE COUNTS. A fake with canned counts would
 * pass whatever the action does; the whole defect lives in the gap between a
 * count and a write, so the gap is what the fake models.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

type UserRow = {
  id: string;
  name: string;
  email: string;
  companyId: string;
  role: string;
  passwordHash: string;
  deletedAt: Date | null;
};
type CompanyRow = {
  id: string;
  name: string;
  plan: string;
  subscriptionStatus: string | null;
  billingSubscriptionId: string | null;
  currentPeriodEnd: Date | null;
  deletedAt: Date | null;
};

const H = vi.hoisted(() => ({
  users: [] as unknown[],
  company: null as unknown,
  session: { value: null as unknown },
  cancelled: [] as string[],
  notices: [] as Array<Record<string, unknown>>,
  /**
   * The stale roster a racing caller is holding — a read taken before the other
   * admin's tombstone committed.
   *
   * WHICH COUNTS IT APPLIES TO is decided by the query, not by a call counter,
   * because the two kinds of count mean different things and only one of them can
   * be stale in the real race:
   *
   *   • the two GUARD counts carry `id: { not: me }` — "is anyone ELSE here?" —
   *     and those are exactly the reads a concurrent submission takes before its
   *     own write, so those are the stale ones;
   *   • the REPAIR count excludes nobody, and it is taken AFTER the tombstone has
   *     committed, so it sees the truth. That is the whole reason the repair can
   *     work where a transaction cannot, and a fake that froze it too would model
   *     a database that never commits and would hide the fix entirely.
   */
  frozenUsers: null as unknown,
}));

function users(): UserRow[] {
  return H.users as UserRow[];
}
function company(): CompanyRow {
  return H.company as CompanyRow;
}

function countUsers(where: Record<string, unknown>): number {
  const excludesSelf = Boolean((where.id as { not?: string } | undefined)?.not);
  const roster =
    H.frozenUsers !== null && excludesSelf ? (H.frozenUsers as UserRow[]) : (H.users as UserRow[]);
  return roster.filter((u) => {
    if (where.companyId && u.companyId !== where.companyId) return false;
    const not = (where.id as { not?: string } | undefined)?.not;
    if (not && u.id === not) return false;
    if (where.role && u.role !== where.role) return false;
    if (Object.prototype.hasOwnProperty.call(where, "deletedAt")) {
      if (where.deletedAt === null && u.deletedAt !== null) return false;
    }
    return true;
  }).length;
}

const noop = { count: 0 };

vi.mock("@/lib/db", () => {
  const tombstoneMany = async () => noop;
  const db: Record<string, unknown> = {
    user: {
      findUnique: async (a: { where: { id: string } }) =>
        users().filter((u) => u.id === a.where.id)[0] ?? null,
      count: async (a: { where: Record<string, unknown> }) => countUsers(a.where),
      update: async (a: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = users().filter((u) => u.id === a.where.id)[0];
        if (row) Object.assign(row, a.data);
        return row;
      },
      updateMany: async (a: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        let n = 0;
        for (const u of users()) {
          if (a.where.companyId && u.companyId !== a.where.companyId) continue;
          if (a.where.deletedAt === null && u.deletedAt !== null) continue;
          Object.assign(u, a.data);
          n += 1;
        }
        return { count: n };
      },
    },
    company: {
      findUnique: async (a: { where: { id: string } }) =>
        company().id === a.where.id ? company() : null,
      findFirst: async () => company(),
      update: async (a: { data: Record<string, unknown> }) => {
        Object.assign(company(), a.data);
        return company();
      },
      // The mutex. Only the racer that finds `deletedAt: null` wins.
      updateMany: async (a: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (a.where.deletedAt === null && company().deletedAt !== null) return { count: 0 };
        Object.assign(company(), a.data);
        return { count: 1 };
      },
    },
    activity: { create: async () => ({ id: "act_1" }) },
    pushSubscription: { deleteMany: tombstoneMany },
    inviteToken: { deleteMany: tombstoneMany },
    notification: { deleteMany: tombstoneMany },
    notificationPreference: { deleteMany: tombstoneMany },
  };
  for (const m of ["transaction", "budget", "task", "project", "message", "comment", "timeEntry"]) {
    db[m] = { updateMany: tombstoneMany, deleteMany: tombstoneMany };
  }
  db.$transaction = async (arg: unknown) =>
    typeof arg === "function"
      ? await (arg as (tx: unknown) => Promise<unknown>)(db)
      : await Promise.all(arg as Array<Promise<unknown>>);
  return { db };
});

vi.mock("@/lib/auth", () => ({
  auth: async () => H.session.value,
  signOut: async () => undefined,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/sentry-server", () => ({ captureServerError: vi.fn() }));
vi.mock("@/lib/safety/bulk-mutation-guard", () => ({ warnBulkMutation: vi.fn() }));
vi.mock("@/lib/client-ip", () => ({ getClientIp: async () => "10.0.0.1" }));
vi.mock("@/lib/appearance/cookies", () => ({ clearAppearanceCookies: async () => undefined }));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  gateAuthAction: () => ({ allowed: true }),
  limiters: {
    auth: { consume: () => ({ allowed: true }) },
    write: { consume: () => ({ allowed: true }) },
  },
}));
vi.mock("bcryptjs", () => ({
  default: { compare: async () => true, hash: async () => "hash" },
}));
vi.mock("@/lib/lemonsqueezy/config", () => ({
  isBillingConfigured: () => true,
  LS_STORE_ID: "s",
  LS_VARIANT_ID_TEAM: "v",
  APP_URL: "https://founderflow.test",
}));
vi.mock("@lemonsqueezy/lemonsqueezy.js", () => ({
  lemonSqueezySetup: () => undefined,
  cancelSubscription: async (id: string) => {
    H.cancelled.push(id);
    return { data: { data: { id } }, error: null };
  },
}));
vi.mock("@/lib/email/templates/security-notice", () => ({
  sendSecurityNotice: async (input: Record<string, unknown>) => {
    H.notices.push(input);
  },
  sendSecurityNotices: async () => undefined,
}));

import { deleteAccountAction } from "@/lib/actions/account";

type Result = { success: boolean; error?: string };

function admin(id: string): UserRow {
  return {
    id,
    name: id,
    email: `${id}@nimbus.app`,
    companyId: "c_nimbus",
    role: "admin",
    passwordHash: "hash",
    deletedAt: null,
  };
}

function signedInAs(id: string): void {
  H.session.value = {
    user: { id, companyId: "c_nimbus", role: "admin", email: `${id}@nimbus.app` },
  };
}

async function closeAccount(id: string): Promise<Result> {
  signedInAs(id);
  return (await deleteAccountAction({ password: "Correct-Horse1" })) as Result;
}

/**
 * Arm the race: from here on, every sole-admin GUARD count reads the roster as it
 * is right now, while the repair's post-write count reads the truth. Called once,
 * before the concurrent submissions.
 */
function raceTheGuard(): void {
  H.frozenUsers = users().map((u) => ({ ...u }));
}

beforeEach(() => {
  H.users.length = 0;
  H.users.push(admin("u_ayesha"), admin("u_bilal"));
  H.company = {
    id: "c_nimbus",
    name: "Nimbus",
    plan: "team",
    subscriptionStatus: "active",
    billingSubscriptionId: "sub_9001",
    currentPeriodEnd: new Date("2026-11-01T00:00:00Z"),
    deletedAt: null,
  };
  H.session.value = null;
  H.cancelled.length = 0;
  H.notices.length = 0;
  H.frozenUsers = null;
});

describe("data-integrity-009 — two admins leaving together cannot orphan the workspace", () => {
  it("tombstones the workspace rather than leaving it live with nobody in it", async () => {
    // Both callers hold a roster read taken before either tombstone committed,
    // which is exactly what two concurrent submissions see at READ COMMITTED.
    raceTheGuard();
    const a = await closeAccount("u_ayesha");
    const b = await closeAccount("u_bilal");
    expect(a.success).toBe(true);
    expect(b.success).toBe(true);

    expect(users().filter((u) => u.deletedAt === null)).toEqual([]);
    // THE FINDING. Before the fix this was null: a live workspace nobody can
    // enter, nobody can restore, and the purge cron will never look at.
    expect(company().deletedAt).not.toBeNull();
  });

  it("stops the subscription so an unreachable workspace is not still being billed", async () => {
    raceTheGuard();
    await closeAccount("u_ayesha");
    await closeAccount("u_bilal");
    expect(H.cancelled).toEqual(["sub_9001"]);
  });

  it("cancels exactly once, however many racers notice — the claim is the mutex", async () => {
    // `company.updateMany({ where: { id, deletedAt: null } })` can succeed for
    // only one caller, so the outbound provider call cannot be made twice. A
    // second cancel is an error LemonSqueezy would report and we would then have
    // to ignore, which is how a real failure gets swallowed.
    raceTheGuard();
    await closeAccount("u_ayesha");
    await closeAccount("u_bilal");
    // A third member finishing later notices the empty workspace too, and must
    // not repeat the outbound cancellation.
    users().push({ ...admin("u_late"), deletedAt: null });
    raceTheGuard();
    await closeAccount("u_late");
    expect(H.cancelled).toEqual(["sub_9001"]);
  });

  it("tells the last person it was a WORKSPACE deletion, with the recovery deadline", async () => {
    raceTheGuard();
    await closeAccount("u_ayesha");
    await closeAccount("u_bilal");
    const kinds = H.notices.map((n) => n.kind);
    // Both people get their account receipt; the one who left it empty also gets
    // the workspace receipt, which is the one carrying the 90-day restore route.
    expect(kinds).toContain("account-deleted");
    expect(kinds).toContain("workspace-deleted");
  });
});

describe("data-integrity-009 — the ordinary paths are unchanged", () => {
  it("still refuses a sole admin who has live teammates", async () => {
    H.users.length = 0;
    H.users.push(admin("u_ayesha"), { ...admin("u_member"), role: "member" });
    const res = await closeAccount("u_ayesha");
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/only admin/i);
    expect(company().deletedAt).toBeNull();
    expect(users().filter((u) => u.deletedAt === null).length).toBe(2);
  });

  it("leaves a healthy workspace alone when one of three admins leaves", async () => {
    H.users.push(admin("u_chandni"));
    const res = await closeAccount("u_ayesha");
    expect(res.success).toBe(true);
    expect(company().deletedAt).toBeNull();
    expect(H.cancelled).toEqual([]);
    expect(H.notices.map((n) => n.kind)).toEqual(["account-deleted"]);
  });

  it("does not fire the repair when the second admin is refused sequentially", async () => {
    // No frozen counts: the second caller sees the truth and is turned away, so
    // the repair must never run. If it did, one admin leaving a two-admin
    // workspace would delete the workspace.
    const a = await closeAccount("u_ayesha");
    expect(a.success).toBe(true);
    const b = await closeAccount("u_bilal");
    expect(b.success).toBe(false);
    expect(company().deletedAt).toBeNull();
    expect(
      users()
        .filter((u) => u.deletedAt === null)
        .map((u) => u.id)
    ).toEqual(["u_bilal"]);
  });
});
