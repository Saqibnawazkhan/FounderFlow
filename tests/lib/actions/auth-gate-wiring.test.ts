// @vitest-environment node
/**
 * auth-007 + prodready-004 — THE WIRING, not the decision.
 *
 * `gateAuthAction` (lib/rate-limit.ts) and `appOrigin` (lib/env.ts) were both
 * written, reviewed and unit-tested, and both had ZERO callers. Two findings
 * were recorded as fixed that a customer would still have experienced in full.
 * So the assertions here are deliberately NOT about the decision functions —
 * `tests/lib/rate-limit.test.ts` and `tests/lib/env/build-config.test.ts`
 * already own those, with 37 and ~20 cases. Every test below drives a REAL
 * server action and asserts what the person on the other end of it sees:
 *
 *   - does my verification link work, given what my colleagues just did?
 *   - does the reset e-mail I was sent contain a link that resolves?
 *
 * WHY THAT DISTINCTION IS THE WHOLE POINT. A diff that imports the new function
 * at all ten call sites and leaves behaviour unchanged looks exactly like a
 * diff that fixes the bug. A structural test ("does this file mention
 * gateAuthAction?") cannot tell those apart, and this repo has shipped the
 * green-test-no-behaviour shape six times. So the buckets here are the REAL
 * ones — `@/lib/rate-limit` is NOT mocked — and the counts are the counts a
 * user would hit.
 *
 * THE SHARED-BUCKET BUG, stated once: every one of ten auth actions consumed
 * `limiters.auth`, 5 per minute keyed on the client address. Behind one office
 * NAT that is one key for the whole company, so two sign-ins plus a signup plus
 * a "resend verification" spent the building's entire minute, and the sixth
 * person was told "Too many requests" about something they had not done. The
 * fix splits it by RISK CLASS, and each class is two-dimensional (per address
 * AND per account) wherever an identity exists.
 *
 * THE ORIGIN BUG: seven call sites each carried their own
 * `process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"`, and exactly one
 * of them stripped a trailing slash. Copy the origin out of a browser address
 * bar — `https://app.founderflow.com/` — and the other six emit
 * `https://app.founderflow.com//reset-password?token=…`, a URL that works in
 * one mail client and 404s in the next, in front of a locked-out customer.
 *
 * TWO NOTES ON THE MECHANICS:
 *   - `process.env.NEXT_PUBLIC_APP_URL` is set in a `vi.hoisted` block, which
 *     runs before the imports, because the call sites read it through
 *     `appOrigin(process.env.NEXT_PUBLIC_APP_URL)` at CALL time — deliberately,
 *     so the value stays a per-call read exactly as it is today. That is also
 *     why one test can change it mid-file.
 *   - node environment, not jsdom: nothing here renders, and the action modules
 *     pull in bcrypt/next-auth shapes that have no business in a DOM.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

/* ─────────────────────────────────────────────────────────────────────────── */
/* The public origin, set BEFORE any import — see the header.                   */
/* A TRAILING SLASH on purpose: it is what a human pastes.                      */
/* ─────────────────────────────────────────────────────────────────────────── */

const ENV = vi.hoisted(() => {
  const previous = process.env.NEXT_PUBLIC_APP_URL;
  process.env.NEXT_PUBLIC_APP_URL = "https://app.founderflow.com/";
  return { previous, host: "https://app.founderflow.com" };
});

/* ─────────────────────────────────────────────────────────────────────────── */
/* Fakes. One user table honouring `where`, one outbox, one mutable session.    */
/* ─────────────────────────────────────────────────────────────────────────── */

const H = vi.hoisted(() => {
  type Row = {
    id: string;
    email: string;
    name: string;
    passwordHash: string;
    sessionVersion: number;
    emailVerifiedAt: Date | null;
    companyId: string;
    role: string;
    deletedAt: Date | null;
  };
  type Mail = { to: string; subject: string; html: string; text: string };

  const rows: Row[] = [];
  const outbox: Mail[] = [];
  const ip = { value: "203.0.113.7" };
  const session = { value: null as unknown };
  const passwordOk = { value: false };
  const verificationSends: string[] = [];

  function byId(id: string): Row | null {
    for (let i = 0; i < rows.length; i++) if (rows[i].id === id) return rows[i];
    return null;
  }
  function byEmail(email: string): Row | null {
    for (let i = 0; i < rows.length; i++) if (rows[i].email === email) return rows[i];
    return null;
  }

  /**
   * The fake honours `where`, including `deletedAt: null`. A fake that returns a
   * canned row whatever it is asked passes with or without the fix — the
   * vacuous shape this repo keeps re-finding.
   */
  function match(where: Record<string, unknown> | undefined): Row | null {
    if (!where) return null;
    let row: Row | null = null;
    if (typeof where.id === "string") row = byId(where.id);
    else if (typeof where.email === "string") row = byEmail(where.email);
    if (!row) return null;
    if (Object.prototype.hasOwnProperty.call(where, "deletedAt")) {
      if (where.deletedAt === null && row.deletedAt !== null) return null;
    }
    return row;
  }

  type Args = { where?: Record<string, unknown>; data?: Record<string, unknown> } | undefined;

  const read = (args: Args) => Promise.resolve(match(args?.where));

  let created = 0;
  const tx = {
    company: {
      create: () => Promise.resolve({ id: "c_new_" + ++created }),
      update: () => Promise.resolve({}),
    },
    user: {
      create: () => Promise.resolve({ id: "u_new_" + created }),
      // `resendInviteAction` became a seat gate: reviving a lapsed token adds a
      // live seat, so it now rotates and counts inside ONE transaction (the
      // regression an adversarial verifier found in team-and-invites-004). The
      // count therefore runs against THIS object, not the outer `db` — which is
      // the whole point of handing out a narrower client.
      count: () => Promise.resolve(1),
    },
    // Zero live invites, so one member is under the Free cap and the resend
    // proceeds to the part this file actually asserts: the invite URL's origin.
    // Stubbed rather than asserted, because the seat behaviour is pinned properly
    // in tests/lib/actions/seat-limit-race.test.ts and a second copy here would
    // be one more place to update and the one that rots.
    inviteToken: {
      update: () => Promise.resolve({}),
      count: () => Promise.resolve(0),
    },
    activity: { create: () => Promise.resolve({}) },
    project: { create: () => Promise.resolve({ id: "p_new_" + created }) },
  };

  const invite = {
    id: "inv_zara",
    companyId: "c_nimbus",
    email: "zara@nimbus.app",
    name: "Zara",
    role: "member",
    usedAt: null as Date | null,
    token: "old-token",
    expiresAt: new Date(Date.now() + 86_400_000),
  };

  const db = {
    user: {
      findUnique: read,
      findFirst: read,
      update: (args: Args) => {
        const row = match(args?.where);
        const data = args?.data ?? {};
        if (row) {
          const keys = Object.keys(data);
          for (let i = 0; i < keys.length; i++) {
            const value = data[keys[i]];
            // Skip Prisma operation objects ({ increment: 1 }) — nothing here
            // asserts on them and writing one in would corrupt the row.
            if (value !== null && typeof value === "object" && !(value instanceof Date)) continue;
            (row as unknown as Record<string, unknown>)[keys[i]] = value;
          }
        }
        return Promise.resolve(row ?? {});
      },
      count: () => Promise.resolve(1),
      updateMany: () => Promise.resolve({ count: 0 }),
    },
    company: {
      findUnique: () => Promise.resolve({ id: "c_nimbus", name: "Nimbus Labs" }),
      update: () => Promise.resolve({}),
    },
    inviteToken: {
      findUnique: () => Promise.resolve({ ...invite }),
      update: () => Promise.resolve({ ...invite }),
      // `resendInviteAction` became a seat gate: reviving a lapsed token adds a
      // live seat, so it now counts inside its write transaction (the regression
      // an adversarial verifier found in team-and-invites-004). This file is
      // about the invite URL's ORIGIN, not about seats, so the count answers
      // zero — one member plus no live invites is under the Free cap, and the
      // resend proceeds to the part this file actually asserts. Stubbed rather
      // than asserted on purpose: the seat behaviour is pinned properly in
      // tests/lib/actions/seat-limit-race.test.ts, and duplicating it here would
      // be two places to update and one of them would rot.
      count: () => Promise.resolve(0),
    },
    $transaction: (fn: (client: unknown) => Promise<unknown>) => fn(tx),
  };

  const signIn = vi.fn(() => Promise.resolve(undefined));
  const signOut = vi.fn(() => Promise.resolve(undefined));
  const captureServerError = vi.fn();

  const sendEmail = (mail: { to: string; subject: string; html: string; text?: string }) => {
    outbox.push({ to: mail.to, subject: mail.subject, html: mail.html, text: mail.text ?? "" });
    return Promise.resolve({ delivered: true, devLogged: false });
  };
  const sendVerificationEmail = (args: { email: string }) => {
    verificationSends.push(args.email);
    return Promise.resolve({ delivered: true, devLogged: false });
  };

  const resetToken = { pv: "pv:bcrypt$ayesha", userId: "u_ayesha" };

  return {
    rows,
    outbox,
    ip,
    session,
    passwordOk,
    verificationSends,
    db,
    signIn,
    signOut,
    captureServerError,
    sendEmail,
    sendVerificationEmail,
    resetToken,
    invite,
  };
});

/* ── module doubles. `@/lib/rate-limit` and `@/lib/env` stay REAL. ─────────── */

vi.mock("@/lib/db", () => ({ db: H.db }));
vi.mock("@/lib/auth", () => ({
  auth: () => Promise.resolve(H.session.value),
  signIn: H.signIn,
  signOut: H.signOut,
}));
vi.mock("@/lib/client-ip", () => ({ getClientIp: () => Promise.resolve(H.ip.value) }));
vi.mock("@/lib/sentry-server", () => ({ captureServerError: H.captureServerError }));
vi.mock("@/lib/email/send", () => ({ sendEmail: H.sendEmail }));
vi.mock("@/lib/email/verification", () => ({ sendVerificationEmail: H.sendVerificationEmail }));
vi.mock("@/lib/chat/bootstrap", () => ({
  ensureGeneralChannel: () => Promise.resolve(undefined),
  joinDefaultChannels: () => Promise.resolve(undefined),
}));
vi.mock("@/lib/safety/bulk-mutation-guard", () => ({ warnBulkMutation: () => undefined }));
vi.mock("@/lib/lemonsqueezy/config", () => ({ isBillingConfigured: () => false }));
vi.mock("@lemonsqueezy/lemonsqueezy.js", () => ({
  cancelSubscription: () => Promise.resolve({}),
}));
vi.mock("@/lib/notify/fan-out", () => ({ notifyUsers: () => Promise.resolve(undefined) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
// The real AuthError drags the whole next-auth entry point in for one
// `instanceof`; this is the only shape the actions inspect.
vi.mock("next-auth", () => ({ AuthError: class AuthError extends Error {} }));
// bcrypt at cost 12 is ~300ms a call and nothing here asserts on a hash.
vi.mock("bcryptjs", () => ({
  default: {
    hash: () => Promise.resolve("bcrypt$new"),
    compare: () => Promise.resolve(H.passwordOk.value),
  },
}));
vi.mock("@/lib/auth/password-reset-token", () => ({
  passwordVersion: (hash: string) => "pv:" + hash,
  signPasswordResetToken: () => Promise.resolve("signed.reset.token.value"),
  verifyPasswordResetToken: () =>
    Promise.resolve({ ok: true, userId: H.resetToken.userId, pv: H.resetToken.pv }),
}));
vi.mock("@/lib/auth/email-verification-token", () => ({
  verifyEmailVerificationToken: () => Promise.resolve({ ok: true, userId: "u_ayesha" }),
}));
vi.mock("@/lib/auth/email-change-token", () => ({
  emailChangeBinding: () => "binding",
  signEmailChangeToken: () => Promise.resolve("signed.change.token.value"),
  verifyEmailChangeToken: () =>
    Promise.resolve({ ok: true, userId: "u_ayesha", newEmail: "ayesha@new.app" }),
}));

import { limiters, resetAuthGates, UNTRUSTED_CLIENT_IP } from "@/lib/rate-limit";
import { loginAction, signupAction } from "@/lib/actions/auth";
import { requestPasswordResetAction, resetPasswordAction } from "@/lib/actions/password-reset";
import { resendVerificationEmailAction, verifyEmailAction } from "@/lib/actions/email-verification";
import { requestEmailChangeAction } from "@/lib/actions/email-change";
import { deleteAccountAction } from "@/lib/actions/account";
import { resendInviteAction } from "@/lib/actions/team";

/* ─────────────────────────────────────────────────────────────────────────── */

const OFFICE_IP = "203.0.113.7";
const TOKEN = "t".repeat(24);
const STRONG = "Str0ng-Passw0rd!";

type Result = { success: boolean; error?: string };

function user(over: Partial<{ id: string; email: string; role: string }>) {
  return {
    id: over.id ?? "u_ayesha",
    email: over.email ?? "ayesha@nimbus.app",
    name: "Ayesha",
    passwordHash: "bcrypt$ayesha",
    sessionVersion: 1,
    emailVerifiedAt: null as Date | null,
    companyId: "c_nimbus",
    role: over.role ?? "admin",
    deletedAt: null as Date | null,
  };
}

function sessionFor(id: string, role: string) {
  return { user: { id, companyId: "c_nimbus", role } };
}

function signupInput(n: number) {
  return {
    name: "New Founder",
    email: "founder" + n + "@nimbus.app",
    password: STRONG,
    companyName: "Nimbus " + n,
    industry: "SaaS",
    currency: "PKR",
  };
}

function refused(r: Result): boolean {
  return r.success === false && /Too many requests/.test(r.error ?? "");
}

beforeEach(() => {
  resetAuthGates();
  limiters.write.reset();
  H.rows.length = 0;
  H.rows.push(user({}), user({ id: "u_bilal", email: "bilal@nimbus.app", role: "member" }));
  H.outbox.length = 0;
  H.verificationSends.length = 0;
  H.ip.value = OFFICE_IP;
  H.session.value = sessionFor("u_ayesha", "admin");
  H.passwordOk.value = false;
  H.resetToken.pv = "pv:bcrypt$ayesha";
  H.resetToken.userId = "u_ayesha";
  H.signIn.mockClear();
  H.captureServerError.mockClear();
  process.env.NEXT_PUBLIC_APP_URL = "https://app.founderflow.com/";
});

afterAll(() => {
  if (ENV.previous === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = ENV.previous;
});

/* ═══════════════════════════════════════════════════════════════════════════ */
describe("a verification link is not refused because of what other people did", () => {
  it("still works after the office has sent five resend-verification emails", async () => {
    for (let i = 0; i < 5; i++) {
      const sent = (await resendVerificationEmailAction()) as Result;
      expect(sent.success, `resend ${i + 1} of 5 was refused: ${sent.error}`).toBe(true);
    }

    const clicked = (await verifyEmailAction({ token: TOKEN })) as Result;
    expect(
      clicked.error ?? "(none)",
      "A colleague clicked the verification link in their own e-mail and was told " +
        "'Too many requests' because five resend buttons had been pressed behind the " +
        "same office connection. Redeeming a signed link and sending an e-mail are " +
        "different risk classes and must not share a bucket."
    ).toBe("(none)");
    expect(clicked.success).toBe(true);
  });

  it("is not throttled at all where no proxy supplies a client address", async () => {
    // getClientIp() returns the sentinel off Vercel / behind an unknown proxy.
    // The OLD code fed that straight to consume(), so every such visitor in the
    // world shared ONE 5-per-minute bucket and one attacker could refuse
    // everybody's verification links at once.
    H.ip.value = UNTRUSTED_CLIENT_IP;
    for (let i = 0; i < 12; i++) {
      const clicked = (await verifyEmailAction({ token: TOKEN })) as Result;
      expect(clicked.success, `click ${i + 1} of 12 was refused: ${clicked.error}`).toBe(true);
    }
  });

  it("gives each teammate their own resend budget behind one office connection", async () => {
    for (let i = 0; i < 5; i++) {
      const sent = (await resendVerificationEmailAction()) as Result;
      expect(sent.success, `Ayesha's resend ${i + 1} of 5 was refused: ${sent.error}`).toBe(true);
    }
    // There IS still a limit, and it lands on the person who spent it.
    expect(refused((await resendVerificationEmailAction()) as Result)).toBe(true);

    H.session.value = sessionFor("u_bilal", "member");
    const bilal = (await resendVerificationEmailAction()) as Result;
    expect(
      bilal.error ?? "(none)",
      "Bilal pressed Resend for the first time and was refused because Ayesha, at the " +
        "next desk and therefore on the same IP, had pressed hers five times."
    ).toBe("(none)");
    expect(H.verificationSends[H.verificationSends.length - 1]).toBe("bilal@nimbus.app");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════ */
describe("signing in spends the credential budget and nothing else", () => {
  it("reports the throttle once the credential bucket is genuinely spent", async () => {
    // This is what authorize() does on each credential check — the choke point
    // both the form and a direct POST to /api/auth/callback/credentials pass
    // through (lib/auth/login-throttle.ts).
    for (let i = 0; i < 5; i++) limiters.credentials.consume(OFFICE_IP);

    const attempt = (await loginAction({ email: "ayesha@nimbus.app", password: STRONG })) as Result;
    expect(
      attempt.success,
      "Five credential checks had already been spent from this address, so the next " +
        "sign-in cannot succeed — authorize() will refuse it and return null, which " +
        "the form renders as 'Invalid email or password'. The form must read the bucket " +
        "that actually governs it and say what is true."
    ).toBe(false);
    expect(attempt.error ?? "").toMatch(/Too many requests/);
    expect(H.signIn, "the form called signIn() with no attempts left").not.toHaveBeenCalled();
  });

  it("does not spend a credential attempt of its own (the 5/min must not become 2/min)", async () => {
    // A REGRESSION GUARD, and it passes before and after this change by design:
    // it exists to catch the one wrong wiring that would look identical in a
    // diff. loginAction -> signIn() -> authorize() is ONE user action crossing
    // two layers. If the form consumed as well as authorize(), one submission
    // would spend two entries and the advertised five attempts a minute would
    // silently be two — a founder with three typos locked out of their product.
    for (let i = 0; i < 4; i++) {
      await loginAction({ email: "ayesha@nimbus.app", password: STRONG });
    }
    for (let i = 0; i < 5; i++) {
      expect(
        limiters.credentials.consume(OFFICE_IP).allowed,
        `credential check ${i + 1} of 5 was refused after four sign-in form posts; the ` +
          "form is double-counting"
      ).toBe(true);
    }
    expect(limiters.credentials.consume(OFFICE_IP).allowed).toBe(false);
  });

  it("does not stop a colleague asking for a password-reset link", async () => {
    for (let i = 0; i < 5; i++) {
      await loginAction({ email: "ayesha@nimbus.app", password: STRONG });
    }

    const asked = (await requestPasswordResetAction({ email: "bilal@nimbus.app" })) as Result;
    expect(asked.success).toBe(true);
    expect(
      H.outbox.length,
      "Five ordinary sign-ins from the office consumed the shared bucket, so the " +
        "person who was actually locked out got no reset e-mail at all — and, because " +
        "this endpoint is enumeration-safe, no error either."
    ).toBe(1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════ */
describe("signup survives a team onboarding together", () => {
  it("lets ten people behind one office connection create their workspaces", async () => {
    for (let i = 0; i < 10; i++) {
      const made = (await signupAction(signupInput(i))) as Result;
      expect(made.success, `signup ${i + 1} of 10 was refused: ${made.error}`).toBe(true);
    }
  });

  it("cannot be locked out by a client posting unparseable forms", async () => {
    // The gate now sits BELOW the zod parse, because the bucket is keyed on the
    // submitted address and that only exists once the input is parsed. Safe:
    // safeParse is pure, allocates nothing and touches no database, so an
    // unparseable flood still costs nothing — and it can no longer spend a
    // real person's signup budget.
    for (let i = 0; i < 25; i++) {
      const junk = (await signupAction({ email: "not-an-email" })) as Result;
      expect(junk.success).toBe(false);
      expect(
        refused(junk),
        `garbage post ${i + 1} of 25 was answered with the rate-limit error, so it had ` +
          "spent a slot that belongs to a real signup"
      ).toBe(false);
    }

    const real = (await signupAction(signupInput(99))) as Result;
    expect(
      real.success,
      "A real founder could not sign up because something had been POSTing empty forms."
    ).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════ */
describe("password reset", () => {
  it("keeps one person's reset requests out of a colleague's way", async () => {
    for (let i = 0; i < 5; i++) {
      const asked = (await requestPasswordResetAction({ email: "ayesha@nimbus.app" })) as Result;
      expect(asked.success, `request ${i + 1} of 5 was refused: ${asked.error}`).toBe(true);
    }
    expect(
      refused((await requestPasswordResetAction({ email: "ayesha@nimbus.app" })) as Result),
      "a sixth reset e-mail to the same address in ten minutes should still be refused"
    ).toBe(true);

    const bilal = (await requestPasswordResetAction({ email: "bilal@nimbus.app" })) as Result;
    expect(bilal.success).toBe(true);
    expect(
      H.outbox[H.outbox.length - 1].to,
      "Bilal, locked out and asking for a reset link for the first time, got nothing " +
        "because Ayesha had asked five times from the same office connection."
    ).toBe("bilal@nimbus.app");
  });

  it("spends the same budget whether the address is registered or not", async () => {
    // Anti-enumeration guard, also expected to pass before and after: the key
    // must be the SUBMITTED address, never the looked-up user, or the number of
    // requests allowed becomes an oracle for "is this address registered".
    let registered = 0;
    while (((await requestPasswordResetAction({ email: "ayesha@nimbus.app" })) as Result).success) {
      registered++;
      if (registered > 20) break;
    }
    resetAuthGates();
    let unknown = 0;
    while (((await requestPasswordResetAction({ email: "nobody@nimbus.app" })) as Result).success) {
      unknown++;
      if (unknown > 20) break;
    }
    expect(
      unknown,
      "the allowance differs, so the endpoint answers 'does this account exist'"
    ).toBe(registered);
  });

  it("puts a link in the e-mail that resolves, with no doubled slash", async () => {
    const asked = (await requestPasswordResetAction({ email: "ayesha@nimbus.app" })) as Result;
    expect(asked.success).toBe(true);
    const mail = H.outbox[0];
    expect(mail.to).toBe("ayesha@nimbus.app");
    const expected = ENV.host + "/reset-password?token=";
    expect(
      mail.text.indexOf(expected) >= 0,
      "the reset link in the e-mail body is not " + expected + "… — it is: " + mail.text
    ).toBe(true);
    expect(
      mail.text.indexOf(ENV.host + "//") >= 0,
      "the reset link has a doubled slash, which is the URL that works in one mail " +
        "client and 404s in the next, in front of someone who cannot sign in"
    ).toBe(false);
    expect(mail.html.indexOf(ENV.host + "//") >= 0).toBe(false);
  });

  it("does not refuse a reset link that is clicked a few times", async () => {
    // Redeeming a signed token is loose on purpose: the protection is
    // cryptographic, and the cost of a refusal is telling a customer their
    // perfectly good link is 'too many requests'.
    for (let i = 0; i < 8; i++) {
      const used = (await resetPasswordAction({ token: TOKEN, password: STRONG })) as Result;
      expect(refused(used), `redemption ${i + 1} of 8 was rate-limited: ${used.error}`).toBe(false);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════ */
describe("email change", () => {
  it("mails a confirm link and a warning link that both resolve", async () => {
    H.passwordOk.value = true;
    const started = (await requestEmailChangeAction({
      newEmail: "ayesha@new.app",
      password: STRONG,
    })) as Result;
    expect(started.success, "the change request failed: " + started.error).toBe(true);

    const confirm = H.outbox.filter((m) => m.to === "ayesha@new.app")[0];
    expect(confirm, "no confirmation e-mail was sent to the new address").toBeTruthy();
    expect(
      confirm.text.indexOf(ENV.host + "/verify-email-change?token=") >= 0,
      "the confirm link is not " +
        ENV.host +
        "/verify-email-change?token=… — it is: " +
        confirm.text
    ).toBe(true);
    expect(
      confirm.text.indexOf(ENV.host + "//") >= 0,
      "doubled slash in the one link that completes an e-mail change"
    ).toBe(false);

    const warning = H.outbox.filter((m) => m.to === "ayesha@nimbus.app")[0];
    expect(warning, "no warning e-mail was sent to the address being replaced").toBeTruthy();
    expect(
      warning.text.indexOf(ENV.host + "//") >= 0,
      "doubled slash in the links the owner is told to use to STOP an unwanted change"
    ).toBe(false);
    expect(warning.text.indexOf(ENV.host + "/settings") >= 0).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════ */
describe("closing your own account", () => {
  it("lets each person in the office delete their own account", async () => {
    // Wrong password five times: the action is reached (it answers about the
    // password) and the per-USER budget is what eventually stops it.
    for (let i = 0; i < 5; i++) {
      const tried = (await deleteAccountAction({ password: "wrong" })) as Result;
      expect(tried.error, `attempt ${i + 1} of 5`).toBe("Password doesn't match");
    }
    expect(
      refused((await deleteAccountAction({ password: "wrong" })) as Result),
      "a hijacked session should still get only five password guesses"
    ).toBe(true);

    H.session.value = sessionFor("u_bilal", "member");
    const bilal = (await deleteAccountAction({ password: "wrong" })) as Result;
    expect(
      bilal.error,
      "Bilal could not even reach the password prompt on his own account, because " +
        "Ayesha had mistyped hers five times from the same office connection."
    ).toBe("Password doesn't match");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════ */
describe("invite links (the origin, trimmed as well as un-slashed)", () => {
  it("builds an invite URL with no stray whitespace or doubled slash", async () => {
    // A value pasted into Vercel's env UI with a trailing space AND a trailing
    // slash. team.ts stripped `/$` only, which does not match when the string
    // ends in a space — so the href in the invite e-mail began with a space and
    // carried ' /' in the middle of it.
    process.env.NEXT_PUBLIC_APP_URL = " https://app.founderflow.com/ ";

    const resent = (await resendInviteAction("inv_zara")) as Result & {
      data?: { inviteUrl: string };
    };
    expect(resent.success, "resend failed: " + resent.error).toBe(true);
    const url = resent.data?.inviteUrl ?? "";
    expect(
      url.indexOf(ENV.host + "/invite/") === 0,
      "the invite URL is not " + ENV.host + "/invite/… — it is: '" + url + "'"
    ).toBe(true);
    expect(url.indexOf(" ") >= 0, "the invite URL contains a space: '" + url + "'").toBe(false);
    expect(url.indexOf(ENV.host + "//") >= 0, "doubled slash in the invite URL").toBe(false);
  });
});
