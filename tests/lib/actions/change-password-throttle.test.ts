// @vitest-environment node

/**
 * auth-014 — the change-password form is a CURRENT-PASSWORD ORACLE, and it was
 * priced as an ordinary write.
 *
 * `ChangePasswordSchema` requires `currentPassword`, and the action answers
 * "Current password is incorrect" when bcrypt says no. That makes
 * `changePasswordAction` a verifier for the one secret a borrowed session does
 * NOT already have — someone at an unlocked laptop can read the whole
 * workspace, but they cannot change the login email, close the account, or
 * reuse the credential anywhere else until they know the password.
 *
 * The gate on it was `limiters.write` — 60 per minute, keyed on the user id —
 * above a comment that said "Auth-tier limiter — same envelope as login/signup,
 * treats password change as a sensitive action." Login's envelope is 5/min.
 * So the comment asserted a safety property the code did not implement, which
 * CLAUDE.md records as this project's most expensive recurring defect, and the
 * real number was 3,600 guesses an hour with a clean per-victim budget.
 *
 * WHAT THESE TESTS ASSERT, AND WHY IN THIS SHAPE.
 *
 * `@/lib/rate-limit` IS NOT MOCKED. The buckets here are the real ones and the
 * counts are the counts a person hits, because a structural test ("does this
 * file mention the auth gate?") cannot tell a wired fix from an unwired one —
 * the distinction tests/lib/actions/auth-gate-wiring.test.ts exists for.
 *
 * The first case states the contract as a BOUND rather than an exact number, so
 * it survives a later re-tune of the tier; the second pins today's number; the
 * third pins the property that matters most and is the easiest to lose in a
 * refactor — the guess budget is SHARED with the other password-confirmed
 * actions, so an attacker cannot get five guesses here and another five from
 * the delete-account form.
 *
 * The last two cases are the "did you over-tighten it" half: an honest person
 * still changes their password on the first try (and still gets the session
 * bump, the notice and the sign-out), and a colleague behind the same office
 * connection is never refused because of somebody else's typos.
 *
 * NODE ENVIRONMENT: nothing renders here, and the action reaches bcrypt and
 * zod; jsdom buys nothing and costs a realm.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * `vi.mock` factories hoist above the imports, so anything they close over has
 * to be built in `vi.hoisted` — a plain module-scope `const` is still
 * `undefined` when the factory runs. Same note as
 * tests/lib/actions/account-security-notices.test.ts.
 */
const H = vi.hoisted(() => ({
  session: { value: null as unknown },
  row: {
    id: "u_ayesha",
    name: "Ayesha",
    email: "ayesha@nimbus.app",
    role: "admin",
    companyId: "c_nimbus",
    passwordHash: "bcrypt-hash-on-file",
    sessionVersion: 3,
    deletedAt: null,
  },
  updates: [] as Array<Record<string, unknown>>,
  notices: [] as Array<Record<string, unknown>>,
  signOuts: { count: 0 },
  /** The only string the fake bcrypt accepts. */
  CORRECT: "Correct-Horse1",
}));

vi.mock("@/lib/db", () => ({
  db: {
    user: {
      findUnique: async () => H.row,
      findFirst: async () => H.row,
      update: async (args: Record<string, unknown>) => {
        H.updates.push(args);
        return H.row;
      },
    },
  },
}));
vi.mock("@/lib/auth", () => ({
  auth: async () => H.session.value,
  signOut: async () => {
    H.signOuts.count += 1;
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/sentry-server", () => ({ captureServerError: vi.fn() }));
vi.mock("@/lib/email/templates/security-notice", () => ({
  sendSecurityNotice: async (input: Record<string, unknown>) => {
    H.notices.push(input);
  },
}));
// Work factor 12 would run once per guess below and the hash is never what is
// under test — but WHICH password is accepted is, so this fake still
// discriminates. tests/lib/actions/account-security-notices.test.ts covers the
// real compare.
vi.mock("bcryptjs", () => ({
  default: {
    compare: async (plain: string) => plain === H.CORRECT,
    hash: async () => "new-bcrypt-hash",
  },
}));

import { changePasswordAction, updateProfileAction } from "@/lib/actions/profile";
import { gateAuthAction, limiters, resetAuthGates } from "@/lib/rate-limit";

type Result = { success: boolean; error?: string };

/** The answer that means "your guess reached bcrypt" — i.e. the oracle spoke. */
const ORACLE_ANSWERED = "Current password is incorrect";
const WRONG = "Wrong-Guess1";
const OFFICE_IP = "203.0.113.9";

function signedInAs(id: string): void {
  H.session.value = { user: { id, companyId: "c_nimbus", role: "admin", email: H.row.email } };
}

/** One submission of the change-password form. */
async function guess(currentPassword: string): Promise<Result> {
  return (await changePasswordAction({
    currentPassword,
    newPassword: "Brand-New-Pass1",
    confirmPassword: "Brand-New-Pass1",
  })) as Result;
}

function refused(r: Result): boolean {
  return r.success === false && /Too many requests/.test(r.error ?? "");
}

beforeEach(() => {
  resetAuthGates();
  limiters.write.reset();
  limiters.read.reset();
  H.updates.length = 0;
  H.notices.length = 0;
  H.signOuts.count = 0;
  signedInAs("u_ayesha");
});

/* ═══════════════════════════════════════════════════════════════════════════ */
describe("a borrowed session guessing the current password", () => {
  it("cannot extract more than ten answers from the form in one minute", async () => {
    let answered = 0;
    let refusal = "";
    // 60 is the old ceiling; stop early the moment the limiter speaks.
    for (let i = 0; i < 60; i++) {
      const r = await guess(WRONG);
      if (r.error === ORACLE_ANSWERED) {
        answered += 1;
        continue;
      }
      refusal = r.error ?? "";
      break;
    }

    expect(
      answered,
      "the change-password form told a borrowed session whether its guess was " +
        "right " +
        answered +
        " times in a row. This endpoint verifies the one secret the attacker " +
        "does not have; it must be priced like login, not like saving a task."
    ).toBeLessThanOrEqual(10);
    expect(
      refusal,
      "the form never refused at all within 60 submissions — there is no " +
        "brute-force ceiling on the current-password check"
    ).toMatch(/Too many requests/);
  });

  it("stops after five — the budget the delete-account form already gives", async () => {
    for (let i = 0; i < 5; i++) {
      const r = await guess(WRONG);
      expect(r.error, "guess " + (i + 1) + " of 5 should still reach the password check").toBe(
        ORACLE_ANSWERED
      );
    }
    expect(
      refused(await guess(WRONG)),
      "a hijacked session should get only five current-password guesses per " +
        "10 minutes here, exactly as it does on deleteAccountAction"
    ).toBe(true);
  });

  it("spends ONE budget across every action that asks for the current password", async () => {
    for (let i = 0; i < 5; i++) await guess(WRONG);

    // If change-password had its own private bucket, the attacker would simply
    // move to the delete-account form and get five more answers about the same
    // password. The budget has to belong to the CAPABILITY (verifying the
    // credential), not to the endpoint.
    const destructive = gateAuthAction({
      kind: "destructive",
      ip: OFFICE_IP,
      userId: "u_ayesha",
    });
    expect(
      destructive.allowed,
      "five guesses were already spent on the change-password form, yet the " +
        "delete-account gate still had a full budget — so the real guess rate " +
        "is the sum of every password-confirmed endpoint, not the tier's number"
    ).toBe(false);
  });

  it("leaves the 60/min write budget alone, so a task save still goes through", async () => {
    for (let i = 0; i < 5; i++) await guess(WRONG);

    // lib/rate-limit.ts's own rule, stated at the `read`/`write` split: a
    // rejection must land on the action that caused it. Password guesses that
    // erode the write budget surface later as "saving sometimes fails when I'm
    // busy", on a different screen, and never reproduce on a quiet account.
    expect(
      limiters.write.check("u_ayesha").remaining,
      "password guesses are being charged to the general write budget"
    ).toBe(60);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════ */
describe("the honest user, who must not pay for this", () => {
  it("changes their password on the first try, and is signed out of everything", async () => {
    const ok = await guess(H.CORRECT);
    expect(ok.success, "an honest change was refused: " + ok.error).toBe(true);

    expect(H.updates.length, "the new hash was not written").toBe(1);
    expect(
      H.updates[0].data as Record<string, unknown>,
      "the sessionVersion bump must ride in the same UPDATE as the hash"
    ).toMatchObject({ passwordHash: "new-bcrypt-hash", sessionVersion: { increment: 1 } });
    expect(H.notices.length, "the address on file was not told its credential moved").toBe(1);
    expect(H.signOuts.count, "the caller's own cookie was not cleared").toBe(1);
  });

  it("never refuses a colleague because of somebody else's typos", async () => {
    // Six submissions from Ayesha: five answered, the sixth refused.
    for (let i = 0; i < 6; i++) await guess(WRONG);

    signedInAs("u_bilal");
    const bilal = await guess(WRONG);
    expect(
      bilal.error,
      "Bilal could not reach the password prompt on his own account because " +
        "Ayesha had mistyped hers. The budget is keyed on the account, and a " +
        "session-bound action always knows which account it is."
    ).toBe(ORACLE_ANSWERED);
  });

  it("still lets a name change run on the ordinary write budget", async () => {
    // The sibling action in the same file is a genuine write and keeps the
    // write tier. Renaming yourself must not cost a password-guess entry, and
    // guessing must not cost a rename.
    signedInAs("u_ayesha");
    const renamed = (await updateProfileAction({ name: "Ayesha K." })) as Result;
    expect(renamed.success, "renaming failed: " + renamed.error).toBe(true);
    expect(limiters.write.check("u_ayesha").remaining).toBe(59);
    expect(
      gateAuthAction({ kind: "destructive", ip: OFFICE_IP, userId: "u_ayesha" }).allowed,
      "a display-name change spent a current-password-guess entry"
    ).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════ */
describe("the comment and the code (the defect class, not the instance)", () => {
  /**
   * The bug was not the number. The bug was a comment claiming the auth
   * envelope over a call to the write tier, which is what let it survive
   * review. Source-level assertion, in the style of
   * tests/lib/cron/purge-invariants and tests/security/script-safety: the body
   * of changePasswordAction may not reach for `limiters.write` again, whatever
   * the comment above it says.
   */
  it("does not reintroduce limiters.write inside changePasswordAction", () => {
    const src = readFileSync(path.join(process.cwd(), "lib", "actions", "profile.ts"), "utf8");
    const start = src.indexOf("export async function changePasswordAction");
    expect(start, "changePasswordAction is gone from lib/actions/profile.ts").toBeGreaterThan(-1);
    const after = src.indexOf("\nexport async function", start + 1);
    const body = after === -1 ? src.slice(start) : src.slice(start, after);

    /**
     * COMMENTS STRIPPED FIRST, and the first draft of this test did not do it —
     * so it went on failing after the fix landed, because the fix's own comment
     * explains what `limiters.write` used to be. A guard against a lying comment
     * that reads the comment is the same mistake one level up. `//` to
     * end-of-line and `/* … *\/` both go; no string literal in this function
     * contains either, and a `matchAll`/named-group version of this would pass
     * vitest and fail typecheck (tsconfig has no `target`, so ES5).
     */
    const code = body.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, "");

    expect(
      code.indexOf("limiters.write") === -1,
      "changePasswordAction is gated on limiters.write (60/min) again"
    ).toBe(true);
    expect(
      code.indexOf("gateAuthAction") !== -1,
      "changePasswordAction no longer goes through the auth-family gate"
    ).toBe(true);
  });
});
