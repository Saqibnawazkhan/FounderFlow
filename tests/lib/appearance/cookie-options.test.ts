/**
 * The appearance cookies' own decisions — the ones that are invisible in the
 * call sites and expensive to get wrong.
 *
 * tests/lib/appearance/session-cookies.test.ts proves the four call sites write
 * them. This file covers the three things that file cannot see:
 *
 *   1. THE ATTRIBUTES. `httpOnly: false` is the load-bearing one and reads like
 *      a mistake, so it is asserted with the reason attached; a future
 *      "harden the cookies" pass that flips it makes the pre-paint fix inert
 *      again, silently, because nothing would 500 — the head script would just
 *      read `null` for ever.
 *   2. THE DEFAULTS MIRROR THE SCHEMA. `signupAction` writes
 *      `DEFAULT_APPEARANCE` rather than re-reading the row it just inserted,
 *      which is only correct while those two literals agree with
 *      `@default(...)` in prisma/schema.prisma. So the schema is parsed and
 *      compared, the way tests/lib/cron/purge-invariants does.
 *   3. THE MODULE STAYS OUT OF THE ENDPOINT SURFACE. The reason this module
 *      exists at all is that `lib/actions/appearance.ts` is `"use server"`,
 *      where every export is a public POST endpoint. A `"use server"` directive
 *      landing at the top of this file would publish `writeAppearanceCookies`
 *      as an unauthenticated endpoint that writes cookies into any visitor's
 *      browser. tests/lib/actions/use-server-exports.test.ts would catch it as
 *      a naming violation; this catches it by name, next to the reason.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const jar = vi.hoisted(() => {
  type SetCall = { name: string; value: string; options: Record<string, unknown> };
  const sets: SetCall[] = [];
  const deletes: Array<Record<string, unknown> | string> = [];
  const failOnWrite = { value: false };

  const store = {
    set: (name: unknown, value: unknown, options?: unknown) => {
      if (failOnWrite.value) throw new Error("Cookies can only be modified in a Server Action");
      sets.push({
        name: String(name),
        value: String(value),
        options: { ...((options as Record<string, unknown>) ?? {}) },
      });
    },
    delete: (arg: unknown) => {
      if (failOnWrite.value) throw new Error("Cookies can only be modified in a Server Action");
      deletes.push(arg as Record<string, unknown> | string);
    },
    get: () => undefined,
  };

  return { sets, deletes, failOnWrite, store };
});

const sentry = vi.hoisted(() => ({ captureServerError: vi.fn() }));

vi.mock("next/headers", () => ({ cookies: () => jar.store }));
vi.mock("@/lib/sentry-server", () => ({ captureServerError: sentry.captureServerError }));

import {
  APPEARANCE_COOKIE_MAX_AGE,
  DEFAULT_APPEARANCE,
  LOCALE_COOKIE,
  THEME_COOKIE,
  appearanceCookieOptions,
  clearAppearanceCookies,
  coerceAppearance,
  coerceLocale,
  coerceTheme,
  isSecureTransport,
  writeAppearanceCookies,
} from "@/lib/appearance/cookies";

const ROOT = process.cwd();

beforeEach(() => {
  jar.sets.length = 0;
  jar.deletes.length = 0;
  jar.failOnWrite.value = false;
  sentry.captureServerError.mockClear();
});

describe("coercion at the boundary (the columns are wider than the unions)", () => {
  it("answers dark for anything that is not the string light", () => {
    expect(coerceTheme("light")).toBe("light");
    expect(coerceTheme("dark")).toBe("dark");
    expect(coerceTheme("solarized")).toBe("dark");
    expect(coerceTheme("Light")).toBe("dark");
    expect(coerceTheme(undefined)).toBe("dark");
    expect(coerceTheme(null)).toBe("dark");
    expect(coerceTheme(1)).toBe("dark");
  });

  it("answers en for anything that is not the string ur", () => {
    expect(coerceLocale("ur")).toBe("ur");
    expect(coerceLocale("en")).toBe("en");
    expect(coerceLocale("fr")).toBe("en");
    expect(coerceLocale("UR")).toBe("en");
    expect(coerceLocale(undefined)).toBe("en");
    expect(coerceLocale(null)).toBe("en");
  });

  it("coerces a whole row, including a missing one", () => {
    expect(coerceAppearance({ theme: "light", locale: "ur" })).toEqual({
      theme: "light",
      locale: "ur",
    });
    expect(coerceAppearance(null)).toEqual(DEFAULT_APPEARANCE);
    expect(coerceAppearance({})).toEqual(DEFAULT_APPEARANCE);
  });
});

describe("the cookie attributes", () => {
  it("is readable by an inline <head> script, which is the entire point", () => {
    // HttpOnly exists to hide a cookie from `document.cookie`, and
    // `shellBootstrap` in app/layout.tsx reads these through `document.cookie`
    // before first paint. HttpOnly here does not break a test or throw — it
    // just makes the value permanently invisible to the only thing that wanted
    // it, which is the state this whole module was written to end.
    expect(appearanceCookieOptions().httpOnly).toBe(false);
  });

  it("is scoped to the whole site and lasts a year", () => {
    const options = appearanceCookieOptions();
    expect(options.path).toBe("/");
    expect(options.maxAge).toBe(60 * 60 * 24 * 365);
    expect(APPEARANCE_COOKIE_MAX_AGE).toBe(options.maxAge);
  });

  it("is SameSite=Lax — nothing cross-site reads it, and None would force Secure", () => {
    expect(appearanceCookieOptions().sameSite).toBe("lax");
  });

  it("is Secure on a built deployment and not on the plain-HTTP dev server", () => {
    // A Secure cookie is dropped outright by the browser over http://127.0.0.1,
    // which would make `npm run dev` the one environment where the fix cannot be
    // observed. Judged from NODE_ENV (transport) and NOT from VERCEL_ENV: a
    // preview deploy is served over HTTPS and should carry the flag, even though
    // it is not "the live deployment".
    expect(isSecureTransport({ NODE_ENV: "production" })).toBe(true);
    expect(isSecureTransport({ NODE_ENV: "development" })).toBe(false);
    expect(isSecureTransport({ NODE_ENV: "test" })).toBe(false);
    expect(isSecureTransport({})).toBe(false);
  });
});

describe("writeAppearanceCookies", () => {
  it("writes both names with the coerced values", async () => {
    await writeAppearanceCookies({ theme: "light", locale: "ur" });
    expect(jar.sets.map((c) => [c.name, c.value])).toEqual([
      [THEME_COOKIE, "light"],
      [LOCALE_COOKIE, "ur"],
    ]);
  });

  it("writes both even when only one value is known", async () => {
    // A cookie pair where one half is absent is a pair that disagrees with the
    // row, so the missing half is written as the default rather than skipped.
    await writeAppearanceCookies({ locale: "ur" });
    expect(jar.sets.map((c) => c.name).sort()).toEqual([LOCALE_COOKIE, THEME_COOKIE].sort());
    expect(jar.sets.find((c) => c.name === THEME_COOKIE)?.value).toBe(DEFAULT_APPEARANCE.theme);
  });

  it("never throws, and reports the failure instead of hiding it", async () => {
    // `cookies().set()` throws outright once the response has started
    // streaming. Every call site has already minted a session or saved a
    // preference by the time this runs, so throwing here would turn a success
    // into an error over a repaint. Silence would be worse than the bug,
    // though — it looks exactly like the unreachable state this module ended.
    jar.failOnWrite.value = true;
    await expect(writeAppearanceCookies({ theme: "light", locale: "ur" })).resolves.toBeUndefined();
    expect(sentry.captureServerError).toHaveBeenCalledTimes(1);
  });
});

describe("clearAppearanceCookies", () => {
  it("deletes both names at the path they were written to", async () => {
    // A delete only matches a cookie with the same path, so the path is passed
    // explicitly rather than left to a default.
    await clearAppearanceCookies();
    const deleted = jar.deletes.map((d) => (typeof d === "string" ? { name: d, path: "/" } : d));
    expect(deleted).toEqual([
      { name: THEME_COOKIE, path: "/" },
      { name: LOCALE_COOKIE, path: "/" },
    ]);
  });

  it("never throws", async () => {
    jar.failOnWrite.value = true;
    await expect(clearAppearanceCookies()).resolves.toBeUndefined();
    expect(sentry.captureServerError).toHaveBeenCalledTimes(1);
  });
});

describe("DEFAULT_APPEARANCE mirrors prisma/schema.prisma", () => {
  /** `theme           String    @default("dark")` → "dark". */
  function schemaDefault(column: string): string | null {
    const source = readFileSync(join(ROOT, "prisma", "schema.prisma"), "utf8");
    // exec, not matchAll + for…of: this tsconfig sets no `target`, so tsc
    // defaults to ES5 and iterating a matchAll is a TS2802 vitest never sees.
    const pattern = new RegExp("^\\s*" + column + '\\s+String\\s+@default\\("([^"]+)"\\)', "m");
    const m = pattern.exec(source);
    return m ? m[1]! : null;
  }

  it("uses the theme default the database will actually apply", () => {
    // signupAction writes DEFAULT_APPEARANCE instead of re-reading the row it
    // just inserted, because `theme` and `locale` are not part of that insert.
    // That shortcut is correct only while these agree.
    expect(schemaDefault("theme"), "User.theme lost its @default in the schema").toBeTruthy();
    expect(DEFAULT_APPEARANCE.theme).toBe(schemaDefault("theme"));
  });

  it("uses the locale default the database will actually apply", () => {
    expect(schemaDefault("locale"), "User.locale lost its @default in the schema").toBeTruthy();
    expect(DEFAULT_APPEARANCE.locale).toBe(schemaDefault("locale"));
  });
});

describe("the module stays out of the public endpoint surface", () => {
  const source = readFileSync(join(ROOT, "lib", "appearance", "cookies.ts"), "utf8");

  it('carries no "use server" directive', () => {
    // If it ever does, `writeAppearanceCookies` becomes a POST endpoint anyone
    // can call to set cookies in their own browser — and the *Action naming
    // guard would then be the only thing objecting. This says it by name, with
    // the reason next to it.
    const firstStatement = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(/^[\s;]*(?:"use server"|'use server')\s*;/.test(firstStatement)).toBe(false);
  });

  it("writes only values the pre-paint script will accept", () => {
    // The last link in the chain: the bootstrap validates the cookie against its
    // own LOCALES literal and replaces anything else with 'en'. A cookie value
    // it rejects is a cookie that was never worth writing.
    const layout = readFileSync(join(ROOT, "app", "layout.tsx"), "utf8");
    const localesLiteral = /var\s+LOCALES\s*=\s*\[([^\]]*)\]/.exec(layout);
    expect(localesLiteral, "shellBootstrap no longer declares LOCALES").toBeTruthy();
    const accepted = localesLiteral![1]!
      .split(",")
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
      .filter(Boolean);
    // Everything coerceLocale can produce.
    expect(accepted).toContain(coerceLocale("en"));
    expect(accepted).toContain(coerceLocale("ur"));
    // And the theme coercion is the same rule on both sides.
    expect(layout).toContain("if (theme !== 'light') theme = 'dark';");
  });
});
