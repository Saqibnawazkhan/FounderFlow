// @vitest-environment node
/**
 * bill-014 — THE FREE-PLAN SEAT CAP, AND THE THREE PATHS THAT TAKE A SEAT.
 *
 * The finding as filed: `inviteUserAction` counted members + pending invites,
 * then created the invite token in a SEPARATE `$transaction`, so two requests
 * interleaving between the count and the create both saw room.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT ASSERT, and why that matters more than
 * what it does. It does NOT claim that two simultaneous invites can no longer
 * both get through. Nothing in the fix gives that guarantee and a test that
 * asserted it would be this repo's signature defect in its purest form: a fake
 * whose `$transaction` serialises its callers would manufacture a promise the
 * database does not make. Prisma runs at the connector default, which on
 * Postgres is READ COMMITTED — every statement takes its own snapshot and
 * neither transaction can see the other's uncommitted row — so moving a count
 * inside a transaction buys atomicity, not mutual exclusion. Closing the race
 * itself needs an arbiter the database owns (a `Company.seatsUsed` counter
 * incremented by a conditional `UPDATE … WHERE seatsUsed < limit`, which is a
 * schema change), or SERIALIZABLE plus a retry path. Both were weighed and
 * declined; the reasoning is in lib/actions/team.ts next to each gate, with the
 * bound on what the residual race costs.
 *
 * WHAT IS TESTABLE, AND IS TESTED HERE, is the part of the finding that is a
 * plain ordering bug rather than a concurrency guarantee:
 *
 *   1. THE SEAT DECISION IS MADE WHERE THE WRITE HAPPENS. Before the fix
 *      `inviteUserAction` decided outside its transaction and then never looked
 *      again, so a seat taken and COMMITTED by anyone else — another invite, an
 *      acceptance, a reactivation — while this request was in flight was simply
 *      not seen. That is not a race needing microsecond timing; any commit
 *      inside the window slipped past. `world.commitAnotherSeat()` below is that
 *      commit, fired at the moment the transaction opens.
 *
 *   2. `reactivateUserAction` HAD NO SEAT CHECK AT ALL. Deterministic, no
 *      timing, no race: deactivate a teammate, invite their replacement, then
 *      press Reactivate — a Free workspace lands on three active members and
 *      nothing anywhere refuses it. Found while verifying bill-014; it is the
 *      same cap, the same file, and strictly the larger hole, so it is closed
 *      here and pinned below.
 *
 * The fake models READ COMMITTED on purpose: `user.count` and
 * `inviteToken.count` read only COMMITTED state plus the calling transaction's
 * own writes, and a token created inside a transaction lands in `world` only
 * when that transaction commits. So a test here cannot accidentally prove
 * serialisation — if a future fix really does serialise, it must come with a
 * fake that earns it.
 *
 * node environment: team.ts pulls in bcrypt and next-auth shapes that have no
 * business in a DOM, and nothing here renders.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/* ── the fake workspace ─────────────────────────────────────────────────── */

const H = vi.hoisted(() => {
  const ADMIN = {
    id: "u_ayesha",
    name: "Ayesha Raza",
    companyId: "c_nimbus",
    role: "admin",
  };

  const world = {
    plan: "free" as string,
    subscriptionStatus: null as string | null,
    currentPeriodEnd: null as Date | null,
    /** COMMITTED active members of c_nimbus. */
    members: 1,
    /** COMMITTED unused invite tokens, by address. */
    pending: [] as string[],
    /** The deactivated teammate `reactivateUserAction` is asked about. */
    target: {
      id: "u_bilal",
      name: "Bilal Ahmed",
      companyId: "c_nimbus",
      role: "member",
      deletedAt: new Date("2026-09-01T00:00:00Z") as Date | null,
    },
  };

  /** Every db call, in order, tagged with whether it ran inside a transaction. */
  const calls: Array<{ path: string; insideTx: boolean }> = [];

  /**
   * Fires the instant a `$transaction` opens. It stands for the one thing the
   * unfixed code could not see: another request COMMITTING a seat after this
   * one had done its reads. Nothing about it is timing-sensitive.
   */
  const hooks = { onTransactionOpen: null as null | (() => void) };

  let insideTx = false;
  /** Tokens the open transaction has written but not committed. */
  let txTokens: string[] = [];
  /**
   * Addresses whose tokens the open transaction has DELETED but not committed.
   *
   * Symmetrical with `txTokens`, and added for the same reason it exists: a
   * transaction sees its own writes and nobody else's, and a rollback undoes
   * them. Without this, `deleteMany` mutated the committed world immediately and
   * a refusal could not put the row back — so A44 (a refused invite must not
   * destroy the invitee's existing token) was a change no test in this file
   * could observe, which is how an invisible fix gets shipped.
   */
  let txDeleted = new Set<string>();

  function note(path: string): void {
    calls.push({ path, insideTx });
  }

  /**
   * Only the argument shapes these fakes actually read. The action calls them
   * with more than this (`select`, `include`, richer `where`s) and that is fine:
   * the call sites go through the mocked module, so nothing type-checks them
   * against these signatures — they exist to keep the fake itself honest.
   */
  type FindArgs = { where?: { email?: string; id?: string } };
  type DeleteManyArgs = { where?: { email?: string } };
  type CreateArgs = { data: { email: string } };

  const db: Record<string, unknown> = {
    user: {
      findUnique: async (args: FindArgs) => {
        note("user.findUnique");
        const where = args?.where ?? {};
        // The address-holder lookup. Nobody holds it in any case below — the
        // collision branches are tests/lib/actions/accept-invite-throttle.ts's.
        if (where.email !== undefined) return null;
        if (where.id === ADMIN.id) return { ...ADMIN };
        if (where.id === world.target.id) return { ...world.target };
        return null;
      },
      count: async () => {
        note("user.count");
        return world.members;
      },
      update: async () => {
        note("user.update");
        return {};
      },
    },
    inviteToken: {
      count: async () => {
        note("inviteToken.count");
        // Committed rows, MINUS what this transaction has deleted, PLUS what it
        // has written — which is exactly what Postgres shows a transaction at
        // READ COMMITTED. The subtraction is what makes a resend at the cap
        // behave: the address's own outstanding invite must not count itself out
        // of the seat it is replacing.
        return world.pending.filter((e) => !txDeleted.has(e)).length + txTokens.length;
      },
      deleteMany: async (args: DeleteManyArgs) => {
        note("inviteToken.deleteMany");
        const email = args?.where?.email;
        if (email === undefined) return { count: 0 };
        if (insideTx) {
          // Deferred to COMMIT, so a throw after this point leaves the row
          // exactly where it was. The returned count is still what the caller
          // would see inside its own transaction.
          const hit = world.pending.filter((e) => e === email && !txDeleted.has(e)).length;
          txDeleted.add(email);
          return { count: hit };
        }
        const before = world.pending.length;
        world.pending = world.pending.filter((e) => e !== email);
        return { count: before - world.pending.length };
      },
      create: async (args: CreateArgs) => {
        note("inviteToken.create");
        txTokens.push(args.data.email);
        return {};
      },
    },
    company: {
      findUnique: async () => {
        note("company.findUnique");
        return {
          id: "c_nimbus",
          name: "Nimbus Labs",
          plan: world.plan,
          subscriptionStatus: world.subscriptionStatus,
          currentPeriodEnd: world.currentPeriodEnd,
        };
      },
    },
    activity: {
      create: async () => {
        note("activity.create");
        return {};
      },
    },
    $transaction: async (arg: unknown) => {
      note("$transaction");
      hooks.onTransactionOpen?.();
      insideTx = true;
      txTokens = [];
      txDeleted = new Set();
      try {
        const out =
          typeof arg === "function"
            ? await (arg as (tx: unknown) => Promise<unknown>)(db)
            : await Promise.all(arg as Array<Promise<unknown>>);
        // COMMIT. Reached only if the callback returned, so a throw inside it
        // rolls the writes back the way a real transaction would — deletes
        // included, which is the property A44 turns on. Deletes are applied
        // before inserts so that replacing an address's invite in one
        // transaction leaves exactly one row, not zero.
        world.pending = world.pending.filter((e) => !txDeleted.has(e));
        world.pending.push(...txTokens);
        return out;
      } finally {
        txTokens = [];
        txDeleted = new Set();
        insideTx = false;
      }
    },
  };

  const captureServerError = vi.fn();

  return { ADMIN, world, calls, hooks, db, captureServerError };
});

/* ── module doubles ─────────────────────────────────────────────────────── */

vi.mock("@/lib/db", () => ({ db: H.db }));
vi.mock("@/lib/auth", () => ({
  auth: () => Promise.resolve({ user: { ...H.ADMIN } }),
  signIn: () => Promise.resolve(undefined),
}));
// Mocked, unlike accept-invite-throttle.test.ts which asserts ON the buckets:
// nothing here is about metering, and a real bucket would run out of budget
// halfway through the file and report it as a seat refusal.
vi.mock("@/lib/rate-limit", () => ({
  limiters: {
    write: { consume: () => ({ allowed: true }) },
    read: { consume: () => ({ allowed: true }) },
  },
  gateAuthAction: () => ({ allowed: true }),
}));
vi.mock("@/lib/client-ip", () => ({ getClientIp: () => Promise.resolve("203.0.113.7") }));
vi.mock("@/lib/sentry-server", () => ({ captureServerError: H.captureServerError }));
vi.mock("@/lib/email/send", () => ({
  sendEmail: () => Promise.resolve({ delivered: true, devLogged: false }),
}));
vi.mock("@/lib/notify/fan-out", () => ({ notifyUsers: () => Promise.resolve(undefined) }));
vi.mock("@/lib/chat/bootstrap", () => ({ joinDefaultChannels: () => Promise.resolve(0) }));
vi.mock("@/lib/appearance/cookies", () => ({
  DEFAULT_APPEARANCE: { theme: "dark", locale: "en" },
  writeAppearanceCookies: () => Promise.resolve(undefined),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next-auth", () => ({ AuthError: class AuthError extends Error {} }));
vi.mock("bcryptjs", () => ({
  default: { hash: () => Promise.resolve("bcrypt$new"), compare: () => Promise.resolve(false) },
}));

import { inviteUserAction, reactivateUserAction } from "@/lib/actions/team";

/* ── helpers ────────────────────────────────────────────────────────────── */

const NEW_HIRE = { name: "Zara Khan", email: "zara@nimbus.app", role: "member" as const };

function pathsOf(): string[] {
  return H.calls.map((c) => c.path);
}

function countsInsideTransaction(): number {
  return H.calls.filter((c) => c.insideTx && /\.count$/.test(c.path)).length;
}

function createdTokens(): number {
  return H.calls.filter((c) => c.path === "inviteToken.create").length;
}

beforeEach(() => {
  H.calls.length = 0;
  H.captureServerError.mockClear();
  H.hooks.onTransactionOpen = null;
  H.world.plan = "free";
  H.world.subscriptionStatus = null;
  H.world.currentPeriodEnd = null;
  H.world.members = 1;
  H.world.pending = [];
  H.world.target.deletedAt = new Date("2026-09-01T00:00:00Z");
});

/* ── 1. the invite gate decides where it writes ─────────────────────────── */

describe("inviteUserAction — a refusal must not destroy an invite it did not send (A44)", () => {
  /**
   * The address already holds a live invite, and the workspace is now full.
   *
   * THE SHAPE OF THE BUG. `inviteUserAction` invalidated the address's pending
   * token BEFORE opening the transaction that decides on the seat, so the delete
   * was already committed when the refusal threw. The invitee's valid token was
   * destroyed and the admin was told the invite had not been sent — the one
   * combination nobody can recover from, because neither party knows anything
   * changed.
   *
   * HOW A REAL WORKSPACE REACHES IT, which is why this is a fix and not a note:
   * a lapsed `plan="team"` workspace used to get `memberLimitForPlan` ->
   * Infinity and always succeed here. bill-014 correctly switched this gate to
   * `memberLimitForCompany`, which answers 2 — so re-inviting an address that
   * still holds an invite issued under Team (never burnt, because the
   * `subscription_expired` delivery is exactly what bill-004 says can be lost)
   * started landing on the refusal.
   */
  it("leaves the address's existing invite in place when the seat check refuses", async () => {
    H.world.members = 2; // the Free cap, already full
    H.world.pending = [NEW_HIRE.email]; // …and this address already has one

    const res = (await inviteUserAction(NEW_HIRE)) as { success: boolean; error?: string };

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/limited to 2 members/);
    expect(
      H.world.pending,
      "The refusal rolled back, but the invitee's existing token was already gone: the " +
        "deleteMany ran before the transaction opened, so nothing could put it back. Their " +
        "live invite link is dead and the admin was told the invite was not sent."
    ).toContain(NEW_HIRE.email);
  });

  it("still replaces that invite with exactly one row when the seat check passes", async () => {
    // The other half of the same change, so the fix cannot be "never delete".
    // One member on a cap of two, and the address holds an outstanding invite:
    // the resend must succeed, and must not leave two tokens for one address.
    H.world.members = 1;
    H.world.pending = [NEW_HIRE.email];

    const res = (await inviteUserAction(NEW_HIRE)) as { success: boolean };

    expect(res.success).toBe(true);
    expect(H.world.pending.filter((e) => e === NEW_HIRE.email)).toHaveLength(1);
  });
});

describe("inviteUserAction — the seat decision and the write are one step", () => {
  it("refuses the invite when the last free seat is taken while the request is in flight", async () => {
    // One admin, no pending invites: on the Free plan's cap of 2 there is
    // exactly one seat left, so the invite is allowed when it is decided.
    H.world.members = 1;

    // …and then somebody else's request commits that seat. In production this
    // is the other half of bill-014 — a second invite, an acceptance, or a
    // reactivation landing while this admin's request was mid-flight. Fired at
    // transaction open, so it is AFTER the unfixed code's only seat read and
    // BEFORE any write, in both versions of the code.
    H.hooks.onTransactionOpen = () => {
      H.world.members = 2;
    };

    const res = (await inviteUserAction(NEW_HIRE)) as { success: boolean; error?: string };

    expect(
      res.success,
      "The workspace was full by the time this invite was written, and the admin was told " +
        "it succeeded. The seat decision has to be taken where the row is created, not four " +
        "round trips earlier — otherwise any commit inside that window is invisible."
    ).toBe(false);
    expect(res.error).toMatch(/limited to 2 members/);
    expect(
      createdTokens(),
      "A refused invite must not leave an InviteToken behind: the seat check and the insert " +
        "share one transaction precisely so the refusal and the write cannot diverge."
    ).toBe(0);
    // The refusal is a product answer, not a crash. If it arrives via the
    // catch-all the admin reads "Couldn't invite right now" and never learns
    // about the plan cap — the message team-client.tsx toasts verbatim.
    expect(H.captureServerError).not.toHaveBeenCalled();
  });

  it("issues the invite, and counts seats inside the transaction, when there is room", async () => {
    H.world.members = 1;

    const res = (await inviteUserAction(NEW_HIRE)) as {
      success: boolean;
      data?: { email: string };
    };

    expect(res.success).toBe(true);
    expect(res.data?.email).toBe("zara@nimbus.app");
    expect(createdTokens()).toBe(1);
    expect(H.world.pending).toEqual(["zara@nimbus.app"]);
    // The shape, not just the outcome: both seat counts must run inside the
    // transaction that writes the token. A fix that only re-ordered the reads
    // outside it would pass the case above by luck of timing and fail here.
    expect(
      countsInsideTransaction(),
      "Both seat counts (members and pending invites) must be read inside the transaction " +
        "that creates the token."
    ).toBe(2);
    expect(pathsOf().indexOf("$transaction")).toBeLessThan(pathsOf().indexOf("inviteToken.count"));
  });

  it("refuses when members plus pending invites already fill the plan", async () => {
    H.world.members = 1;
    H.world.pending = ["omar@nimbus.app"];

    const res = (await inviteUserAction(NEW_HIRE)) as { success: boolean; error?: string };

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/limited to 2 members/);
    expect(createdTokens()).toBe(0);
  });

  it("still lets an admin re-invite the SAME address at the cap", async () => {
    // The documented invariant that moving the count could have broken: the
    // current address's pending invite is cleared first, so a resend never
    // counts itself out of a seat. One member + Zara's own stale invite = 2,
    // which is the cap — and this must still go through.
    H.world.members = 1;
    H.world.pending = ["zara@nimbus.app"];

    const res = (await inviteUserAction(NEW_HIRE)) as { success: boolean; error?: string };

    expect(
      res.success,
      "Re-inviting the same address counted that address's own pending invite against the " +
        "cap, so a resend to the last seat refused itself."
    ).toBe(true);
    expect(H.world.pending).toEqual(["zara@nimbus.app"]);
  });

  it("caps a workspace whose Team subscription has lapsed, not just one whose plan column says free", async () => {
    // bill-004, at the gate the finding named. `inviteUserAction` reads the WHOLE
    // Company row and then asked `memberLimitForPlan(company.plan)`, which knows
    // only the string: a workspace still carrying plan="team" because a
    // `subscription_expired` delivery was lost kept issuing unlimited invites for
    // free. `acceptInviteAction` has asked `memberLimitForCompany` — plan, status
    // and paid-through date — since bill-013, so the two gates disagreed about
    // who is entitled to a seat.
    H.world.plan = "team";
    H.world.subscriptionStatus = "expired";
    H.world.currentPeriodEnd = new Date("2026-06-01T00:00:00Z");
    H.world.members = 2;

    const res = (await inviteUserAction(NEW_HIRE)) as { success: boolean; error?: string };

    expect(
      res.success,
      "A lapsed subscription must cap the invite gate too. Entitlement is (plan, status, " +
        "paid-through date), and this action holds all three."
    ).toBe(false);
    expect(res.error).toMatch(/limited to 2 members/);
    expect(createdTokens()).toBe(0);
  });

  it("counts nothing on the Team plan, where the cap is unbounded", async () => {
    H.world.plan = "team";
    H.world.subscriptionStatus = "active";
    H.world.currentPeriodEnd = new Date(Date.now() + 30 * 86_400_000);
    H.world.members = 40;

    const res = (await inviteUserAction(NEW_HIRE)) as { success: boolean };

    expect(res.success).toBe(true);
    expect(
      pathsOf().filter((p) => /\.count$/.test(p)),
      "An unlimited plan must not pay for two count queries on every invite."
    ).toEqual([]);
  });
});

/* ── 2. the reactivation gate, which had none ───────────────────────────── */

describe("reactivateUserAction — restoring a teammate takes a seat", () => {
  it("refuses to restore a teammate when the Free plan is already full", async () => {
    // The whole bypass, with no race in it. The workspace had 2 members; the
    // admin deactivated Bilal (1 active), invited and onboarded his
    // replacement (2 active), and now presses Reactivate on Bilal.
    H.world.members = 2;

    const res = (await reactivateUserAction(H.world.target.id)) as {
      success: boolean;
      error?: string;
    };

    expect(
      res.success,
      "Reactivate carried no seat check of any kind, so deactivate → invite → reactivate " +
        "put a third member on a two-member plan every time, deterministically. It is the " +
        "same cap `inviteUserAction` and `acceptInviteAction` both enforce."
    ).toBe(false);
    expect(res.error).toMatch(/limited to 2 members/);
    expect(
      pathsOf().includes("user.update"),
      "A refused reactivation must not clear the tombstone."
    ).toBe(false);
    expect(H.captureServerError).not.toHaveBeenCalled();
  });

  it("restores a teammate when there is a seat for them", async () => {
    H.world.members = 1;

    const res = (await reactivateUserAction(H.world.target.id)) as { success: boolean };

    expect(res.success).toBe(true);
    expect(pathsOf().includes("user.update")).toBe(true);
  });

  it("counts the seat inside the transaction that clears the tombstone", async () => {
    H.world.members = 1;
    // A seat committed by someone else between the admin's click and the write.
    H.hooks.onTransactionOpen = () => {
      H.world.members = 2;
    };

    const res = (await reactivateUserAction(H.world.target.id)) as { success: boolean };

    expect(res.success).toBe(false);
    expect(pathsOf().includes("user.update")).toBe(false);
  });

  it("restores without counting when the workspace is on the Team plan", async () => {
    H.world.plan = "team";
    H.world.subscriptionStatus = "active";
    H.world.currentPeriodEnd = new Date(Date.now() + 30 * 86_400_000);
    H.world.members = 40;

    const res = (await reactivateUserAction(H.world.target.id)) as { success: boolean };

    expect(res.success).toBe(true);
    expect(pathsOf().filter((p) => p === "user.count")).toEqual([]);
  });

  it("is still a no-op for a teammate who is already active", async () => {
    H.world.target.deletedAt = null;
    H.world.members = 40;

    const res = (await reactivateUserAction(H.world.target.id)) as { success: boolean };

    expect(
      res.success,
      "An already-active teammate must not be refused by the cap they are already inside — " +
        "the UI calls this to refresh and would show a false plan error."
    ).toBe(true);
    expect(pathsOf().includes("user.update")).toBe(false);
  });
});
