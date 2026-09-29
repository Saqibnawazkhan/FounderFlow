/**
 * auth-017 — "signing in after being bounced always dumps you on the dashboard".
 *
 * WHAT ACTUALLY HAPPENS, verified against the installed next-auth rather than
 * assumed. `authorized()` in auth.config.ts returns `false` for an
 * unauthenticated request to a non-public route; next-auth's middleware wrapper
 * (node_modules/next-auth/lib/index.js:177) then clones the request URL, swaps
 * the pathname for `pages.signIn`, and sets
 * `signInUrl.searchParams.set("callbackUrl", request.nextUrl.href)`. So the
 * destination IS preserved, in full, absolute form, all the way to /login. The
 * loss happens on the last step: `app/login/page.tsx` hard-navigated to
 * "/dashboard" on success and never looked at the parameter.
 *
 * `scripts/qa-auth-and-sessions.mjs:1305` already records this failure from a
 * live browser run, in these words: "middleware preserved callbackUrl but /login
 * hard-navigates to /dashboard, so the user lands on /dashboard — every emailed
 * or bookmarked deep link loses its destination the moment a session expires".
 *
 * WHY THIS IS NOT A ONE-LINE CHANGE. A redirect target read out of a query
 * parameter is an open redirect unless it is validated. `/login?callbackUrl=
 * https://evil.example/harvest` would hand a just-authenticated founder to a
 * convincing replica of their own finance app, from a link that really did start
 * on the real origin. Half of the cases below are that attack, in the forms that
 * actually get used: an absolute off-origin URL, a protocol-relative one, a
 * backslash standing in for a slash, a `javascript:` scheme, userinfo hiding the
 * real host, and a hostname that merely starts with ours.
 *
 * WHY SOURCE ASSERTIONS FOR THE WIRING. `app/login/page.tsx` imports
 * `components/landing/fonts`, which imports `next/font/google`, so the component
 * cannot be imported under vitest without the Next build transform — the same
 * constraint tests/lib/env/app-origin-call-sites.test.ts works around the same
 * way for app/layout.tsx and app/page.tsx. The wiring assertions therefore read
 * the file; the behaviour assertions drive the real decision function, which is
 * pure and has no such problem. That split is deliberate: a decision nothing
 * calls is not a fix (see the reachability wave), so both halves are tested.
 */

import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import {
  POST_LOGIN_ALLOWED_SEGMENTS,
  POST_LOGIN_DEFAULT,
  safePostLoginPath,
} from "@/lib/auth/post-login-redirect";

const ROOT = process.cwd();
const ORIGIN = "http://localhost:3000";
const PROD_ORIGIN = "https://app.founderflow.com";

function source(relPath: string): string {
  return readFileSync(join(ROOT, relPath), "utf8");
}

/* ── the wiring half ─────────────────────────────────────────────────────── */

describe("auth-017 wiring — /login must stop discarding the destination", () => {
  it("no longer hard-codes the post-login destination", () => {
    const src = source("app/login/page.tsx");
    expect(
      src.indexOf('window.location.href = "/dashboard"'),
      "app/login/page.tsx still navigates to a literal /dashboard on success, so the " +
        "callbackUrl the middleware went to the trouble of preserving is thrown away and " +
        "every emailed or bookmarked deep link loses its destination the moment a session " +
        "expires"
    ).toBe(-1);
  });

  it("asks the one decision where to go", () => {
    const src = source("app/login/page.tsx");
    expect(
      src.indexOf("safePostLoginPath"),
      "app/login/page.tsx does not call the validated post-login decision. Reading " +
        "`callbackUrl` inline in the component is how an open redirect ships: the " +
        "validation has to be one named, tested decision, the way appOrigin() is"
    ).toBeGreaterThan(-1);
  });

  it("still gets a callbackUrl from the middleware it depends on", () => {
    // The restore only works because next-auth's middleware wrapper writes the
    // original href into `callbackUrl` when `authorized()` returns false. That is
    // library behaviour this app does not control, and if an upgrade drops it the
    // deep-link restore degrades silently back to always-/dashboard — the exact
    // finding, reopened, with every test above still green. So the contract is
    // pinned where a version bump will trip over it.
    const lib = readFileSync(join(ROOT, "node_modules/next-auth/lib/index.js"), "utf8");
    expect(
      lib.indexOf('searchParams.set("callbackUrl"'),
      "the installed next-auth no longer puts the original URL in `callbackUrl` on an " +
        "unauthorized bounce, so app/login/page.tsx has nothing to restore. Find what it " +
        "sets instead and update both this assertion and the reader in the login page"
    ).toBeGreaterThan(-1);
  });

  it("does not build its own redirect out of the raw query parameter", () => {
    const src = source("app/login/page.tsx");
    // The failure mode this guards is a later edit that keeps the helper import
    // but navigates to the unvalidated value anyway.
    const naive =
      /(location\.(href|assign|replace)\s*\(?=?\s*[^;\n]*\b(searchParams|callbackUrl)\b)/;
    expect(
      naive.test(src),
      "app/login/page.tsx navigates to a value taken straight from the query string"
    ).toBe(false);
  });
});

/* ── the destination a bounced user asked for ────────────────────────────── */

describe("safePostLoginPath — restoring the page the user actually clicked", () => {
  it("returns a founder to the expenses page they were bounced off", () => {
    expect(safePostLoginPath(`${ORIGIN}/expenses`, ORIGIN)).toBe("/expenses");
  });

  it("keeps the query string and the fragment of a deep link", () => {
    expect(safePostLoginPath(`${ORIGIN}/projects/abc?tab=budget#row3`, ORIGIN)).toBe(
      "/projects/abc?tab=budget#row3"
    );
  });

  it("keeps the ?ref= that auth.config.ts preserves through a role bounce", () => {
    expect(safePostLoginPath(`${ORIGIN}/expenses?ref=newsletter`, ORIGIN)).toBe(
      "/expenses?ref=newsletter"
    );
  });

  it("accepts a bare absolute path, not only the absolute URL middleware writes", () => {
    expect(safePostLoginPath("/tasks", ORIGIN)).toBe("/tasks");
  });

  it("works on the production origin, not just localhost", () => {
    expect(safePostLoginPath(`${PROD_ORIGIN}/reports`, PROD_ORIGIN)).toBe("/reports");
  });

  it("sends a plain sign-in with no callbackUrl to the dashboard", () => {
    expect(safePostLoginPath(null, ORIGIN)).toBe(POST_LOGIN_DEFAULT);
    expect(safePostLoginPath(undefined, ORIGIN)).toBe(POST_LOGIN_DEFAULT);
    expect(safePostLoginPath("", ORIGIN)).toBe(POST_LOGIN_DEFAULT);
    expect(safePostLoginPath("   ", ORIGIN)).toBe(POST_LOGIN_DEFAULT);
  });

  it("does not bounce the user straight back to the page they just left", () => {
    // Every auth page is public, so /login?callbackUrl=/login is reachable and
    // would produce a sign-in that appears to do nothing.
    expect(safePostLoginPath(`${ORIGIN}/login`, ORIGIN)).toBe(POST_LOGIN_DEFAULT);
    expect(safePostLoginPath("/signup", ORIGIN)).toBe(POST_LOGIN_DEFAULT);
    expect(safePostLoginPath("/forgot-password", ORIGIN)).toBe(POST_LOGIN_DEFAULT);
  });
});

/* ── the open-redirect hole ──────────────────────────────────────────────── */

describe("safePostLoginPath — the open redirect this function exists to close", () => {
  const OFF_ORIGIN: Array<[string, string]> = [
    ["an absolute off-origin URL", "https://evil.example/harvest"],
    ["a protocol-relative URL", "//evil.example/harvest"],
    ["a backslash standing in for the second slash", "/\\evil.example/harvest"],
    ["two backslashes", "\\\\evil.example/harvest"],
    ["an uppercased scheme", "HTTPS://evil.example/harvest"],
    ["our origin hidden in the userinfo", "http://localhost:3000@evil.example/harvest"],
    ["a hostname that merely starts with ours", "https://app.founderflow.com.evil.example/x"],
    ["a subdomain of ours we do not serve", "https://evil.app.founderflow.com/x"],
    ["the same host on a different scheme", "https://localhost:3000/expenses"],
    ["a javascript: scheme", "javascript:alert(document.cookie)"],
    ["a data: URL", "data:text/html,<h1>Session expired, sign in again</h1>"],
    ["a scheme split by a tab, which browsers strip", "java\tscript:alert(1)"],
    ["a CRLF-injected value", "/expenses\r\nSet-Cookie: x=1"],
  ];

  for (const entry of OFF_ORIGIN) {
    it(`refuses ${entry[0]}`, () => {
      expect(
        safePostLoginPath(entry[1], ORIGIN),
        `a just-authenticated founder was handed off to ${entry[1]} — an open redirect ` +
          "straight into a credential-harvesting replica, reached from a link that really " +
          "did start on this app's own origin"
      ).toBe(POST_LOGIN_DEFAULT);
    });
  }

  it("refuses a same-origin path this app does not serve", () => {
    expect(safePostLoginPath("/wp-admin", ORIGIN)).toBe(POST_LOGIN_DEFAULT);
    expect(safePostLoginPath("/", ORIGIN)).toBe(POST_LOGIN_DEFAULT);
  });

  it("refuses an API route — nobody lands on one", () => {
    expect(safePostLoginPath("/api/cron/purge-soft-deleted", ORIGIN)).toBe(POST_LOGIN_DEFAULT);
  });

  it("normalises dot segments before checking the route, not after", () => {
    // `/dashboard/../wp-admin` begins with an allowed segment and resolves to
    // one that is not. A first-segment check done on the raw string passes it.
    expect(safePostLoginPath("/dashboard/../wp-admin", ORIGIN)).toBe(POST_LOGIN_DEFAULT);
  });

  it("does not accept a percent-encoded slash as a path separator", () => {
    expect(safePostLoginPath("/%2F%2Fevil.example", ORIGIN)).toBe(POST_LOGIN_DEFAULT);
  });

  it("falls back rather than throwing when the current origin is unusable", () => {
    expect(safePostLoginPath("/expenses", "not a url")).toBe(POST_LOGIN_DEFAULT);
  });
});

/* ── the allowlist cannot drift from the route tree ──────────────────────── */

describe("safePostLoginPath — the allowlist is checked against the real routes", () => {
  /**
   * The hazard with an allowlist of route names is that it silently stops
   * matching the app: a route added next quarter becomes a deep link that
   * quietly resolves to /dashboard, which looks like nothing at all. So the
   * list is compared to the directories Next actually serves under the
   * authenticated `(app)` group — the same "assert the source" pattern
   * tests/lib/cron/purge-invariants uses on schema.prisma.
   */
  function authenticatedRouteSegments(): string[] {
    const dir = join(ROOT, "app", "(app)");
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      // Route groups `(x)`, private folders `_x` and parallel slots `@x` are not
      // path segments. There are none today; the filter keeps this test honest
      // if one appears rather than demanding it be added to the allowlist.
      if (name.charAt(0) === "(" || name.charAt(0) === "_" || name.charAt(0) === "@") continue;
      out.push(name);
    }
    return out.sort();
  }

  it("names every authenticated route, so no deep link is silently dropped", () => {
    const actual = authenticatedRouteSegments();
    const missing: string[] = [];
    for (const segment of actual) {
      if (POST_LOGIN_ALLOWED_SEGMENTS.indexOf(segment) === -1) missing.push(segment);
    }
    expect(
      missing,
      "these routes exist under app/(app) but are not in POST_LOGIN_ALLOWED_SEGMENTS, so a " +
        "bounced user who asked for one of them is silently sent to /dashboard instead"
    ).toEqual([]);
  });

  it("names nothing that is not a route", () => {
    const actual = authenticatedRouteSegments();
    const stray: string[] = [];
    for (const segment of POST_LOGIN_ALLOWED_SEGMENTS) {
      if (actual.indexOf(segment) === -1) stray.push(segment);
    }
    expect(
      stray,
      "POST_LOGIN_ALLOWED_SEGMENTS names paths app/(app) does not serve, which widens the " +
        "set of URLs a crafted callbackUrl can reach for no benefit"
    ).toEqual([]);
  });

  it("lets every one of those routes through as a deep link", () => {
    for (const segment of authenticatedRouteSegments()) {
      expect(safePostLoginPath(`/${segment}`, ORIGIN), `/${segment} was dropped`).toBe(
        `/${segment}`
      );
    }
  });
});
