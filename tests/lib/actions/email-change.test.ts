// @vitest-environment node

/**
 * The email-change token chain, end to end.
 *
 * NODE ENVIRONMENT, ON PURPOSE. The repo default is jsdom, and jsdom supplies
 * its own `TextEncoder` whose `Uint8Array` comes from a different realm — jose
 * then refuses the HMAC key with "Key for the HS256 algorithm must be one of
 * type CryptoKey, KeyObject, JSON Web Key, or Uint8Array. Received an instance
 * of Uint8Array", so every real token mint fails for a reason that has nothing
 * to do with this flow. Nothing here renders a component.
 *
 * FOUR AUDIT ROWS, ONE STORY (acct-004, auth-004, auth-005, sec-010). Changing
 * the login email is the last step of an account takeover, because /forgot-
 * password delivers to whatever address the row holds. The shipped flow made
 * that step free:
 *
 *   • no re-authentication — a session cookie was the whole credential, unlike
 *     `changePasswordAction` and `deleteAccountAction`, which both bcrypt-check
 *     the current password (sec-010, auth-005);
 *   • nothing told the OLD address its login was being moved, so the owner had
 *     no signal at all (auth-005, sec-010);
 *   • the confirm link was a bare 1-hour JWT carrying `{ sub, newEmail }` and
 *     nothing about the account it was minted against, so changing the password
 *     — the documented remedy for "someone had my session" — did NOT revoke it
 *     (acct-004), and a stale link could still be replayed after a later change
 *     landed, snapping the login address back to a previous value (auth-004);
 *   • confirming wrote `{ email, emailVerifiedAt }` and left every other live
 *     session alone (auth-005, sec-010).
 *
 * WHY THESE TESTS LOOK LIKE THIS — the trap this repo keeps falling into is a
 * test that encodes the bug. The cheap version of this file asserts
 * `success === true` on a confirm, which was already true of the vulnerable
 * code; the address changed successfully. So every assertion below names the
 * thing that must NOT happen: no `user.update` at all on a revoked link, and a
 * `user.update` whose `data` carries `sessionVersion` in the SAME object as the
 * new email (one UPDATE — the two cannot land apart, exactly as
 * lib/actions/password-reset.ts:153 does it for the hash).
 *
 * The fake Prisma client RECORDS every call so the tests can ask "which
 * operation, with which where/data", not merely "did it resolve".
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import bcrypt from "bcryptjs";

/* ─────────────────────────────────────────────────────────────────────────── */
/* Fakes                                                                       */
/* ─────────────────────────────────────────────────────────────────────────── */

/**
 * `vi.mock` factories are hoisted above the imports, so anything they close
 * over has to be built inside `vi.hoisted` (see tests/lib/actions/soft-delete
 * .test.ts for the same note) — a plain module-scope `const` is still
 * undefined when the factory runs.
 */
const H = vi.hoisted(() => {
  const calls: Array<{ path: string; args: Record<string, unknown> }> = [];
  const results = new Map<string, unknown>();
  const sent: Array<{ to: string; subject: string; html: string; text?: string }> = [];

  const OPS = ["findUnique", "findFirst", "update", "count"];
  type Op = (args?: Record<string, unknown>) => Promise<unknown>;
  const user: Record<string, Op> = {};
  for (const op of OPS) {
    const path = `user.${op}`;
    user[op] = async (args?: Record<string, unknown>) => {
      calls.push({ path, args: args ?? {} });
      const canned = results.get(path);
      return typeof canned === "function"
        ? (canned as (a: Record<string, unknown>) => unknown)(args ?? {})
        : canned;
    };
  }

  return { db: { user }, calls, results, sent, session: { value: null as unknown } };
});

vi.mock("@/lib/db", () => ({ db: H.db }));
vi.mock("@/lib/auth", () => ({ auth: async () => H.session.value }));
vi.mock("@/lib/client-ip", () => ({ getClientIp: async () => "203.0.113.7" }));
vi.mock("@/lib/sentry-server", () => ({ captureServerError: vi.fn() }));
// Always-open limiter: the real `auth` bucket is 5/min per IP and every test
// here shares one IP, so the ninth test would fail on the throttle rather than
// on what it is asserting. The throttle itself is covered in
// tests/lib/rate-limit.test.ts.
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  // Spread the real module so a NEW export cannot silently break this suite:
  // a factory mock REPLACES the module, so an omitted export is absent, and
  // wiring gateAuthAction broke 31 tests across three files exactly this way.
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  limiters: { auth: { consume: () => ({ allowed: true }) } },
  gateAuthAction: () => ({ allowed: true }),
}));
vi.mock("@/lib/email/send", () => ({
  sendEmail: async (input: { to: string; subject: string; html: string; text?: string }) => {
    H.sent.push(input);
    return { delivered: true, devLogged: false };
  },
}));

import { requestEmailChangeAction, confirmEmailChangeAction } from "@/lib/actions/email-change";
import {
  emailChangeBinding,
  signEmailChangeToken,
  verifyEmailChangeToken,
} from "@/lib/auth/email-change-token";

/* ─────────────────────────────────────────────────────────────────────────── */
/* Helpers                                                                     */
/* ─────────────────────────────────────────────────────────────────────────── */

const PASSWORD = "correct-horse-battery";
/** Work factor 4, not 12 — these tests hash dozens of times and never ship. */
const HASH = bcrypt.hashSync(PASSWORD, 4);
const OTHER_HASH = bcrypt.hashSync("something-else-entirely", 4);

const OLD_EMAIL = "founder@nimbus.app";
const NEW_EMAIL = "founder@newdomain.com";

type Row = {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
  sessionVersion: number;
  deletedAt: Date | null;
};

function row(over: Partial<Row> = {}): Row {
  return {
    id: "u1",
    name: "Ayesha",
    email: OLD_EMAIL,
    passwordHash: HASH,
    sessionVersion: 0,
    deletedAt: null,
    ...over,
  };
}

function when(path: string, value: unknown): void {
  H.results.set(path, value);
}

/**
 * The live user row, served to whichever single-row read the action reaches
 * for, and honouring a `deletedAt: null` filter if one is present — that
 * filter is itself under test (acct-004 noted the confirm path had none), so a
 * fake that ignored it would report a pass the database would not.
 */
function liveRow(r: Row | null): void {
  const serve = (args: Record<string, unknown>) => {
    if (!r) return null;
    const where = (args.where ?? {}) as Record<string, unknown>;
    if ("deletedAt" in where && where.deletedAt === null && r.deletedAt !== null) return null;
    if (typeof where.email === "string" && where.email !== r.email) return null;
    if (typeof where.id === "string" && where.id !== r.id) return null;
    return r;
  };
  when("user.findUnique", serve);
  when("user.findFirst", serve);
}

function callsTo(path: string): Array<Record<string, unknown>> {
  return H.calls.filter((c) => c.path === path).map((c) => c.args);
}

function updates(): Array<Record<string, unknown>> {
  return callsTo("user.update");
}

function mailTo(address: string) {
  return H.sent.filter((m) => m.to === address);
}

function signedIn(id = "u1"): void {
  H.session.value = { user: { id, companyId: "c1", role: "admin" } };
}

/** Extracts the token out of the confirmation link the action mailed. */
function tokenFromMail(address = NEW_EMAIL): string {
  const mail = mailTo(address).at(-1);
  if (!mail) throw new Error(`no email was sent to ${address}`);
  const m = /token=([^"&\s<]+)/.exec(mail.text ?? mail.html);
  if (!m) throw new Error(`no token in the email sent to ${address}`);
  return decodeURIComponent(m[1]);
}

beforeEach(() => {
  process.env.AUTH_SECRET = "test-secret-for-email-change-tokens";
  process.env.NEXT_PUBLIC_APP_URL = "https://founderflow.test";
  H.calls.length = 0;
  H.results.clear();
  H.sent.length = 0;
  H.session.value = null;
});

/* ─────────────────────────────────────────────────────────────────────────── */
/* sec-010 / auth-005 — moving the login address is a credential change        */
/* ─────────────────────────────────────────────────────────────────────────── */

describe("requestEmailChangeAction re-authenticates (sec-010, auth-005)", () => {
  it("refuses to start a change when no current password is supplied", async () => {
    signedIn();
    liveRow(row());

    const res = await requestEmailChangeAction({ newEmail: NEW_EMAIL });

    expect(res.success).toBe(false);
    // Nothing may be mailed and no token may exist: a borrowed tab must not be
    // able to put a working confirmation link into an attacker's inbox.
    expect(H.sent).toEqual([]);
  });

  it("refuses when the supplied password is wrong, and mails nobody", async () => {
    signedIn();
    liveRow(row());

    const res = await requestEmailChangeAction({ newEmail: NEW_EMAIL, password: "not-it" });

    expect(res.success).toBe(false);
    expect(res.success === false && res.error).toMatch(/password/i);
    expect(H.sent).toEqual([]);
  });

  it("proceeds when the current password checks out", async () => {
    signedIn();
    liveRow(row());

    const res = await requestEmailChangeAction({ newEmail: NEW_EMAIL, password: PASSWORD });

    expect(res.success).toBe(true);
    expect(mailTo(NEW_EMAIL)).toHaveLength(1);
  });

  it("tells the OLD address that its login is being moved", async () => {
    signedIn();
    liveRow(row());

    await requestEmailChangeAction({ newEmail: NEW_EMAIL, password: PASSWORD });

    const notice = mailTo(OLD_EMAIL);
    expect(notice).toHaveLength(1);
    // The notice names where the address is going and how to stop it. Without
    // the "wasn't me" pointer the owner has a mystery, not a control.
    expect(notice[0].text ?? notice[0].html).toContain(NEW_EMAIL);
    expect(notice[0].text ?? notice[0].html).toMatch(/password/i);
    // And it must not hand the old inbox the confirmation link — that would
    // make the notice itself a second way to complete the change.
    expect(notice[0].html).not.toContain("/verify-email-change?token=");
  });

  it("does not start a change for a tombstoned account", async () => {
    signedIn();
    liveRow(row({ deletedAt: new Date("2026-09-01T00:00:00.000Z") }));

    const res = await requestEmailChangeAction({ newEmail: NEW_EMAIL, password: PASSWORD });

    expect(res.success).toBe(false);
    expect(H.sent).toEqual([]);
  });
});

/* ─────────────────────────────────────────────────────────────────────────── */
/* auth-005 / sec-010 — the confirm must revoke every other session            */
/* ─────────────────────────────────────────────────────────────────────────── */

describe("confirmEmailChangeAction (auth-005, sec-010)", () => {
  async function aPendingLink(over: Partial<Row> = {}): Promise<string> {
    signedIn();
    liveRow(row(over));
    const res = await requestEmailChangeAction({ newEmail: NEW_EMAIL, password: PASSWORD });
    expect(res.success).toBe(true);
    const token = tokenFromMail();
    H.calls.length = 0;
    H.sent.length = 0;
    return token;
  }

  it("bumps sessionVersion in the SAME update as the new email", async () => {
    const token = await aPendingLink();
    liveRow(row());

    const res = await confirmEmailChangeAction({ token });

    expect(res.success).toBe(true);
    expect(updates()).toHaveLength(1);
    const data = (updates()[0].data ?? {}) as Record<string, unknown>;
    expect(data.email).toBe(NEW_EMAIL);
    expect(data.emailVerifiedAt).toBeInstanceOf(Date);
    // One UPDATE, both fields: a change of login address that leaves the
    // attacker's session alive has changed nothing they care about.
    expect(data.sessionVersion).toEqual({ increment: 1 });
  });

  it("tells the OLD address after the swap has landed", async () => {
    const token = await aPendingLink();
    liveRow(row());

    await confirmEmailChangeAction({ token });

    const notice = mailTo(OLD_EMAIL);
    expect(notice).toHaveLength(1);
    expect(notice[0].text ?? notice[0].html).toContain(NEW_EMAIL);
  });

  it("refuses a tombstoned account", async () => {
    const token = await aPendingLink();
    liveRow(row({ deletedAt: new Date("2026-09-20T00:00:00.000Z") }));

    const res = await confirmEmailChangeAction({ token });

    expect(res.success).toBe(false);
    expect(updates()).toEqual([]);
  });
});

/* ─────────────────────────────────────────────────────────────────────────── */
/* acct-004 — a password change must revoke the pending link                   */
/* ─────────────────────────────────────────────────────────────────────────── */

describe("a pending email-change link and the password remedy (acct-004)", () => {
  it("is dead once the victim changes their password", async () => {
    // The attacker holds a session, requests a change to their own address and
    // walks away. (They know the password in this scenario — a shoulder-surfed
    // or shared one; re-auth raises the bar but is not the whole fix.)
    signedIn();
    liveRow(row());
    const req = await requestEmailChangeAction({ newEmail: NEW_EMAIL, password: PASSWORD });
    expect(req.success).toBe(true);
    const attackerLink = tokenFromMail();
    H.calls.length = 0;
    H.sent.length = 0;

    // The victim notices and changes their password. changePasswordAction
    // writes the new hash and bumps sessionVersion in one UPDATE
    // (lib/actions/profile.ts), which is the state the live row is now in.
    liveRow(row({ passwordHash: OTHER_HASH, sessionVersion: 1 }));

    const res = await confirmEmailChangeAction({ token: attackerLink });

    expect(res.success).toBe(false);
    expect(res.success === false && res.error).toMatch(/no longer valid|expired|again/i);
    // The load-bearing assertion: no write happened. A "success: false" that
    // still moved the address would pass a laxer test.
    expect(updates()).toEqual([]);
  });

  it("is dead once every device is signed out, even with the password unchanged", async () => {
    signedIn();
    liveRow(row());
    await requestEmailChangeAction({ newEmail: NEW_EMAIL, password: PASSWORD });
    const link = tokenFromMail();
    H.calls.length = 0;
    H.sent.length = 0;

    // bumpSessionVersion() — the future "log out all devices" lever.
    liveRow(row({ sessionVersion: 7 }));

    const res = await confirmEmailChangeAction({ token: link });

    expect(res.success).toBe(false);
    expect(updates()).toEqual([]);
  });
});

/* ─────────────────────────────────────────────────────────────────────────── */
/* auth-004 — single use, and no snap-back to an earlier address               */
/* ─────────────────────────────────────────────────────────────────────────── */

describe("a stale confirmation link cannot move the address back (auth-004)", () => {
  it("rejects the A→B link once the account has moved on to C", async () => {
    const TYPO = "founder@newdomian.com"; // B — the typo
    const MEANT = "founder@newdomain.com"; // C — what they meant

    signedIn();
    liveRow(row());
    await requestEmailChangeAction({ newEmail: TYPO, password: PASSWORD });
    const typoLink = tokenFromMail(TYPO);
    H.sent.length = 0;
    H.calls.length = 0;

    // They spot the typo, request the right address and confirm that one, so
    // the row is now C with the session version the confirm bumped.
    liveRow(row({ email: MEANT, sessionVersion: 1 }));

    // A mail client prefetches the older message, or they re-click it.
    const res = await confirmEmailChangeAction({ token: typoLink });

    expect(res.success).toBe(false);
    // The lockout this prevents: their login address must still be C.
    expect(updates()).toEqual([]);
  });

  it("cannot be replayed after it has already been used once", async () => {
    signedIn();
    liveRow(row());
    await requestEmailChangeAction({ newEmail: NEW_EMAIL, password: PASSWORD });
    const link = tokenFromMail();

    liveRow(row());
    const first = await confirmEmailChangeAction({ token: link });
    expect(first.success).toBe(true);

    // The successful confirm wrote the new email AND bumped sessionVersion, so
    // the live row no longer matches what the token was minted against.
    liveRow(row({ email: NEW_EMAIL, sessionVersion: 1 }));
    H.calls.length = 0;

    const second = await confirmEmailChangeAction({ token: link });

    expect(second.success).toBe(false);
    expect(updates()).toEqual([]);
  });
});

/* ─────────────────────────────────────────────────────────────────────────── */
/* The binding itself — pure, no database                                      */
/* ─────────────────────────────────────────────────────────────────────────── */

describe("emailChangeBinding", () => {
  const state = { email: OLD_EMAIL, sessionVersion: 0, passwordHash: HASH };

  it("is stable for an unchanged account", () => {
    expect(emailChangeBinding(state)).toBe(emailChangeBinding({ ...state }));
  });

  it("moves when the session version moves (password change, reset, logout-all)", () => {
    expect(emailChangeBinding({ ...state, sessionVersion: 1 })).not.toBe(emailChangeBinding(state));
  });

  it("moves when the current email moves (a later change already landed)", () => {
    expect(emailChangeBinding({ ...state, email: NEW_EMAIL })).not.toBe(emailChangeBinding(state));
  });

  it("moves when the password hash moves, even if sessionVersion did not", () => {
    // Belt and braces: both password paths bump sessionVersion today, but the
    // binding must not depend on them continuing to.
    expect(emailChangeBinding({ ...state, passwordHash: OTHER_HASH })).not.toBe(
      emailChangeBinding(state)
    );
  });

  it("leaks neither the address nor the hash", () => {
    const bv = emailChangeBinding(state);
    expect(bv).not.toContain(OLD_EMAIL);
    expect(bv).not.toContain(HASH);
    expect(bv).toMatch(/^[0-9a-f]{16}$/);
  });

  it("does not collide across a field boundary", () => {
    // "1" + "a@b" must not digest the same as "1a" + "@b".
    expect(emailChangeBinding({ email: "a@b", sessionVersion: 1, passwordHash: "x" })).not.toBe(
      emailChangeBinding({ email: "@b", sessionVersion: 1, passwordHash: "ax" })
    );
  });
});

describe("verifyEmailChangeToken", () => {
  beforeEach(() => {
    process.env.AUTH_SECRET = "test-secret-for-email-change-tokens";
  });

  it("round-trips the binding it was minted with", async () => {
    const bv = emailChangeBinding({ email: OLD_EMAIL, sessionVersion: 0, passwordHash: HASH });
    const token = await signEmailChangeToken("u1", NEW_EMAIL, bv);
    const verified = await verifyEmailChangeToken(token);

    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.userId).toBe("u1");
      expect(verified.newEmail).toBe(NEW_EMAIL);
      expect(verified.bv).toBe(bv);
    }
  });

  it("rejects a token that carries no binding at all", async () => {
    // The shape of every link minted before this fix, and the shape an
    // attacker would hand-roll if the claim were optional. Unbound is exactly
    // the vulnerability, so it is invalid rather than tolerated.
    const { SignJWT } = await import("jose");
    const unbound = await new SignJWT({
      sub: "u1",
      newEmail: NEW_EMAIL,
      purpose: "email-change",
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(process.env.AUTH_SECRET as string));

    const verified = await verifyEmailChangeToken(unbound);

    expect(verified.ok).toBe(false);
    expect(verified.ok === false && verified.reason).toBe("invalid");
  });
});
