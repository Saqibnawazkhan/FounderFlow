/**
 * auth-010 — "forgot password" must not answer "is this address registered",
 * on EITHER channel.
 *
 * The rendered half was closed by prodready-005: /forgot-password shows one
 * panel for every outcome and `tests/components/forgot-password-outcome.test.tsx`
 * pins the two renderings byte-identical. That is the half a human sees. Two
 * other halves reach a machine, and both were open:
 *
 *  1. THE PAYLOAD. A server action's return value is serialised into the POST
 *     response body, which is readable with curl. `requestPasswordResetAction`
 *     returned `{ dispatched: false }` for an unregistered or tombstoned address
 *     and `{ dispatched: result.delivered }` for a live one — i.e. `true` on any
 *     deployment where GMAIL_USER / GMAIL_APP_PASSWORD are set, which CLAUDE.md
 *     lists as required production variables and a production build now refuses
 *     to proceed without. So the careful UI sat on top of a response body that
 *     said it outright. `scripts/qa-auth-and-sessions.mjs:539-560` already
 *     predicted exactly this and only passes today because the box it runs on
 *     has no SMTP.
 *
 *  2. THE CLOCK. The unregistered branch returned after a single indexed
 *     `SELECT`; the registered branch minted a token and then awaited a real
 *     Gmail SMTP round trip inline. Hundreds of milliseconds against tens is a
 *     louder oracle than the flag was, and it survives any amount of care taken
 *     over the response body. A stopwatch is not a harder tool than curl.
 *
 * WHAT IS ASSERTED, AND WHY IT CANNOT BE PASSED VACUOUSLY. The envelope test
 * compares the three outcomes' *serialised* bodies against each other rather
 * than against a literal, so it stays true whatever the envelope becomes and
 * fails the moment the branches diverge again. The clock tests drive a
 * deliberately slow (and then a never-resolving) mail transport, so an
 * implementation that still waits for the send cannot pass them, and they also
 * assert the email is still actually sent — "fixed" by not sending it would be
 * a far worse bug.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/* ─────────────────────────────────────────────────────────────────────────── */
/* Fake Prisma — three addresses: live, tombstoned, never registered            */
/* ─────────────────────────────────────────────────────────────────────────── */

const H = vi.hoisted(() => {
  const LIVE = "ayesha@nimbus.app";
  const TOMBSTONED = "omar@nimbus.app";
  const UNKNOWN = "nobody@nimbus.app";

  const rows = [
    {
      id: "u_ayesha",
      email: LIVE,
      name: "Ayesha",
      passwordHash: "bcrypt$live",
      deletedAt: null as Date | null,
    },
    {
      id: "u_omar",
      email: TOMBSTONED,
      name: "Omar",
      passwordHash: "bcrypt$gone",
      deletedAt: new Date("2026-09-01T10:00:00Z") as Date | null,
    },
  ];

  /** Honours the `where` the action actually sent, including `deletedAt: null`. */
  function findFirst(args: { where?: Record<string, unknown> } | undefined) {
    const where = args?.where ?? {};
    const hit = rows.find((r) => {
      if (where.email !== undefined && where.email !== r.email) return false;
      if (
        Object.prototype.hasOwnProperty.call(where, "deletedAt") &&
        where.deletedAt === null &&
        r.deletedAt !== null
      ) {
        return false;
      }
      return true;
    });
    return Promise.resolve(hit ? { ...hit } : null);
  }

  return {
    LIVE,
    TOMBSTONED,
    UNKNOWN,
    db: { user: { findFirst: (a: never) => findFirst(a) } },
  };
});

const mail = vi.hoisted(() => ({
  sendEmail: vi.fn(() => Promise.resolve({ delivered: true, devLogged: false })),
}));
const sentry = vi.hoisted(() => ({ captureServerError: vi.fn() }));

vi.mock("@/lib/db", () => ({ db: H.db }));
vi.mock("@/lib/email/send", () => ({ sendEmail: mail.sendEmail }));
vi.mock("@/lib/sentry-server", () => ({ captureServerError: sentry.captureServerError }));
vi.mock("@/lib/auth/password-reset-token", () => ({
  passwordVersion: (hash: string) => "pv(" + hash + ")",
  signPasswordResetToken: vi.fn(() => Promise.resolve("signed.reset.token")),
  verifyPasswordResetToken: () => Promise.resolve({ ok: false, reason: "invalid" }),
}));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  // Spread the real module: a factory mock REPLACES it, so an omitted export
  // would be absent rather than wrong, and that has broken suites here before.
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  gateAuthAction: () => ({ allowed: true }),
}));
vi.mock("@/lib/client-ip", () => ({ getClientIp: () => Promise.resolve("203.0.113.7") }));

import { requestPasswordResetAction } from "@/lib/actions/password-reset";

/**
 * The knob the action reads for its uniform-latency floor. The whole suite runs
 * with it at 0 (30+ seconds of sleep otherwise, spread over four files that
 * drive this action in loops); the tests below that are ABOUT the floor set it
 * explicitly, so the behaviour is exercised rather than merely configured away.
 *
 * It is readable ONLY under vitest — production, preview and `npm run dev` get
 * the built-in floor and no environment variable can lower it. That is not
 * incidental: "0" in a production scope is the whole of auth-010 switched off
 * from a dashboard, which is what prodready-002 was. "ignores the floor override
 * outside a test environment" below is the assertion, and
 * tests/lib/env/build-config.test.ts refuses the var in a production build.
 */
const FLOOR_ENV = "PASSWORD_RESET_RESPONSE_FLOOR_MS";
const FLOOR_MS = 150;

/** A transport that takes `ms` before it answers, like a real SMTP handshake. */
function slowTransport(ms: number) {
  mail.sendEmail.mockImplementation(
    () =>
      new Promise((resolve) => setTimeout(() => resolve({ delivered: true, devLogged: false }), ms))
  );
}

async function elapsedFor(email: string): Promise<number> {
  const t0 = Date.now();
  await requestPasswordResetAction({ email });
  return Date.now() - t0;
}

/** The `action` tag of every Sentry event the action has raised so far. */
function reportedActions(): string[] {
  return sentry.captureServerError.mock.calls.map(
    (c) => ((c as unknown[])[1] as { action?: string } | undefined)?.action ?? ""
  );
}

beforeEach(() => {
  mail.sendEmail.mockReset();
  mail.sendEmail.mockImplementation(() => Promise.resolve({ delivered: true, devLogged: false }));
  sentry.captureServerError.mockReset();
});

afterEach(() => {
  delete process.env[FLOOR_ENV];
});

/* ─────────────────────────────────────────────────────────────────────────── */
/* 1. The payload                                                              */
/* ─────────────────────────────────────────────────────────────────────────── */

describe("the reset response body says the same thing about every address", () => {
  it("answers an unknown address, a tombstone and a live account identically", async () => {
    const unknown = await requestPasswordResetAction({ email: H.UNKNOWN });
    const tombstoned = await requestPasswordResetAction({ email: H.TOMBSTONED });
    const live = await requestPasswordResetAction({ email: H.LIVE });

    // Serialised, because that is the form the browser receives. Compared
    // against each other rather than a literal so the assertion outlives any
    // future change to the envelope itself.
    const bodies = [unknown, tombstoned, live].map((r) => JSON.stringify(r));
    expect(
      bodies[1],
      "a tombstoned address gets a different response body than an address that " +
        "was never registered, so the endpoint distinguishes them"
    ).toBe(bodies[0]);
    expect(
      bodies[2],
      "a registered address gets a different response body than an unregistered " +
        "one — the same-screen UI is cosmetic; the POST body is the oracle"
    ).toBe(bodies[0]);

    // What used to sit here was an `Object.keys` comparison across the three
    // results, justified as catching a key whose value is undefined on one
    // branch only (JSON.stringify drops those). It could not fail: all three
    // outcomes are the SAME object, so it compared one key list with itself.
    //
    // That identity is the real mechanism — one shared frozen envelope reached
    // through one exit, so no branch has anything of its own to diverge in — so
    // assert the mechanism rather than a tautology about it. Planted violation:
    // changing the single exit to `return { ...REQUEST_ACCEPTED }` fails the
    // first of these and leaves every other assertion in this file green.
    expect(
      tombstoned,
      "the three outcomes are no longer the one shared envelope. Per-branch literals are " +
        "exactly what drifted before: `{ dispatched: result.delivered }` read like the " +
        "other two until SMTP was configured, and then it answered the question"
    ).toBe(unknown);
    expect(live).toBe(unknown);
    expect(
      Object.isFrozen(live),
      "the shared envelope is not frozen, so one caller can decorate the single instance " +
        "every later caller receives"
    ).toBe(true);
  });

  it("ships no delivery signal at all to the client", async () => {
    const live = JSON.stringify(await requestPasswordResetAction({ email: H.LIVE }));
    expect(
      /dispatch|deliver|sent|exists/i.test(live),
      "the response body still carries a delivery/existence field: " + live
    ).toBe(false);
  });

  it("still actually sends the live account its link", async () => {
    // The cheapest way to make every branch identical would be to stop sending
    // the email. Guard against that "fix".
    await requestPasswordResetAction({ email: H.LIVE });
    expect(mail.sendEmail).toHaveBeenCalledTimes(1);
    const sent = (mail.sendEmail.mock.calls as unknown as unknown[][])[0][0] as {
      to: string;
      text: string;
    };
    expect(sent.to).toBe(H.LIVE);
    expect(sent.text).toContain("signed.reset.token");
  });

  it("sends nothing for a tombstone or an unknown address", async () => {
    await requestPasswordResetAction({ email: H.TOMBSTONED });
    await requestPasswordResetAction({ email: H.UNKNOWN });
    expect(mail.sendEmail).not.toHaveBeenCalled();
  });
});

/* ─────────────────────────────────────────────────────────────────────────── */
/* 2. The clock                                                                */
/* ─────────────────────────────────────────────────────────────────────────── */

describe("and the time it takes to answer says the same thing too", () => {
  it("does not hold the response open for the mail server", async () => {
    // A transport that never answers: a wedged SMTP connection, and also the
    // clearest possible statement of "the response must not depend on this".
    mail.sendEmail.mockImplementation(() => new Promise(() => {}));

    const STUCK = Symbol("still waiting on the mail server");
    const answered = await Promise.race([
      requestPasswordResetAction({ email: H.LIVE }),
      new Promise((resolve) => setTimeout(() => resolve(STUCK), 1000)),
    ]);

    expect(
      answered,
      "the action was still awaiting sendEmail() a second later, so the response " +
        "time is a function of the mail server — and therefore of whether the " +
        "account exists"
    ).not.toBe(STUCK);
  });

  it("answers an unknown address no faster than a registered one", async () => {
    process.env[FLOOR_ENV] = String(FLOOR_MS);
    // Four times the floor, so "it happened to be quick" cannot pass this.
    slowTransport(FLOOR_MS * 4);

    const unknown = await elapsedFor(H.UNKNOWN);
    const live = await elapsedFor(H.LIVE);

    // setTimeout can fire a millisecond early; the tolerance is for the timer,
    // not for the leak.
    expect(
      unknown,
      `an unregistered address answered in ${unknown}ms, under the ${FLOOR_MS}ms floor — ` +
        "a stopwatch separates it from a registered one"
    ).toBeGreaterThanOrEqual(FLOOR_MS - 20);
    expect(
      live,
      `a registered address took ${live}ms against a ${FLOOR_MS * 4}ms transport, so the ` +
        "response is still waiting for the send"
    ).toBeLessThan(FLOOR_MS * 3);
    expect(live).toBeGreaterThanOrEqual(FLOOR_MS - 20);
  });

  it("holds a tombstone to the same floor as everything else", async () => {
    process.env[FLOOR_ENV] = String(FLOOR_MS);
    expect(await elapsedFor(H.TOMBSTONED)).toBeGreaterThanOrEqual(FLOOR_MS - 20);
  });

  it("keeps the answer AND the floor when the send rejects", async () => {
    // `sendEmail` is not awaited, so a rejection has nowhere to land unless the
    // action attaches a handler: an unhandled rejection terminates the Node
    // process by default, taking every request in flight with it. Neither the
    // envelope nor the clock may move on that path either — a registered address
    // whose send fails must not answer faster than an unregistered one.
    //
    // Both calls therefore run under the SAME floor. The version of this test
    // this replaces measured no elapsed time at all and ran its two calls under
    // different floors (150ms, then the override deleted), so the name's claim
    // about "the floor" was not, and could not be, asserted.
    process.env[FLOOR_ENV] = String(FLOOR_MS);
    mail.sendEmail.mockImplementation(() => Promise.reject(new Error("SMTP config is broken")));

    const t0 = Date.now();
    const live = await requestPasswordResetAction({ email: H.LIVE });
    const liveMs = Date.now() - t0;
    const t1 = Date.now();
    const unknown = await requestPasswordResetAction({ email: H.UNKNOWN });
    const unknownMs = Date.now() - t1;

    expect(JSON.stringify(live)).toBe(JSON.stringify(unknown));
    expect(
      liveMs,
      `a registered address whose send rejected answered in ${liveMs}ms, under the ` +
        `${FLOOR_MS}ms floor — a failing mail server would then time-stamp which ` +
        "addresses are registered"
    ).toBeGreaterThanOrEqual(FLOOR_MS - 20);
    expect(
      unknownMs,
      `an unregistered address answered in ${unknownMs}ms, under the ${FLOOR_MS}ms floor`
    ).toBeGreaterThanOrEqual(FLOOR_MS - 20);

    await vi.waitFor(() =>
      expect(
        reportedActions().join(","),
        "the rejected send was swallowed silently — nothing in Sentry says the reset " +
          "e-mail never left"
      ).toContain("requestPasswordResetAction:send")
    );
  });

  it("reports a send that had not finished when the response was returned", async () => {
    // The floor is the ONLY runway an unawaited send gets: on a serverless
    // runtime the instance can be frozen once the response is complete. A
    // handshake that outlives the floor is therefore a reset e-mail that may
    // never have been transmitted, and until this assertion existed that
    // happened silently — `sendEmail` reports what IT sees, and a truncated
    // connection is not something it ever sees.
    process.env[FLOOR_ENV] = String(FLOOR_MS);
    mail.sendEmail.mockImplementation(() => new Promise(() => {}));

    await requestPasswordResetAction({ email: H.LIVE });

    expect(
      reportedActions().join(","),
      "a reset e-mail was still in flight when the response was returned and nothing " +
        "anywhere says so. On Vercel that send may simply be dropped, and password reset " +
        "is the only self-service recovery path in the product."
    ).toContain("requestPasswordResetAction:send-outran-floor");
  });

  it("says nothing when the send finishes inside the floor", async () => {
    // The other half: a warning that fires on every healthy send is a warning
    // somebody mutes, and muting it takes the real signal with it.
    process.env[FLOOR_ENV] = String(FLOOR_MS);
    slowTransport(20);

    await requestPasswordResetAction({ email: H.LIVE });

    expect(
      sentry.captureServerError,
      "a send that completed well inside the floor was reported as at risk"
    ).not.toHaveBeenCalled();
  });

  it("ignores the floor override outside a test environment", async () => {
    // THE KNOB IS A SECURITY SWITCH, and this is prodready-002's shape exactly:
    // `PASSWORD_RESET_RESPONSE_FLOOR_MS=0` in the Vercel Production scope
    // restores the timing oracle this whole file exists to close, silently, with
    // no runtime signal of any kind. Its only purpose is to let the two tests
    // above turn the floor back ON, so it is honoured only under vitest; the
    // production build refuses it as well (tests/lib/env/build-config.test.ts).
    process.env[FLOOR_ENV] = "0";
    vi.stubEnv("VITEST", undefined);
    vi.stubEnv("NODE_ENV", "production");
    try {
      const elapsed = await elapsedFor(H.UNKNOWN);
      // The built-in RESPONSE_FLOOR_MS is 750; the tolerance is for the timer.
      // If you change that constant, change this number with it.
      expect(
        elapsed,
        `the floor was switched off from the environment: the response came back in ` +
          `${elapsed}ms. Any value here reopens auth-010's timing oracle, and 0 reopens ` +
          "it completely."
      ).toBeGreaterThanOrEqual(700);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
