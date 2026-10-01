// @vitest-environment node

/**
 * sec-020 — a credential change must leave a durable row, not just an email.
 *
 * THE FINDING. The Activity table is how this product answers "who did that,
 * and when": role changes, invites and deactivations all write one
 * (lib/actions/team.ts). The paths that move a CREDENTIAL wrote nothing at all.
 * So the three questions a customer asks exactly once — after something has
 * gone wrong — had no data behind them:
 *
 *   • "when did my login email change, and from what?"  confirmEmailChangeAction
 *     rewrote `User.email` and returned.
 *   • "did somebody change my password?"                changePasswordAction and
 *     resetPasswordAction both wrote a new hash and returned.
 *
 * WHAT ABOUT THE EMAILS? acct-005 already sends a security notice to the address
 * on file, and `warnOldAddress` already warns the address being replaced. Those
 * are ALERTS: they reach one inbox, once, and a deleted message is gone. An
 * audit trail is a different artefact — it survives, it is ordered, it is
 * queryable, and it is the thing /activities already shows the workspace's
 * administrators. An alert tells you now; a trail lets you reconstruct later.
 * Both are wanted, which is why this file asserts the row and never the mail.
 *
 * WHY THESE ASSERTIONS AND NOT `expect(res.success).toBe(true)`. Every one of
 * these actions already returned success before this change — the credential
 * moved, correctly. A test shaped around the return value passes against the
 * broken code, which is this repo's second most common defect. So every case
 * below asserts on the RECORDED `activity.create` call: its `type`, its
 * `companyId`, whose account it names, and what the message says. And the two
 * negative cases assert the row is ABSENT when the credential did not move,
 * because a trail that logs refusals as changes is worse than no trail.
 *
 * THE CRASH HAZARD, pinned at the bottom. `Activity.type` is a `String` column
 * (prisma/schema.prisma:552) while `app/(app)/activities/activities-client.tsx`
 * indexes `ACTIVITY_META[activity.type]` and dereferences the result with no
 * fallback. A row whose type is not a key of that map therefore crashes
 * /activities for the whole workspace, permanently, because the row persists.
 * TypeScript cannot catch it at the write site — any string satisfies Prisma —
 * so the last describe block reads the two source files and checks that every
 * type these actions actually write is in both the `ActivityType` union and the
 * icon map.
 *
 * NODE ENVIRONMENT: nothing here renders, and the actions reach bcrypt and the
 * real HS256 token modules. jsdom supplies a `TextEncoder` from another realm
 * that jose refuses outright (see tests/lib/actions/email-change.test.ts).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import bcrypt from "bcryptjs";
import { readFileSync } from "node:fs";
import path from "node:path";

/* ─────────────────────────────────────────────────────────────────────────── */
/* Fakes                                                                       */
/* ─────────────────────────────────────────────────────────────────────────── */

/**
 * `vi.mock` factories hoist above the imports, so everything they close over is
 * built in `vi.hoisted` — a plain module-scope `const` is still undefined when
 * the factory runs.
 */
const H = vi.hoisted(() => {
  const calls: Array<{ path: string; args: Record<string, unknown> }> = [];
  const results = new Map<string, unknown>();
  const sent: Array<{ to: string; subject: string; html: string; text?: string }> = [];

  type Op = (args?: Record<string, unknown>) => Promise<unknown>;
  const db: Record<string, Record<string, Op>> = {};
  for (const [model, ops] of [
    ["user", ["findUnique", "findFirst", "update", "count"]],
    ["activity", ["create"]],
  ] as Array<[string, string[]]>) {
    const delegate: Record<string, Op> = {};
    for (const op of ops) {
      const key = `${model}.${op}`;
      delegate[op] = async (args?: Record<string, unknown>) => {
        calls.push({ path: key, args: args ?? {} });
        const canned = results.get(key);
        if (canned instanceof Error) throw canned;
        return typeof canned === "function"
          ? (canned as (a: Record<string, unknown>) => unknown)(args ?? {})
          : canned;
      };
    }
    db[model] = delegate;
  }

  return { db, calls, results, sent, session: { value: null as unknown } };
});

const sentry = vi.hoisted(() => ({ captureServerError: vi.fn() }));

vi.mock("@/lib/db", () => ({ db: H.db }));
vi.mock("@/lib/auth", () => ({
  auth: async () => H.session.value,
  signOut: async () => undefined,
  signIn: async () => undefined,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/client-ip", () => ({ getClientIp: async () => "203.0.113.11" }));
vi.mock("@/lib/sentry-server", () => ({ captureServerError: sentry.captureServerError }));
// Always-open limiters. Every case here shares one IP and one user id, and the
// real buckets are 5-per-window; the ninth test would fail on the throttle
// rather than on what it asserts. The buckets have their own coverage in
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

import { confirmEmailChangeAction } from "@/lib/actions/email-change";
import { changePasswordAction } from "@/lib/actions/profile";
import { resetPasswordAction } from "@/lib/actions/password-reset";
import { emailChangeBinding, signEmailChangeToken } from "@/lib/auth/email-change-token";
import { passwordVersion, signPasswordResetToken } from "@/lib/auth/password-reset-token";

/* ─────────────────────────────────────────────────────────────────────────── */
/* Helpers                                                                     */
/* ─────────────────────────────────────────────────────────────────────────── */

const PASSWORD = "correct-horse-battery";
/** Work factor 4, not 12 — these tests hash repeatedly and never ship. */
const HASH = bcrypt.hashSync(PASSWORD, 4);

const OLD_EMAIL = "founder@nimbus.app";
const NEW_EMAIL = "founder@newdomain.com";
const COMPANY = "c_nimbus";
const USER_ID = "u_ayesha";
const USER_NAME = "Ayesha";

type Row = {
  id: string;
  name: string;
  email: string;
  companyId: string;
  role: string;
  passwordHash: string;
  sessionVersion: number;
  deletedAt: Date | null;
};

function row(over: Partial<Row> = {}): Row {
  return {
    id: USER_ID,
    name: USER_NAME,
    email: OLD_EMAIL,
    companyId: COMPANY,
    role: "admin",
    passwordHash: HASH,
    sessionVersion: 0,
    deletedAt: null,
    ...over,
  };
}

/**
 * The rows the fake database holds, served to whichever single-row read the
 * action reaches for, first match wins. The `where` is honoured — `deletedAt`,
 * `email`, `id` — so a fake that answered anyway would report a pass the real
 * database would not.
 */
function liveRows(rows: Row[]): void {
  const serve = (args: Record<string, unknown>) => {
    const where = (args.where ?? {}) as Record<string, unknown>;
    return (
      rows.find((r) => {
        if ("deletedAt" in where && where.deletedAt === null && r.deletedAt !== null) return false;
        if (typeof where.email === "string" && where.email !== r.email) return false;
        if (typeof where.id === "string" && where.id !== r.id) return false;
        return true;
      }) ?? null
    );
  };
  H.results.set("user.findUnique", serve);
  H.results.set("user.findFirst", serve);
}

function signedIn(id = USER_ID): void {
  H.session.value = { user: { id, companyId: COMPANY, role: "admin", email: OLD_EMAIL } };
}

/** The `data` of every Activity row this run wrote. */
function activityRows(): Array<Record<string, unknown>> {
  return H.calls
    .filter((c) => c.path === "activity.create")
    .map((c) => (c.args.data ?? {}) as Record<string, unknown>);
}

/** The one Activity row this run wrote, or a failure that names what it got. */
function onlyActivityRow(): Record<string, unknown> {
  const rows = activityRows();
  if (rows.length !== 1) {
    throw new Error(
      `expected exactly 1 Activity row, got ${rows.length}` +
        ` (types: ${rows.map((r) => String(r.type)).join(", ") || "none"})`
    );
  }
  return rows[0]!;
}

/** A confirm-email token for the live row, bound the way the action expects. */
async function emailChangeToken(over: Partial<Row> = {}): Promise<string> {
  const r = row(over);
  return signEmailChangeToken(r.id, NEW_EMAIL, emailChangeBinding(r));
}

const STRONG = "Str0ngerPassphrase";

beforeEach(() => {
  process.env.AUTH_SECRET = "test-secret-for-credential-audit-trail";
  process.env.NEXT_PUBLIC_APP_URL = "https://founderflow.test";
  H.calls.length = 0;
  H.results.clear();
  H.sent.length = 0;
  H.session.value = null;
  sentry.captureServerError.mockClear();
  liveRows([row()]);
});

/* ─────────────────────────────────────────────────────────────────────────── */
/* Moving the login address                                                    */
/* ─────────────────────────────────────────────────────────────────────────── */

describe("confirmEmailChangeAction records the change", () => {
  it("writes one Activity row naming both addresses", async () => {
    const token = await emailChangeToken();

    const res = await confirmEmailChangeAction({ token });
    expect(res.success).toBe(true);

    const activity = onlyActivityRow();
    expect(activity.type).toBe("email_changed");
    expect(activity.companyId).toBe(COMPANY);
    expect(activity.userId).toBe(USER_ID);
    expect(activity.userName).toBe(USER_NAME);
    // BOTH addresses, because "the email changed" without the previous value
    // cannot answer the question that gets asked: an owner who has lost the
    // account needs to recognise which address was theirs.
    expect(String(activity.message)).toContain(OLD_EMAIL);
    expect(String(activity.message)).toContain(NEW_EMAIL);
  });

  it("writes nothing when the link is revoked", async () => {
    // Minted against a different password hash, so the binding no longer
    // matches the live row — the change does NOT land, and a trail that records
    // it anyway is a false history.
    const token = await emailChangeToken({ passwordHash: bcrypt.hashSync("other", 4) });

    const res = await confirmEmailChangeAction({ token });
    expect(res.success).toBe(false);
    expect(activityRows()).toEqual([]);
  });

  it("still completes the change when the Activity write fails", async () => {
    // The UPDATE has already landed and cannot be undone. Failing the action
    // here would tell the user their email did not move while it did, and send
    // them to sign in with an address the row no longer holds.
    H.results.set("activity.create", new Error("activity table unavailable"));
    const token = await emailChangeToken();

    const res = await confirmEmailChangeAction({ token });
    expect(res.success).toBe(true);
    expect(sentry.captureServerError).toHaveBeenCalled();
  });
});

/* ─────────────────────────────────────────────────────────────────────────── */
/* Moving the password — both paths                                            */
/* ─────────────────────────────────────────────────────────────────────────── */

describe("changePasswordAction records the change", () => {
  beforeEach(() => signedIn());

  it("writes one Activity row for the account whose password moved", async () => {
    const res = await changePasswordAction({
      currentPassword: PASSWORD,
      newPassword: STRONG,
      confirmPassword: STRONG,
    });
    expect(res.success).toBe(true);

    const activity = onlyActivityRow();
    expect(activity.type).toBe("password_changed");
    expect(activity.companyId).toBe(COMPANY);
    expect(activity.userId).toBe(USER_ID);
    expect(String(activity.message)).toContain(USER_NAME);
  });

  it("never puts the new password in the row", async () => {
    await changePasswordAction({
      currentPassword: PASSWORD,
      newPassword: STRONG,
      confirmPassword: STRONG,
    });

    const activity = onlyActivityRow();
    expect(JSON.stringify(activity)).not.toContain(STRONG);
  });

  it("writes nothing when the current password is wrong", async () => {
    const res = await changePasswordAction({
      currentPassword: "not-the-password",
      newPassword: STRONG,
      confirmPassword: STRONG,
    });
    expect(res.success).toBe(false);
    expect(activityRows()).toEqual([]);
  });

  it("still reports success when the Activity write fails", async () => {
    H.results.set("activity.create", new Error("activity table unavailable"));

    const res = await changePasswordAction({
      currentPassword: PASSWORD,
      newPassword: STRONG,
      confirmPassword: STRONG,
    });
    expect(res.success).toBe(true);
  });
});

describe("resetPasswordAction records the change", () => {
  it("writes one Activity row for the account whose password moved", async () => {
    const token = await signPasswordResetToken(USER_ID, passwordVersion(HASH));

    const res = await resetPasswordAction({ token, password: STRONG, confirmPassword: STRONG });
    expect(res.success).toBe(true);

    const activity = onlyActivityRow();
    expect(activity.type).toBe("password_changed");
    expect(activity.companyId).toBe(COMPANY);
    expect(activity.userId).toBe(USER_ID);
    // The two password paths are different events to an investigator: a reset
    // is reachable by anyone holding the inbox, a change needs the old
    // password. The row has to say which one happened.
    expect(String(activity.message)).toMatch(/reset/i);
  });

  it("writes nothing when the link has already been used", async () => {
    const token = await signPasswordResetToken(USER_ID, passwordVersion("some-older-hash"));

    const res = await resetPasswordAction({ token, password: STRONG, confirmPassword: STRONG });
    expect(res.success).toBe(false);
    expect(activityRows()).toEqual([]);
  });
});

/* ─────────────────────────────────────────────────────────────────────────── */
/* The crash hazard: Activity.type is a String column                          */
/* ─────────────────────────────────────────────────────────────────────────── */

describe("every type these paths write is renderable on /activities", () => {
  const root = process.cwd();

  function read(rel: string): string {
    return readFileSync(path.join(root, rel), "utf8");
  }

  /** The members of the `ActivityType` union in lib/types.ts. */
  function unionMembers(): string[] {
    const src = read("lib/types.ts");
    const start = src.indexOf("export type ActivityType =");
    expect(start, "ActivityType union not found in lib/types.ts").toBeGreaterThan(-1);
    const end = src.indexOf(";", start);
    const body = src.slice(start, end);
    const out: string[] = [];
    // An exec loop, not String.matchAll: tsconfig.json sets no `target`, so it
    // defaults to ES5 and matchAll is a typecheck error vitest does not
    // reproduce (esbuild transpiles it happily).
    const re = /"([a-z_]+)"/g;
    let m = re.exec(body);
    while (m) {
      out.push(m[1]!);
      m = re.exec(body);
    }
    return out;
  }

  /** The keys of `ACTIVITY_META` in the activities client. */
  function metaKeys(): string[] {
    const src = read("app/(app)/activities/activities-client.tsx");
    const start = src.indexOf("const ACTIVITY_META");
    const end = src.indexOf("const TONE_FILL");
    expect(start, "ACTIVITY_META not found").toBeGreaterThan(-1);
    expect(end, "TONE_FILL not found — the slice bound is gone").toBeGreaterThan(start);
    const body = src.slice(start, end);
    const out: string[] = [];
    const re = /([a-z_]+):\s*\{\s*icon:/g;
    let m = re.exec(body);
    while (m) {
      out.push(m[1]!);
      m = re.exec(body);
    }
    return out;
  }

  it("has an icon-map entry for every member of the union", () => {
    const union = unionMembers();
    const meta = metaKeys();
    expect(union.length).toBeGreaterThan(15);
    expect(meta.length).toBe(union.length);
    for (const t of union) {
      expect(meta, `ACTIVITY_META has no entry for "${t}" — /activities would crash`).toContain(t);
    }
  });

  it("covers the three types the credential paths write", async () => {
    const written: string[] = [];

    signedIn();
    await changePasswordAction({
      currentPassword: PASSWORD,
      newPassword: STRONG,
      confirmPassword: STRONG,
    });
    H.session.value = null;
    await confirmEmailChangeAction({ token: await emailChangeToken() });
    await resetPasswordAction({
      token: await signPasswordResetToken(USER_ID, passwordVersion(HASH)),
      password: STRONG,
      confirmPassword: STRONG,
    });
    for (const r of activityRows()) written.push(String(r.type));

    expect(written.length).toBeGreaterThanOrEqual(3);
    const union = unionMembers();
    const meta = metaKeys();
    for (const t of written) {
      expect(union, `"${t}" is written but is not an ActivityType`).toContain(t);
      expect(meta, `"${t}" is written but has no ACTIVITY_META entry`).toContain(t);
    }
  });
});
