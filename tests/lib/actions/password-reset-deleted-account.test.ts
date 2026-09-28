/**
 * "Forgot password" for an account that no longer exists — the door that did
 * not just refuse, it lied (auth-006).
 *
 * WHAT HAPPENED. Three queries disagreed about what a tombstone means.
 * `authorize()` filters `deletedAt: null`, so a soft-deleted user cannot sign
 * in. Both password-reset lookups omitted the filter, so the reset ran all the
 * way through: it verified the token, hashed the new password, wrote it, bumped
 * `sessionVersion`, and returned success. The customer was told their new
 * password was set — and sign-in still answered "Invalid email or password".
 * The one recovery path a locked-out person would try was the one that claimed
 * to have fixed the problem.
 *
 * Two independent harms in that, and the tests below separate them:
 *   1. THE LIE. A success envelope for an account that cannot be signed into.
 *   2. THE WRITE. It rewrote the password hash on a TOMBSTONED row and advanced
 *      its session version — mutating data inside the retention window that
 *      CLAUDE.md promises is restorable with one `UPDATE … SET "deletedAt" =
 *      NULL`. So the assertion is not only "does it refuse", it is "does it
 *      touch the row at all".
 *
 * WHY THE FAKE HONOURS `where`. The defect is a MISSING FILTER, and a fake that
 * returns a canned row whatever it is asked passes with or without the fix —
 * that is exactly the vacuous shape this repo keeps re-finding. So the fake
 * below holds one row and applies the `where` the action actually sent, which
 * means `deletedAt: null` is the only thing that can make the tombstoned cases
 * pass. `findUnique` cannot express that filter at all (Prisma only accepts
 * unique fields there), which is why the wrong operation is named as well.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

/* ─────────────────────────────────────────────────────────────────────────── */
/* Fake Prisma client — one user row, honest `where` handling                   */
/* ─────────────────────────────────────────────────────────────────────────── */

const H = vi.hoisted(() => {
  type Call = { path: string; args: Record<string, unknown> };
  const calls: Call[] = [];

  const row = {
    id: "u_ayesha",
    email: "ayesha@nimbus.app",
    name: "Ayesha",
    passwordHash: "bcrypt$old",
    sessionVersion: 3,
    deletedAt: null as Date | null,
  };

  function matches(where: Record<string, unknown> | undefined): boolean {
    if (!where) return true;
    if (where.email !== undefined && where.email !== row.email) return false;
    if (where.id !== undefined && where.id !== row.id) return false;
    if (Object.prototype.hasOwnProperty.call(where, "deletedAt")) {
      // The only form either action has any business sending.
      if (where.deletedAt === null && row.deletedAt !== null) return false;
    }
    return true;
  }

  const read = (path: string) => (args: Record<string, unknown>) => {
    calls.push({ path, args: args ?? {} });
    return Promise.resolve(matches(args?.where as Record<string, unknown>) ? { ...row } : null);
  };

  const db = {
    user: {
      findUnique: read("user.findUnique"),
      findFirst: read("user.findFirst"),
      update: (args: Record<string, unknown>) => {
        calls.push({ path: "user.update", args: args ?? {} });
        return Promise.resolve({ ...row });
      },
    },
  };

  return { calls, row, db };
});

const mail = vi.hoisted(() => ({
  sendEmail: vi.fn(() => Promise.resolve({ delivered: true, devLogged: false })),
}));
const sentry = vi.hoisted(() => ({ captureServerError: vi.fn() }));
const token = vi.hoisted(() => ({
  passwordVersion: (hash: string) => "pv(" + hash + ")",
  signPasswordResetToken: vi.fn(() => Promise.resolve("signed.reset.token")),
  verified: {
    ok: true as const,
    userId: "u_ayesha",
    pv: "pv(bcrypt$old)",
  },
}));

vi.mock("@/lib/db", () => ({ db: H.db }));
vi.mock("@/lib/email/send", () => ({ sendEmail: mail.sendEmail }));
vi.mock("@/lib/sentry-server", () => ({ captureServerError: sentry.captureServerError }));
vi.mock("@/lib/auth/password-reset-token", () => ({
  passwordVersion: token.passwordVersion,
  signPasswordResetToken: token.signPasswordResetToken,
  verifyPasswordResetToken: () => Promise.resolve(token.verified),
}));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  // Spread the real module so a NEW export cannot silently break this suite:
  // a factory mock REPLACES the module, so an omitted export is absent, and
  // wiring gateAuthAction broke 31 tests across three files exactly this way.
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  limiters: { auth: { consume: () => ({ allowed: true }) } },
  gateAuthAction: () => ({ allowed: true }),
}));
vi.mock("@/lib/client-ip", () => ({ getClientIp: () => Promise.resolve("203.0.113.7") }));
vi.mock("bcryptjs", () => ({
  default: { hash: () => Promise.resolve("bcrypt$new"), compare: () => Promise.resolve(true) },
}));

import { requestPasswordResetAction, resetPasswordAction } from "@/lib/actions/password-reset";

const STRONG = "Str0ng-Passw0rd!";

function callsTo(path: string) {
  return H.calls.filter((c) => c.path === path);
}

/** Every read of the User row, whichever operation was used. */
function lookups() {
  return H.calls.filter((c) => c.path === "user.findFirst" || c.path === "user.findUnique");
}

beforeEach(() => {
  H.calls.length = 0;
  H.row.deletedAt = null;
  H.row.passwordHash = "bcrypt$old";
  mail.sendEmail.mockClear();
  token.signPasswordResetToken.mockClear();
  sentry.captureServerError.mockClear();
  token.verified = { ok: true, userId: "u_ayesha", pv: "pv(bcrypt$old)" };
});

/* ─────────────────────────────────────────────────────────────────────────── */
/* requestPasswordResetAction                                                  */
/* ─────────────────────────────────────────────────────────────────────────── */

describe("requestPasswordResetAction — a deleted account gets no reset link", () => {
  it("sends nothing for a tombstoned account", async () => {
    H.row.deletedAt = new Date("2026-09-01T10:00:00Z");
    const result = await requestPasswordResetAction({ email: H.row.email });
    // Same envelope an unknown address gets — the anti-enumeration posture is
    // the reason this returns success, and it must not change.
    expect(result).toEqual({ success: true, data: { dispatched: false } });
    expect(mail.sendEmail).not.toHaveBeenCalled();
    expect(token.signPasswordResetToken).not.toHaveBeenCalled();
  });

  it("asks a question that can exclude a tombstone", async () => {
    H.row.deletedAt = new Date("2026-09-01T10:00:00Z");
    await requestPasswordResetAction({ email: H.row.email });
    const read = lookups()[0];
    expect(read, "the action must look the user up").toBeTruthy();
    // `findUnique` is the operation that CANNOT carry this filter.
    expect(read.path).toBe("user.findFirst");
    expect(read.args.where).toMatchObject({ email: H.row.email, deletedAt: null });
  });

  it("still emails a live account", async () => {
    const result = await requestPasswordResetAction({ email: H.row.email });
    expect(result).toEqual({ success: true, data: { dispatched: true } });
    expect(mail.sendEmail).toHaveBeenCalledTimes(1);
    const sent = (mail.sendEmail.mock.calls as unknown as unknown[][])[0][0] as {
      to: string;
      text: string;
    };
    expect(sent.to).toBe(H.row.email);
    expect(sent.text).toContain("signed.reset.token");
  });
});

/* ─────────────────────────────────────────────────────────────────────────── */
/* resetPasswordAction                                                         */
/* ─────────────────────────────────────────────────────────────────────────── */

describe("resetPasswordAction — a deleted account is told the truth", () => {
  it("refuses instead of reporting success", async () => {
    H.row.deletedAt = new Date("2026-09-01T10:00:00Z");
    const result = await resetPasswordAction({ token: "signed.reset.token", password: STRONG });
    expect(result).toEqual({ success: false, error: "This account no longer exists." });
  });

  it("does not rewrite the password on a tombstoned row", async () => {
    // The row is inside the retention window CLAUDE.md promises is restorable
    // with one UPDATE. A reset used to rewrite its hash and advance its session
    // version, which is a mutation of data nobody can see and support is told
    // they can restore.
    H.row.deletedAt = new Date("2026-09-01T10:00:00Z");
    await resetPasswordAction({ token: "signed.reset.token", password: STRONG });
    expect(callsTo("user.update")).toHaveLength(0);
  });

  it("reads the tombstone in the same query as the user", async () => {
    H.row.deletedAt = new Date("2026-09-01T10:00:00Z");
    await resetPasswordAction({ token: "signed.reset.token", password: STRONG });
    const read = lookups()[0];
    expect(read.path).toBe("user.findFirst");
    expect(read.args.where).toMatchObject({ id: "u_ayesha", deletedAt: null });
  });

  it("still resets a live account, and still kills its other sessions", async () => {
    const result = await resetPasswordAction({ token: "signed.reset.token", password: STRONG });
    expect(result).toEqual({ success: true, data: { email: H.row.email } });
    const update = callsTo("user.update")[0];
    const data = update.args.data as Record<string, unknown>;
    expect(data.passwordHash).toBe("bcrypt$new");
    // Session invalidation is load-bearing (CLAUDE.md): the bump has to land in
    // the SAME update as the hash so the two cannot land apart.
    expect(data.sessionVersion).toEqual({ increment: 1 });
  });

  it("still rejects a replayed link on a live account", async () => {
    // Single-use enforcement lives in the same block that was changed; a stale
    // pv must still lose.
    token.verified = { ok: true, userId: "u_ayesha", pv: "pv(bcrypt$ancient)" };
    const result = await resetPasswordAction({ token: "signed.reset.token", password: STRONG });
    expect(result).toEqual({
      success: false,
      error: "This reset link has already been used. Request a new one.",
    });
    expect(callsTo("user.update")).toHaveLength(0);
  });
});
