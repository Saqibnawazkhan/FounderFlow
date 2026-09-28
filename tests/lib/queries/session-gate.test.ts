/**
 * The session helper every scoped query starts at — tested for the three
 * properties it is supposed to carry and did not.
 *
 * ONE FUNCTION, THREE FINDINGS, and they pull against each other, which is why
 * they share a file:
 *
 *   • perf-001 — `requireScopedSession()` called `auth()` unconditionally, and
 *     `auth()`'s jwt callback reads the User row. /dashboard calls it six
 *     times, /projects/[id] six times across four sequential stages. So a page
 *     view cost five or six extra serial round trips and multiplied pgbouncer
 *     pressure 6x per concurrent user.
 *   • auth-002 — a revoked session (password changed on another device, an
 *     admin deactivation, a bumped `sessionVersion`) made `auth()` return an
 *     empty session, and this function THREW "Not authenticated". A throw in an
 *     RSC lands in app/(app)/error.tsx, whose two CTAs both re-enter the same
 *     loop. The user's app became a permanent error card with no route back to
 *     /login.
 *   • sec-002 — "Members never see finance pages" was enforced by exactly one
 *     layer for seven of the eight blocked routes: a middleware redirect that
 *     reads the role out of the user's own cookie. The Edge jwt callback does
 *     no database read, so a demoted co-founder who blocks one request keeps
 *     the stale claim for the JWT lifetime.
 *
 * WHY THE FIX FOR perf-001 IS A PER-REQUEST MEMO AND NOT A TTL. The cheap way
 * to cut the duplicate reads is a cache with a time-to-live, and it would have
 * paid for itself by undoing auth-002 and sec-002: the whole value of the
 * per-request DB read is that a revocation or a demotion takes effect on the
 * NEXT request. A 30-second TTL is a 30-second window in which a tombstoned
 * user still reads data, and it is invisible in testing. So the memo is scoped
 * to one request and nothing longer: 6 reads → 1, never 1 → 0.
 *
 * WHY THE perf-001 SUITE IS STRUCTURAL AND THE OTHER TWO ARE NOT. The memo is
 * React's `cache`, whose entries live in a per-request scope that only the
 * framework creates, and React 18.3.1 exports `cache` ONLY from its
 * react-server entry — under vitest's resolution it is simply absent, so the
 * source's identity fallback runs and there is nothing to count. `vi.mock`
 * cannot supply it either: mocking "react" at module scope breaks the shared
 * tests/setup.ts (@testing-library/react is imported there), and a `doMock`
 * that survives setup does not intercept the optimized `react` the source
 * resolves — both were tried before this file was written. So the count
 * assertion is replaced by assertions on the SHAPE of the module — one memoized
 * reader, and nobody calling `auth()` around it — plus the one count property
 * that IS observable here: that the finance assertion adds no second read of
 * its own. What no unit test can prove is that Next wires a cache scope per
 * request; that is why the source's fallback is an identity function, so being
 * wrong about the framework costs today's performance and never a session read
 * that outlives its request.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/* ─────────────────────────────────────────────────────────────────────────── */
/* Harness                                                                     */
/* ─────────────────────────────────────────────────────────────────────────── */

const H = vi.hoisted(() => {
  /** What `auth()` resolves with, and how many times it was asked. */
  const state = {
    session: null as unknown,
    calls: 0,
  };

  const auth = () => {
    state.calls += 1;
    return Promise.resolve(state.session);
  };

  return { state, auth };
});

vi.mock("@/lib/auth", () => ({ auth: H.auth }));

import { getSession, requireFinanceSession, requireScopedSession } from "@/lib/queries/session";

/** A signed-in user, in the shape auth() hands back. */
function sessionFor(role: string | undefined, over: Record<string, unknown> = {}) {
  return {
    user: {
      id: "u_ayesha",
      name: "Ayesha",
      email: "ayesha@nimbus.app",
      companyId: "c_nimbus",
      role,
      ...over,
    },
  };
}

/** What was thrown — a redirect carries a `digest`; a plain Error does not. */
function thrownFrom(p: Promise<unknown>): Promise<{ digest?: string; message?: string }> {
  return p.then(
    () => {
      throw new Error("expected the call to divert, but it returned normally");
    },
    (e: { digest?: string; message?: string }) => e
  );
}

beforeEach(() => {
  H.state.session = sessionFor("admin");
  H.state.calls = 0;
});

/* ─────────────────────────────────────────────────────────────────────────── */
/* perf-001 — one session validation per request                               */
/* ─────────────────────────────────────────────────────────────────────────── */

describe("the session read is memoized once per request", () => {
  /** The module's own source, with comments removed so prose can't satisfy it. */
  const source = (() => {
    const raw = readFileSync(join(process.cwd(), "lib", "queries", "session.ts"), "utf8");
    return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  })();

  /** Body of a top-level `export async function <name>` up to its closing brace. */
  function bodyOf(name: string): string {
    const start = source.indexOf("export async function " + name);
    expect(start, name + " should be exported from lib/queries/session.ts").toBeGreaterThan(-1);
    const from = source.indexOf("{", start);
    const end = source.indexOf("\n}", from);
    return source.slice(from, end);
  }

  it("reads the session in exactly one place", () => {
    // Every extra `auth()` in this file is another User row read per page view.
    const hits = source.match(/\bauth\(\)/g) ?? [];
    expect(hits.length).toBe(1);
  });

  it("wraps that read in a memoizer instead of calling it per query", () => {
    // `getSession` is the reader; the name in front of it is the memoizer.
    expect(source).toMatch(
      /export const getSession = [A-Za-z_$][\w$]*\(\s*\(\)\s*=>\s*auth\(\)\s*\)/
    );
  });

  it("takes the memoizer from React's request-scoped cache, with a fallback", () => {
    // React's `cache` is the only memo whose entries die with the request. The
    // `??` matters as much: React 18.3.1 does not export `cache` outside its
    // react-server entry, and a bare call would throw on import.
    expect(source).toMatch(/\.cache\s*\?\?/);
    expect(source).toMatch(/from "react"/);
  });

  it("has every caller go through the memoized reader, not auth()", () => {
    expect(bodyOf("requireScopedSession")).toContain("getSession()");
    expect(bodyOf("requireScopedSession")).not.toMatch(/\bauth\(\)/);
    expect(bodyOf("requireFinanceSession")).not.toMatch(/\bauth\(\)/);
  });

  it("does not re-read the session to answer the finance question", async () => {
    // Observable without React's cache: the finance assertion must reuse the
    // scope it already asked for, not ask a second time.
    await requireFinanceSession();
    expect(H.state.calls).toBe(1);
  });

  it("exports the reader so the 66 bare auth() call sites can migrate onto it", async () => {
    const session = await getSession();
    expect(session).toMatchObject({ user: { companyId: "c_nimbus" } });
  });
});

/* ─────────────────────────────────────────────────────────────────────────── */
/* auth-002 — a revoked session exits to /login instead of erroring            */
/* ─────────────────────────────────────────────────────────────────────────── */

describe("requireScopedSession — a revoked session is sent to /login", () => {
  it("redirects instead of throwing a page error when the session is gone", async () => {
    H.state.session = null;
    const e = await thrownFrom(requireScopedSession());
    // The user-visible contract: a real navigation to the sign-in screen.
    // NOT `Error("Not authenticated")`, which surfaces as the error card whose
    // only CTAs re-enter the same loop.
    expect(e.digest).toMatch(/^NEXT_REDIRECT/);
    expect(e.digest).toContain("/login");
    expect(e.message).not.toBe("Not authenticated");
  });

  it("redirects when the session decodes to a user with no id", async () => {
    H.state.session = { user: { name: "Nobody" } };
    const e = await thrownFrom(requireScopedSession());
    expect(e.digest).toContain("/login");
  });

  it("redirects when the token carries no companyId", async () => {
    H.state.session = sessionFor("admin", { companyId: undefined });
    const e = await thrownFrom(requireScopedSession());
    expect(e.digest).toContain("/login");
  });

  it("still hands a live session straight through", async () => {
    await expect(requireScopedSession()).resolves.toEqual({
      userId: "u_ayesha",
      userName: "Ayesha",
      email: "ayesha@nimbus.app",
      companyId: "c_nimbus",
      role: "admin",
    });
  });
});

/* ─────────────────────────────────────────────────────────────────────────── */
/* sec-002 — the finance boundary, re-asked where the data is read             */
/* ─────────────────────────────────────────────────────────────────────────── */

describe("requireFinanceSession — the second layer the ledger reads were missing", () => {
  it("lets an admin through", async () => {
    const scope = await requireFinanceSession();
    expect(scope.companyId).toBe("c_nimbus");
  });

  it("lets a cofounder through", async () => {
    H.state.session = sessionFor("cofounder");
    await expect(requireFinanceSession()).resolves.toMatchObject({ role: "cofounder" });
  });

  it("diverts a member to their own home instead of reading the ledger", async () => {
    H.state.session = sessionFor("member");
    const e = await thrownFrom(requireFinanceSession());
    expect(e.digest).toMatch(/^NEXT_REDIRECT/);
    expect(e.digest).toContain("/tasks");
  });

  it("refuses a role nobody has heard of, rather than falling through", async () => {
    // The fail-open shape auth.config.ts already had to fix: anything that is
    // not literally "member" must not reach the ledger either.
    H.state.session = sessionFor("accountant");
    const e = await thrownFrom(requireFinanceSession());
    expect(e.digest).toContain("/tasks");
  });

  it("refuses a token with no role claim at all", async () => {
    H.state.session = sessionFor(undefined);
    const e = await thrownFrom(requireFinanceSession());
    expect(e.digest).toContain("/tasks");
  });

  it("still sends a signed-out caller to /login, not to /tasks", async () => {
    H.state.session = null;
    const e = await thrownFrom(requireFinanceSession());
    expect(e.digest).toContain("/login");
  });
});
