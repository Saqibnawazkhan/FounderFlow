/**
 * i18n-002, second half: the pre-paint script has to be able to LEARN the
 * locale, not just read one.
 *
 * WHAT WAS SHIPPED AND UNREACHABLE. `shellBootstrap` in app/layout.tsx now
 * falls back to `document.cookie` when localStorage is empty, which is exactly
 * the new-device / private-window / cleared-storage case the bug is about.
 * Nothing in the product ever wrote `ff_locale` or `ff_theme`, so that branch
 * could only ever read `null` and fall through to en/ltr — the same first paint
 * as before the fix, followed by the same post-hydration flip of the whole
 * document once PreferenceHydrator finished its round-trip. A complete, tested,
 * commented fix reached by nothing: this repo's most productive defect shape.
 *
 * So these tests are written in the user's terms, at the four moments the
 * server knows something the browser does not:
 *
 *   - signing in on a new device leaves a locale cookie the pre-paint script
 *     can read (the whole finding);
 *   - signing up leaves one too, so the cookie exists from the first session
 *     rather than appearing only after a re-login;
 *   - changing the preference updates it, with the value NOT submitted carried
 *     over from the row (the form sends one field at a time);
 *   - signing out removes it, so the next person on a shared browser does not
 *     paint in the previous user's language.
 *
 * THE LAST TEST IS THE REACHABILITY ONE. Everything above proves a cookie is
 * written; only `readCookie('…')` in app/layout.tsx decides whether anything
 * reads it. That test parses the names out of the real head script and compares
 * them to the names written here, so renaming either side fails rather than
 * silently re-opening the finding.
 *
 * WHY THE ACTIONS ARE DRIVEN, NOT THE WRITER. A unit test of
 * `writeAppearanceCookies` would have passed on the broken tree — the writer is
 * not what was missing. tests/lib/appearance/cookie-options.test.ts covers the
 * writer's own decisions; this file covers the call sites.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/* ─────────────────────────────────────────────────────────────────────────── */
/* Fakes                                                                       */
/* ─────────────────────────────────────────────────────────────────────────── */

/**
 * `vi.mock` factories are hoisted above the imports, so everything they close
 * over is built in `vi.hoisted` — a module-scope `const` is still undefined
 * when the factory runs, and that failure reads as the action calling a method
 * on undefined rather than as a test-setup mistake.
 */
const jar = vi.hoisted(() => {
  type SetCall = { name: string; value: string; options: Record<string, unknown> };
  const sets: SetCall[] = [];
  const deletes: string[] = [];
  /** Flipped by one test: a cookie write must never cost someone their login. */
  const failOnWrite = { value: false };

  const store = {
    set: (a: unknown, b?: unknown, c?: unknown) => {
      if (failOnWrite.value) throw new Error("Cookies can only be modified in a Server Action");
      // Accept both call shapes Next allows: set(name, value, options) and
      // set({ name, value, ...options }). Asserting on one shape only would
      // make this file pass or fail on a style choice.
      if (typeof a === "object" && a !== null) {
        const o = { ...(a as Record<string, unknown>) };
        const name = String(o.name);
        const value = String(o.value);
        delete o.name;
        delete o.value;
        sets.push({ name, value, options: o });
        return;
      }
      sets.push({
        name: String(a),
        value: String(b),
        options: { ...((c as Record<string, unknown>) ?? {}) },
      });
    },
    delete: (a: unknown) => {
      if (typeof a === "object" && a !== null) {
        deletes.push(String((a as Record<string, unknown>).name));
        return;
      }
      deletes.push(String(a));
    },
    get: () => undefined,
  };

  return { sets, deletes, failOnWrite, store };
});

const H = vi.hoisted(() => {
  type Call = { path: string; args: Record<string, unknown> };
  const calls: Call[] = [];
  /** "model.op" → value to resolve with (or a function of the args). */
  const results = new Map<string, unknown>();

  const MODELS = ["user", "company", "activity", "project", "channel", "channelMember"];
  const OPS = ["findUnique", "findFirst", "findMany", "create", "createMany", "update", "count"];

  const db: Record<string, Record<string, (args: Record<string, unknown>) => Promise<unknown>>> &
    Record<string, unknown> = {};

  MODELS.forEach((model) => {
    const ops: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {};
    OPS.forEach((op) => {
      ops[op] = (args: Record<string, unknown>) => {
        const key = model + "." + op;
        calls.push({ path: key, args: args ?? {} });
        const stub = results.has(key) ? results.get(key) : undefined;
        const value = typeof stub === "function" ? (stub as (a: unknown) => unknown)(args) : stub;
        if (value instanceof Error) return Promise.reject(value);
        if (value !== undefined) return Promise.resolve(value);
        if (op === "findUnique" || op === "findFirst") return Promise.resolve(null);
        if (op === "findMany") return Promise.resolve([]);
        if (op === "count") return Promise.resolve(0);
        if (op === "createMany") return Promise.resolve({ count: 0 });
        return Promise.resolve({ id: model + "_new" });
      };
    });
    db[model] = ops;
  });

  (db as unknown as Record<string, unknown>).$transaction = async (
    fn: (tx: unknown) => Promise<unknown>
  ) => fn(db);

  return { calls, results, db };
});

const authMod = vi.hoisted(() => ({
  auth: vi.fn(() => Promise.resolve({ user: { id: "u_ayesha", companyId: "c_nimbus" } })),
  signIn: vi.fn(() => Promise.resolve(undefined)),
  signOut: vi.fn(() => Promise.resolve(undefined)),
}));
const sentry = vi.hoisted(() => ({ captureServerError: vi.fn() }));

vi.mock("next/headers", () => ({ cookies: () => jar.store }));
vi.mock("@/lib/db", () => ({ db: H.db }));
vi.mock("@/lib/auth", () => authMod);
// The real `AuthError` drags the whole next-auth entry point into a jsdom run
// for one `instanceof`; this is the only shape the action inspects.
vi.mock("next-auth", () => ({ AuthError: class AuthError extends Error {} }));
vi.mock("@/lib/sentry-server", () => ({ captureServerError: sentry.captureServerError }));
vi.mock("@/lib/email/verification", () => ({
  sendVerificationEmail: vi.fn(() => Promise.resolve(undefined)),
}));
// Spread the real module so a NEW export cannot silently break this file — a
// factory mock REPLACES the module, so an omitted export is simply absent.
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  limiters: { auth: { consume: () => ({ allowed: true }) } },
  gateAuthAction: () => ({ allowed: true }),
}));
vi.mock("@/lib/client-ip", () => ({ getClientIp: () => Promise.resolve("203.0.113.7") }));
// bcrypt at cost 12 is ~300ms a call and nothing here asserts on a hash.
vi.mock("bcryptjs", () => ({
  default: { hash: () => Promise.resolve("bcrypt$hash"), compare: () => Promise.resolve(true) },
}));

import { loginAction, logoutAction, signupAction } from "@/lib/actions/auth";
import { updateAppearanceAction } from "@/lib/actions/appearance";
import { AuthError } from "next-auth";

const LOCALE_COOKIE = "ff_locale";
const THEME_COOKIE = "ff_theme";
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

const LOGIN = { email: "ayesha@nimbus.app", password: "Str0ng-Passw0rd!" };
const SIGNUP = {
  name: "Ayesha Khan",
  email: "ayesha@nimbus.app",
  password: "Str0ng-Passw0rd!",
  companyName: "Nimbus Labs",
  industry: "SaaS",
  currency: "PKR",
};

function cookieSet(name: string) {
  return jar.sets.filter((c) => c.name === name).pop();
}

beforeEach(() => {
  jar.sets.length = 0;
  jar.deletes.length = 0;
  jar.failOnWrite.value = false;
  H.calls.length = 0;
  H.results.clear();
  authMod.auth.mockClear();
  authMod.signIn.mockClear();
  authMod.signIn.mockImplementation(() => Promise.resolve(undefined));
  authMod.signOut.mockClear();
  authMod.signOut.mockImplementation(() => Promise.resolve(undefined));
  sentry.captureServerError.mockClear();
  H.results.set("company.create", { id: "c_nimbus" });
  H.results.set("user.create", { id: "u_ayesha" });
});

/* ─────────────────────────────────────────────────────────────────────────── */
/* Signing in on a new device                                                  */
/* ─────────────────────────────────────────────────────────────────────────── */

describe("loginAction — the only moment a new device can learn the account's locale", () => {
  it("leaves a locale cookie the pre-paint script can read", async () => {
    // An Urdu user, on a phone that has never seen this app: localStorage is
    // empty, so the head script's only possible source is this cookie.
    H.results.set("user.findFirst", { theme: "light", locale: "ur" });

    const result = await loginAction(LOGIN);

    expect(result.success).toBe(true);
    const locale = cookieSet(LOCALE_COOKIE);
    expect(
      locale,
      "signing in wrote no ff_locale cookie, so shellBootstrap in app/layout.tsx " +
        "reads null on a new device and paints English left-to-right before flipping"
    ).toBeTruthy();
    expect(locale?.value).toBe("ur");
  });

  it("leaves the theme cookie too, so the first paint is not the wrong colour", async () => {
    H.results.set("user.findFirst", { theme: "light", locale: "ur" });
    await loginAction(LOGIN);
    expect(cookieSet(THEME_COOKIE)?.value).toBe("light");
  });

  it("makes both cookies readable by an inline <head> script, on every route, for a year", async () => {
    H.results.set("user.findFirst", { theme: "light", locale: "ur" });
    await loginAction(LOGIN);

    for (const name of [LOCALE_COOKIE, THEME_COOKIE]) {
      const cookie = cookieSet(name);
      expect(cookie, `${name} was not written`).toBeTruthy();
      const options = cookie!.options;
      // The whole point is that a script in <head> can read it. HttpOnly would
      // make the cookie invisible to `document.cookie` and the fix inert again.
      expect(options.httpOnly, `${name} must not be HttpOnly — the head script reads it`).toBe(
        false
      );
      // `/` or the cookie is missing on exactly the routes that matter.
      expect(options.path).toBe("/");
      // A preference that expires is a preference that stops pre-painting.
      expect(options.maxAge).toBe(ONE_YEAR_SECONDS);
      // Lax, not None: nothing cross-site needs it, and None would require Secure.
      expect(options.sameSite).toBe("lax");
    }
  });

  it("reads the row the way authorize() does, so a tombstoned account leaks nothing", async () => {
    await loginAction({ ...LOGIN, email: "Ayesha@Nimbus.app" });
    const read = H.calls.filter((c) => c.path === "user.findFirst").pop();
    expect(read, "loginAction must look the row up to learn the locale").toBeTruthy();
    const where = read!.args.where as Record<string, unknown>;
    expect(where.email).toBe("ayesha@nimbus.app");
    expect(where.deletedAt).toBeNull();
  });

  it("writes nothing when the credentials are refused", async () => {
    authMod.signIn.mockImplementation(() => Promise.reject(new AuthError("CredentialsSignin")));
    const result = await loginAction(LOGIN);
    expect(result.success).toBe(false);
    expect(jar.sets).toEqual([]);
  });

  it("still signs the user in when the cookie write fails", async () => {
    // The session cookie is already on the response by this point. Turning a
    // successful sign-in into "Couldn't sign you in right now" over a UI
    // preference would be a far worse bug than the one being fixed.
    H.results.set("user.findFirst", { theme: "light", locale: "ur" });
    jar.failOnWrite.value = true;
    const result = await loginAction(LOGIN);
    expect(result.success).toBe(true);
  });

  it("still signs the user in when the preference lookup fails", async () => {
    H.results.set("user.findFirst", new Error("connection reset"));
    const result = await loginAction(LOGIN);
    expect(result.success).toBe(true);
  });

  it("coerces a row whose column drifted outside the union", async () => {
    // The columns are plain `String`, so the DB is wider than "light"|"dark"
    // and "en"|"ur". Same coercion getMyAppearanceAction already applies.
    H.results.set("user.findFirst", { theme: "solarized", locale: "fr" });
    await loginAction(LOGIN);
    expect(cookieSet(THEME_COOKIE)?.value).toBe("dark");
    expect(cookieSet(LOCALE_COOKIE)?.value).toBe("en");
  });
});

/* ─────────────────────────────────────────────────────────────────────────── */
/* Signing up                                                                  */
/* ─────────────────────────────────────────────────────────────────────────── */

describe("signupAction — the cookie exists from the first session", () => {
  it("writes the new row's defaults rather than waiting for a re-login", async () => {
    const result = await signupAction(SIGNUP);
    expect(result.success).toBe(true);
    // prisma/schema.prisma: theme @default("dark"), locale @default("en").
    // The parity test in cookie-options.test.ts keeps those two in step.
    expect(cookieSet(THEME_COOKIE)?.value).toBe("dark");
    expect(cookieSet(LOCALE_COOKIE)?.value).toBe("en");
  });

  it("writes nothing when the signup fails before a session exists", async () => {
    H.results.set("user.findFirst", { id: "u_live", deletedAt: null });
    const result = await signupAction(SIGNUP);
    expect(result.success).toBe(false);
    expect(jar.sets).toEqual([]);
  });
});

/* ─────────────────────────────────────────────────────────────────────────── */
/* Changing the preference                                                     */
/* ─────────────────────────────────────────────────────────────────────────── */

describe("updateAppearanceAction — one field submitted, two cookies to keep true", () => {
  it("carries over the value that was not submitted", async () => {
    // The topbar language toggle sends `{ locale }` alone. Writing only what was
    // submitted would leave ff_theme stale — or, worse, overwrite it with the
    // coerced default and flip a light-theme user to dark on their next load.
    H.results.set("user.update", { theme: "light", locale: "ur" });

    const result = await updateAppearanceAction({ locale: "ur" });

    expect(result.success).toBe(true);
    expect(cookieSet(LOCALE_COOKIE)?.value).toBe("ur");
    expect(
      cookieSet(THEME_COOKIE)?.value,
      "ff_theme must come from the row, not from the submitted input — `light` " +
        "can only have been read back, and `dark` means it was defaulted"
    ).toBe("light");
  });

  it("writes the cookies for the signed-in user's own row", async () => {
    H.results.set("user.update", { theme: "dark", locale: "en" });
    await updateAppearanceAction({ theme: "dark" });
    const write = H.calls.filter((c) => c.path === "user.update").pop();
    expect((write!.args.where as Record<string, unknown>).id).toBe("u_ayesha");
  });

  it("writes nothing when the save fails", async () => {
    H.results.set("user.update", new Error("connection reset"));
    const result = await updateAppearanceAction({ locale: "ur" });
    expect(result.success).toBe(false);
    expect(jar.sets).toEqual([]);
  });

  it("writes nothing for a caller with no session", async () => {
    authMod.auth.mockImplementation(() => Promise.resolve(null as never));
    const result = await updateAppearanceAction({ locale: "ur" });
    expect(result.success).toBe(false);
    expect(jar.sets).toEqual([]);
  });
});

/* ─────────────────────────────────────────────────────────────────────────── */
/* Signing out — the shared browser                                            */
/* ─────────────────────────────────────────────────────────────────────────── */

describe("logoutAction — the next person on this browser", () => {
  it("removes both cookies", async () => {
    const result = await logoutAction();
    expect(result.success).toBe(true);
    expect(
      jar.deletes.slice().sort(),
      "signing out left ff_locale behind, so the next person to open this " +
        "browser paints in the previous user's language before hydration"
    ).toEqual([THEME_COOKIE, LOCALE_COOKIE].sort());
  });

  it("keeps them when the sign-out itself failed", async () => {
    // signOut throwing means the session cookie was not cleared and the user is
    // still authenticated. Clearing the preference cookies then would mispaint
    // the shell for someone who is still signed in.
    authMod.signOut.mockImplementation(() => Promise.reject(new Error("cookie write failed")));
    const result = await logoutAction();
    expect(result.success).toBe(false);
    expect(jar.deletes).toEqual([]);
  });

  it("still signs the user out when the cookie delete fails", async () => {
    jar.failOnWrite.value = true;
    const result = await logoutAction();
    expect(result.success).toBe(true);
  });
});

/* ─────────────────────────────────────────────────────────────────────────── */
/* Reachability: the names written are the names read pre-paint                 */
/* ─────────────────────────────────────────────────────────────────────────── */

describe("the pre-paint script reads exactly these cookies", () => {
  it("names the same two cookies app/layout.tsx reads", () => {
    const source = readFileSync(join(process.cwd(), "app", "layout.tsx"), "utf8");
    // exec loop, not matchAll: this tsconfig sets no `target`, so tsc defaults
    // to ES5 and `for…of` over an iterator is a TS2802 vitest never sees.
    const pattern = /readCookie\(\s*['"]([A-Za-z0-9_]+)['"]\s*\)/g;
    const read: string[] = [];
    let m = pattern.exec(source);
    while (m !== null) {
      read.push(m[1]!);
      m = pattern.exec(source);
    }
    expect(
      read.length,
      "shellBootstrap no longer calls readCookie — either the cookie fallback " +
        "was removed (i18n-002 is re-opened) or it was renamed, and every " +
        "assertion in this file is now about a cookie nothing reads"
    ).toBeGreaterThan(0);
    expect(read.slice().sort()).toEqual([THEME_COOKIE, LOCALE_COOKIE].sort());
  });
});
