// @vitest-environment node
/**
 * auth-008 — THE INVITE SURFACE IS THE ONE PRE-AUTH ENDPOINT WITH NO VALVE.
 *
 * WHAT THIS IS *NOT* ABOUT. The original finding called this a brute-force hole
 * on a "128-character" token. It is neither. The token is two UUIDv4s with the
 * dashes stripped, where `inviteUserAction` mints it — 64 hex characters carrying ~244
 * bits of real entropy — so no attempt rate makes guessing it feasible, and
 * writing the fix up as anti-guessing is how the next reader over-builds it.
 * The "no sign-in required" half is deliberate and ratified elsewhere: the
 * invitee has no account yet, the token IS the credential, and
 * tests/lib/actions/action-auth-gates.test.ts declares that exemption on
 * purpose.
 *
 * WHAT IT IS ABOUT. The invite surface let an anonymous caller drive an
 * unbounded number of indexed `inviteToken.findUnique` round trips, forever,
 * with no session, from one address. /invite/* is public in auth.config.ts:70
 * and middleware wires only NextAuth, so there was no edge-level valve either.
 * Every sibling redeem endpoint (verify-email, confirm-email-change,
 * reset-password) already meters itself with
 * `gateAuthAction({ kind: "tokenRedeem" })`; this one did not, and the
 * structural sweep passed it on its `token` branch rather than catching it.
 *
 * THE SURFACE IS TWO HALVES, AND THE FIRST FIX CLOSED ONE. This file was
 * originally titled "an anonymous caller cannot drive unbounded database work
 * at /invite" while asserting only the POST — and the GET at
 * `app/invite/[token]/page.tsx` was still running the same unique read on every
 * anonymous request, metered by nothing. A suite that is green while the thing
 * it is named after is still open is worse than no suite, so the describes
 * below now name the half each one covers, and the GET has its own. It is also
 * the half the finding's own detector measures: scripts/qa-auth-and-sessions.mjs
 * probe 9b fires 20 anonymous GETs at /invite/<token> and computes its verdict
 * from those responses alone.
 *
 * SO THE ASSERTION IS ABOUT DATABASE WORK, NOT SECRECY: after the allowance
 * from one trusted address inside a minute — 30 submits, 15 renders — the next
 * one must be refused *without reaching the database at all*. `H.lookups` is
 * the meter for both: it records every token the fake DB was asked about, so a
 * fix that imports the gate and still queries would fail here.
 *
 * AND ONE HONESTY CASE THAT IS NOT ABOUT RATE (acct-016): the collision branch
 * an invitee hits when their address already belongs to a DEACTIVATED account
 * used to tell them to sign in, which is the one thing that cannot work. It is
 * tested here because this file already owns the fake that produces the
 * collision.
 *
 * Companion cases pin the shape of the fix so it cannot drift into damage: the
 * submit valve is 30/min and not 2/min (a real invitee makes exactly one attempt
 * and must never see "Too many requests"), the two halves hold SEPARATE budgets
 * so a render flood can never refuse a submit, and where no proxy supplies a
 * trustworthy address both classes fail OPEN by design — stated here so nobody
 * rediscovers it as a bug, or mistakes the gate for protection on a self-hosted
 * runtime.
 *
 * `@/lib/rate-limit` is deliberately NOT mocked: the buckets and the counts are
 * the real ones a caller would hit. node environment — nothing renders, and
 * team.ts pulls in bcrypt/next-auth shapes that have no business in a DOM.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ReactNode } from "react";

/* ── the fake workspace, and the meter ─────────────────────────────────── */

const H = vi.hoisted(() => {
  /** The client address `getClientIp()` reports for the next call. */
  const ip = { value: "203.0.113.7" };

  /**
   * Every token the database was ASKED about, in order. This is the quantity
   * the finding is about — unmetered DB work — so it is what the assertions
   * read, rather than only the returned message.
   */
  const lookups: string[] = [];

  /** The one token that exists. 64 hex chars, like the real thing. */
  const LIVE_TOKEN = "f0e1d2c3b4a596871234567890abcdef".repeat(2);

  const company = {
    // `name` is here for the PAGE, not the action: the page's
    // `include: { company: true }` returns every column, and it prints this one
    // in the welcome heading. The action selects four columns and never reads
    // it. One fake serves both call shapes.
    name: "Nimbus Labs",
    deletedAt: null as Date | null,
    plan: "team",
    subscriptionStatus: "active",
    currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
  };

  /**
   * When set, `db.user.findUnique` reports an account already using the
   * invitee's address — which makes a LIVE token stop at team.ts's
   * "already exists" branch, well past the gate and short of bcrypt and the
   * transaction. That is how the "a genuine invitee gets through" case proves
   * the gate let it past without needing the whole acceptance to succeed.
   *
   * `collision` is what KIND of holder that account is: a live teammate, or a
   * soft-deleted one (and in which workspace). acct-016 is entirely about
   * telling those apart in the message, so the fake has to be able to be both.
   */
  const emailAlreadyTaken = { value: false };
  const collision = {
    deletedAt: null as Date | null,
    companyId: "c_nimbus",
  };

  /** What `auth()` reports. Only the admin invite path reads it. */
  const session = {
    value: null as null | { user: { id: string; companyId: string; role: string } },
  };

  const db = {
    inviteToken: {
      findUnique: (args: { where: { token: string } }) => {
        lookups.push(args.where.token);
        if (args.where.token !== LIVE_TOKEN) return Promise.resolve(null);
        return Promise.resolve({
          id: "inv_zara",
          companyId: "c_nimbus",
          email: "zara@nimbus.app",
          name: "Zara Khan",
          role: "member",
          token: LIVE_TOKEN,
          usedAt: null as Date | null,
          expiresAt: new Date(Date.now() + 86_400_000),
          invitedBy: "u_ayesha",
          company: { ...company },
        });
      },
      update: () => Promise.resolve({}),
      // The admin invite path clears any still-pending invite for the address
      // before issuing a fresh one. Never reached by the cases below, which all
      // stop at the collision branch — present so the fake cannot 500 instead of
      // asserting.
      deleteMany: () => Promise.resolve({ count: 0 }),
      count: () => Promise.resolve(0),
    },
    user: {
      findUnique: () =>
        Promise.resolve(
          emailAlreadyTaken.value
            ? {
                id: "u_zara",
                email: "zara@nimbus.app",
                name: "Zara Khan",
                deletedAt: collision.deletedAt,
                companyId: collision.companyId,
              }
            : null
        ),
      count: () => Promise.resolve(1),
    },
    company: {
      findUnique: () => Promise.resolve({ id: "c_nimbus", name: "Nimbus Labs", plan: "team" }),
    },
  };

  const captureServerError = vi.fn();

  return {
    ip,
    lookups,
    db,
    captureServerError,
    LIVE_TOKEN,
    company,
    emailAlreadyTaken,
    collision,
    session,
  };
});

/* ── module doubles. `@/lib/rate-limit` stays REAL. ────────────────────── */

vi.mock("@/lib/db", () => ({ db: H.db }));
vi.mock("@/lib/client-ip", () => ({ getClientIp: () => Promise.resolve(H.ip.value) }));
vi.mock("@/lib/auth", () => ({
  // Null by default: the invitee is anonymous, which is the whole point of the
  // POST cases. `H.session.value` is set only by the admin-invite case.
  auth: () => Promise.resolve(H.session.value),
  signIn: () => Promise.resolve(undefined),
}));
vi.mock("@/lib/sentry-server", () => ({ captureServerError: H.captureServerError }));
vi.mock("@/lib/email/send", () => ({
  sendEmail: () => Promise.resolve({ delivered: true, devLogged: false }),
}));
vi.mock("@/lib/chat/bootstrap", () => ({
  joinDefaultChannels: () => Promise.resolve(0),
}));
vi.mock("@/lib/notify/fan-out", () => ({ notifyUsers: () => Promise.resolve(undefined) }));
vi.mock("@/lib/appearance/cookies", () => ({
  DEFAULT_APPEARANCE: { theme: "dark", locale: "en" },
  writeAppearanceCookies: () => Promise.resolve(undefined),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
// The real AuthError drags the whole next-auth entry point in for one
// `instanceof`; this is the only shape the action inspects.
vi.mock("next-auth", () => ({ AuthError: class AuthError extends Error {} }));
// bcrypt at cost 12 is ~300ms a call and nothing here asserts on a hash.
vi.mock("bcryptjs", () => ({
  default: {
    hash: () => Promise.resolve("bcrypt$new"),
    compare: () => Promise.resolve(false),
  },
}));
// ── the two doubles the PAGE needs, and only the page ────────────────────────
// `next/link` reaches for the App Router context it has no business having in a
// node render, and the password form is a client island with its own tests —
// what matters here is whether the page renders it at all, so it is reduced to a
// recognisable stub. Async factories: the module graph is evaluated before a
// factory runs, so `import("react")` inside one is safe where a top-level
// binding closed over by a hoisted factory is not.
vi.mock("next/link", async () => {
  const { createElement } = await import("react");
  return {
    default: ({ children, href }: { children: ReactNode; href: string }) =>
      createElement("a", { href }, children),
  };
});
vi.mock("@/app/invite/[token]/accept-invite-client", async () => {
  const { createElement } = await import("react");
  return {
    AcceptInviteClient: () => createElement("form", { "data-testid": "accept-invite-form" }),
  };
});

import { renderToStaticMarkup } from "react-dom/server";
import { resetAuthGates, UNTRUSTED_CLIENT_IP } from "@/lib/rate-limit";
import { acceptInviteAction, inviteUserAction } from "@/lib/actions/team";
import InvitePage from "@/app/invite/[token]/page";

/* ── fixtures ──────────────────────────────────────────────────────────── */

const OFFICE_IP = "203.0.113.7";
const STRONG = "Str0ng-Passw0rd!";

/** A syntactically fine token that does not exist. One indexed read each. */
function junk(n: number): string {
  return "a".repeat(60) + String(n % 10000).padStart(4, "0");
}

type Result = { success: boolean; error?: string };

/**
 * One anonymous GET of /invite/<token>, rendered exactly as Next renders it:
 * the Server Component is called and the element it returns is turned into the
 * markup the visitor receives. `renderToStaticMarkup` rather than
 * @testing-library/react because this file is a node environment — there is no
 * DOM here, and the assertions are about the text a `curl` would see, which is
 * what the finding's own detector reads (scripts/qa-auth-and-sessions.mjs probe
 * 9b greps the response body).
 */
async function renderInvitePage(token: string): Promise<string> {
  return renderToStaticMarkup(await InvitePage({ params: { token } }));
}

beforeEach(() => {
  resetAuthGates();
  H.lookups.length = 0;
  H.ip.value = OFFICE_IP;
  H.company.deletedAt = null;
  H.emailAlreadyTaken.value = false;
  H.collision.deletedAt = null;
  H.collision.companyId = "c_nimbus";
  H.session.value = null;
  H.captureServerError.mockClear();
});

/* ══════════════════════════════════════════════════════════════════════════ */

describe("the POST cannot drive unbounded database work at /invite", () => {
  it("refuses the 31st attempt from one address WITHOUT querying the database", async () => {
    for (let i = 0; i < 30; i++) {
      const attempt = (await acceptInviteAction({ token: junk(i), password: STRONG })) as Result;
      expect(attempt.success, `attempt ${i + 1} of 30 should still be served`).toBe(false);
      expect(attempt.error, `attempt ${i + 1} of 30 should reach the token check`).toBe(
        "This invite link is invalid"
      );
    }
    expect(H.lookups.length, "the first 30 attempts are the allowance").toBe(30);

    const over = (await acceptInviteAction({ token: junk(30), password: STRONG })) as Result;
    expect(over.success).toBe(false);
    expect(over.error, "the 31st attempt in a minute must be refused, not served").toMatch(
      /Too many requests/
    );
    expect(
      H.lookups.length,
      "a refused attempt must cost no database round trip — that is the whole finding"
    ).toBe(30);
    expect(H.captureServerError, "a throttle is not an error to report").not.toHaveBeenCalled();
  });

  it("does not spend the allowance on a body it never parsed", async () => {
    // The gate runs before the schema parse, exactly as at the three sibling
    // redeem sites, so a malformed body is counted too — and, more to the
    // point, cannot reach the database either.
    const malformed = (await acceptInviteAction({ token: "", password: "x" })) as Result;
    expect(malformed.success).toBe(false);
    expect(H.lookups.length, "an unparseable body must not reach the token lookup").toBe(0);
  });
});

/* ══════════════════════════════════════════════════════════════════════════ */

describe("the GET cannot drive unbounded database work at /invite either", () => {
  // THE HALF THE FIRST auth-008 FIX LEFT OPEN. Metering `acceptInviteAction`
  // closed the POST and nothing else, and the POST is not the surface an
  // attacker would pick: `GET /invite/<token>` needs no Next-Action header and
  // no server-action encoding, runs the SAME indexed unique read (plus a whole
  // RSC render on top), and was unmetered. The finding's own detector measures
  // precisely this — probe 9b fires 20 anonymous GETs and computes its verdict
  // from those responses alone — so a green POST test next to an open GET was a
  // suite agreeing with the bug.

  it("refuses the 16th page render from one address WITHOUT querying the database", async () => {
    for (let i = 0; i < 15; i++) {
      const html = await renderInvitePage(junk(i));
      expect(html, `render ${i + 1} of 15 should still be served`).toContain(
        "This invite link is invalid"
      );
    }
    expect(H.lookups.length, "the first 15 renders are the allowance").toBe(15);

    const over = await renderInvitePage(junk(15));
    expect(over, "the 16th render in a minute must be refused, not served").toMatch(
      /Too many requests/
    );
    expect(
      H.lookups.length,
      "a refused render must cost no database round trip — that is the whole finding"
    ).toBe(15);
  });

  it("tells the holder of a good link to wait, not that their link is broken", async () => {
    // The refusal a real person is most likely to meet is a reload, or a mail
    // client fetching the link for a preview — so the dead-end copy must not be
    // the invalid-link copy. Getting this wrong turns a 60-second valve into
    // "my invite is broken", which is a support ticket and a lost signup.
    for (let i = 0; i < 15; i++) await renderInvitePage(junk(i));

    const over = await renderInvitePage(H.LIVE_TOKEN);
    expect(over, "a throttled render must not call a perfectly good link invalid").not.toContain(
      "This invite link is invalid"
    );
    expect(over, "it has to say what to do about it").toMatch(/reload/i);
    expect(
      over,
      "and it cannot offer a password form it never looked the token up for"
    ).not.toContain("accept-invite-form");
    expect(over, "nor name the workspace — it never queried, so it does not know it").not.toContain(
      "Nimbus Labs"
    );
  });
});

describe("the valve is a courtesy valve, not a lock", () => {
  it("lets a genuine invitee through after 29 junk attempts from the same address", async () => {
    // 30/min/address, so the one attempt a real invitee makes is never refused
    // even behind an office NAT that has been probed all minute. If a fix set
    // this to the login class's 5/min this is the test that objects.
    H.emailAlreadyTaken.value = true;
    for (let i = 0; i < 29; i++) {
      await acceptInviteAction({ token: junk(i), password: STRONG });
    }

    const real = (await acceptInviteAction({ token: H.LIVE_TOKEN, password: STRONG })) as Result;
    expect(real.error, "a real invitee must never be told 'Too many requests'").not.toMatch(
      /Too many requests/
    );
    expect(H.lookups, "and their token must actually be looked up").toContain(H.LIVE_TOKEN);
  });

  it("never lets a flood of page renders refuse a submit", async () => {
    // The property that makes two buckets the right shape rather than one. An
    // invitee who already has the form open and their password typed must be
    // able to submit it while an attacker is hammering the page from the same
    // office NAT — "a rejection must land on the action that caused it", the
    // rule lib/rate-limit.ts states for the read/write split and the auth
    // classes alike. A fix that spent one shared budget would fail here.
    for (let i = 0; i < 25; i++) await renderInvitePage(junk(i));
    const blocked = await renderInvitePage(junk(99));
    expect(blocked, "the page's own allowance really is spent").toMatch(/Too many requests/);

    H.emailAlreadyTaken.value = true;
    const post = (await acceptInviteAction({
      token: H.LIVE_TOKEN,
      password: STRONG,
    })) as Result;
    expect(post.error, "the POST has its own budget and this must not have spent it").not.toMatch(
      /Too many requests/
    );
    expect(H.lookups, "and the submitted token was really looked up").toContain(H.LIVE_TOKEN);
  });

  it("renders uncounted where no proxy supplies a trustworthy address", async () => {
    // The page half of the case below, and the same reasoning: with no trusted
    // address there is no identity to key on, so pooling every visitor into one
    // bucket would let one attacker blank the invite page for everybody. A fix
    // that keyed this bucket on the sentinel — or on the token — fails here.
    H.ip.value = UNTRUSTED_CLIENT_IP;
    for (let i = 0; i < 40; i++) {
      const html = await renderInvitePage(junk(i));
      expect(html).toContain("This invite link is invalid");
    }
    expect(H.lookups.length).toBe(40);
  });

  it("counts nothing where no proxy supplies a trustworthy address", async () => {
    // lib/rate-limit.ts:533 — the tokenRedeem class has no identity to fall
    // back on, so rather than pooling every visitor into one bucket (which
    // would let one attacker refuse everybody's invite) it allows uncounted.
    // Off Vercel, without TRUSTED_PROXY_HEADER, this gate is therefore a no-op.
    // Recorded here so it is a known property rather than a surprise.
    H.ip.value = UNTRUSTED_CLIENT_IP;
    for (let i = 0; i < 40; i++) {
      const attempt = (await acceptInviteAction({ token: junk(i), password: STRONG })) as Result;
      expect(attempt.error).toBe("This invite link is invalid");
    }
    expect(H.lookups.length).toBe(40);
  });
});

/* ══════════════════════════════════════════════════════════════════════════ */

describe("a deactivated account is not described as a live one (acct-016)", () => {
  // THE SAME DISHONESTY acct-016 WAS FILED FOR, in the two places on this
  // surface that still had it. `User.email` carries a plain global unique index
  // and a soft-deleted row keeps its address, so the address of a deactivated
  // teammate is still taken — and both of these lookups answered "an account
  // with this email already exists", which is a sentence about a live account.
  //
  // The remedy is the one lib/actions/email-change.ts uses: read the tombstone
  // in the same query (never `deletedAt: null`, which would miss the row and
  // hand a P2002 to the catch-all) and say WHICH KIND of holder it is.
  //
  // NOT A `deletedAt: null` FILTER, for the reason that file spells out: a
  // deactivated teammate's address must stay reserved or `reactivateUserAction`
  // could not restore them.

  it("tells the invitee their old account was deactivated, not to sign in", async () => {
    // The worse of the two for a customer. An admin deactivates Bob and
    // re-invites the same address; Bob opens the link, sets a password, and is
    // told an account exists and to sign in instead — which is the one thing
    // that cannot work, because authorize() filters `deletedAt: null`. Three
    // closed doors and not one of them named the reason.
    H.emailAlreadyTaken.value = true;
    H.collision.deletedAt = new Date("2026-09-01T00:00:00.000Z");

    const res = (await acceptInviteAction({
      token: H.LIVE_TOKEN,
      password: STRONG,
    })) as Result;

    expect(res.success).toBe(false);
    expect(res.error, "the refusal has to name the real state of the account").toMatch(
      /deactivated/i
    );
    expect(
      res.error,
      "and must not send them to a sign-in that filters `deletedAt: null` and will refuse them"
    ).not.toMatch(/sign(ing)? in/i);
  });

  it("still says what it always said when the address holds a LIVE account", async () => {
    // The guard against over-correcting: a genuine duplicate is unchanged.
    H.emailAlreadyTaken.value = true;
    H.collision.deletedAt = null;

    const res = (await acceptInviteAction({
      token: H.LIVE_TOKEN,
      password: STRONG,
    })) as Result;

    expect(res.error).toBe("An account with this email already exists. Try signing in instead.");
  });

  it("tells an admin re-inviting a deactivated teammate to reactivate them", async () => {
    // The admin half. They can actually fix this: the Team page has a
    // "Deactivated" section with a Reactivate button wired to
    // reactivateUserAction, so the message names the control that exists rather
    // than stating a fact the admin can do nothing with.
    H.session.value = { user: { id: "u_ayesha", companyId: "c_nimbus", role: "admin" } };
    H.emailAlreadyTaken.value = true;
    H.collision.deletedAt = new Date("2026-09-01T00:00:00.000Z");
    H.collision.companyId = "c_nimbus";

    const res = (await inviteUserAction({
      name: "Zara Khan",
      email: "zara@nimbus.app",
      role: "member",
    })) as Result;

    expect(res.success).toBe(false);
    expect(res.error, "name the state").toMatch(/deactivated/i);
    expect(res.error, "and the control that resolves it").toMatch(/reactivate/i);
  });

  it("does not promise an admin a Reactivate button for another workspace's account", async () => {
    // Same tombstone, different company: `reactivateUserAction` refuses a target
    // outside the caller's workspace, so pointing them at the Team page would be
    // a second false instruction. Support is the honest answer here.
    H.session.value = { user: { id: "u_ayesha", companyId: "c_nimbus", role: "admin" } };
    H.emailAlreadyTaken.value = true;
    H.collision.deletedAt = new Date("2026-09-01T00:00:00.000Z");
    H.collision.companyId = "c_elsewhere";

    const res = (await inviteUserAction({
      name: "Zara Khan",
      email: "zara@nimbus.app",
      role: "member",
    })) as Result;

    expect(res.success).toBe(false);
    expect(res.error, "it is deleted, and say so").toMatch(/deleted/i);
    expect(res.error, "with the only route that exists for it").toMatch(/support/i);
    expect(
      res.error,
      "and NOT the team page, where this admin cannot act on that account"
    ).not.toMatch(/reactivate/i);
  });

  it("still refuses a LIVE duplicate to an admin in the same words as before", async () => {
    H.session.value = { user: { id: "u_ayesha", companyId: "c_nimbus", role: "admin" } };
    H.emailAlreadyTaken.value = true;
    H.collision.deletedAt = null;

    const res = (await inviteUserAction({
      name: "Zara Khan",
      email: "zara@nimbus.app",
      role: "member",
    })) as Result;

    expect(res.error).toBe("An account with this email already exists");
  });
});
