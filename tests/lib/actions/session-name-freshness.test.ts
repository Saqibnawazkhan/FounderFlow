/**
 * acct-006 — the identity in the session must be the identity in the database.
 *
 * THE BUG. `lib/auth.ts`'s jwt callback re-reads the user row on EVERY request
 * (it has to: that read is the sessionVersion check that closed a P0) and then
 * copies exactly two fields off it, `role` and `companyId`. `name` and `email`
 * are stamped once at sign-in and never looked at again. So a display-name
 * change in /settings updated the server-rendered settings body and nothing
 * else: the sidebar, the top bar, and `requireScopedSession().userName /
 * .email` all kept serving the value from whenever you last signed in.
 *
 * WHY THE FIX IS HERE RATHER THAN A CLIENT REFRESH. A `useSession().update()`
 * after the profile action repaints the tab that made the change, and only that
 * tab, and only `name`. The stale value is also read on the SERVER — activity
 * attribution and chat authorship go through `requireScopedSession()` — and on
 * every other device the user is signed in on. The lie is in the token, so the
 * token is where it is fixed. The cost is genuinely nil: the query already
 * runs, on every request; this adds two columns to its `select`.
 *
 * WHY THIS FILE DRIVES THE CONSTRUCTED CONFIG INSTEAD OF AN EXPORT. NextAuth
 * hands out no handle on a callback once it is constructed, and `lib/auth.ts`
 * is the most sensitive file in the repo — lifting the callback into a named
 * export to test it would be a structural edit to the function that carries the
 * session-invalidation check. So the `next-auth` factory is stubbed and the
 * config object it is handed is captured, exactly as
 * tests/lib/auth/login-throttle.test.ts does for `authorizeCredentials`. What
 * runs below is the same function object the live provider runs, and lib/auth.ts
 * needed no new surface for it.
 *
 * HALF THE CASES BELOW ARE ABOUT WHAT MUST NOT CHANGE. Adding fields to this
 * callback is cheap; changing its control flow is not. The tombstone / version
 * check and the deliberate fail-open on a DB error are load-bearing and
 * separately tracked, so they are pinned here: if a later edit makes the
 * callback drop a session on a database blip, or keep one for a tombstoned
 * user, this file fails.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  findUnique: vi.fn(),
  /** Whatever lib/auth.ts hands to NextAuth(), captured. */
  nextAuthConfig: { value: undefined as unknown },
}));

// next-auth is stubbed for the two reasons tests/lib/auth/login-throttle.test.ts
// documents: `next-auth/lib/env.js` does a bare `import "next/server"` that
// vitest cannot resolve, and capturing the config is what links these tests to
// the function the live runtime actually calls.
vi.mock("next-auth", () => ({
  default: (config: unknown) => {
    h.nextAuthConfig.value = config;
    return { auth: vi.fn(), handlers: {}, signIn: vi.fn(), signOut: vi.fn() };
  },
}));
vi.mock("next-auth/providers/credentials", () => ({
  default: (options: unknown) => ({
    id: "credentials",
    type: "credentials",
    ...(options as object),
  }),
}));
// auth.config.ts pulls in next/server for the middleware redirect, which hits
// the same resolution wall. The jwt callback under test replaces auth.config's
// own, so a minimal stand-in is honest — but it DOES carry a jwt of its own, so
// a regression that accidentally dropped the Node override would surface here
// as a token that never refreshes at all.
vi.mock("@/auth.config", () => ({
  authConfig: {
    trustHost: true,
    session: { strategy: "jwt" },
    pages: { signIn: "/login" },
    providers: [],
    callbacks: {
      jwt: ({ token }: { token: unknown }) => token,
      session: ({ session }: { session: unknown }) => session,
      authorized: () => true,
    },
  },
}));
vi.mock("next/headers", () => ({
  headers: async () => ({ get: () => null }),
}));
// Mocked BEFORE lib/auth is imported: importing @/lib/db for real constructs a
// PrismaClient, and a unit test has no business opening a connection.
vi.mock("@/lib/db", () => ({ db: { user: { findUnique: h.findUnique } } }));
vi.mock("bcryptjs", () => ({ default: { compare: vi.fn() } }));
vi.mock("@/lib/sentry-server", () => ({ captureServerError: vi.fn() }));

import "@/lib/auth";

/* ─────────────────────────────────────────────────────────────────────────── */

type Token = Record<string, unknown>;
type JwtCallback = (args: { token: Token; user?: unknown }) => Promise<Token | null>;

function jwtCallback(): JwtCallback {
  const cfg = h.nextAuthConfig.value as { callbacks?: { jwt?: JwtCallback } } | undefined;
  const fn = cfg?.callbacks?.jwt;
  if (!fn) throw new Error("lib/auth.ts did not construct NextAuth with a jwt callback");
  return fn;
}

/** A token as it looks after a sign-in three weeks ago. */
function staleToken(over: Token = {}): Token {
  return {
    id: "u1",
    name: "Saqib",
    email: "founder@nimbus.app",
    companyId: "c1",
    role: "member",
    sessionVersion: 0,
    ...over,
  };
}

/** The live row, as the callback selects it. */
function liveRow(over: Record<string, unknown> = {}) {
  return {
    name: "Saqib",
    email: "founder@nimbus.app",
    deletedAt: null,
    sessionVersion: 0,
    role: "member",
    companyId: "c1",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("acct-006 — a renamed user is renamed everywhere on the next request", () => {
  it("puts the live display name on the token", async () => {
    h.findUnique.mockResolvedValue(liveRow({ name: "Saqib Nawaz" }));

    const token = await jwtCallback()({ token: staleToken({ name: "Saqib" }) });

    expect(token).not.toBeNull();
    expect(token!.name).toBe("Saqib Nawaz");
  });

  it("puts the live login email on the token", async () => {
    // The same staleness after a CONFIRMED email change: the row moved, the
    // token did not, and `requireScopedSession().email` kept handing out the
    // address the account no longer uses.
    h.findUnique.mockResolvedValue(liveRow({ email: "founder@newdomain.com" }));

    const token = await jwtCallback()({ token: staleToken() });

    expect(token!.email).toBe("founder@newdomain.com");
  });

  it("reads name and email in the query it already runs — no second round trip", async () => {
    h.findUnique.mockResolvedValue(liveRow());

    await jwtCallback()({ token: staleToken() });

    expect(h.findUnique).toHaveBeenCalledTimes(1);
    const select = h.findUnique.mock.calls[0]![0].select as Record<string, boolean>;
    expect(select.name).toBe(true);
    expect(select.email).toBe(true);
    // Still the same single lookup that carries the P0 check.
    expect(select.deletedAt).toBe(true);
    expect(select.sessionVersion).toBe(true);
  });

  it("keeps refreshing role and companyId", async () => {
    h.findUnique.mockResolvedValue(liveRow({ role: "admin", companyId: "c2" }));

    const token = await jwtCallback()({ token: staleToken() });

    expect(token!.role).toBe("admin");
    expect(token!.companyId).toBe("c2");
  });
});

describe("acct-006 — the P0 session-invalidation behaviour is untouched", () => {
  it("kills the session when the user row is gone", async () => {
    h.findUnique.mockResolvedValue(null);
    expect(await jwtCallback()({ token: staleToken() })).toBeNull();
  });

  it("kills the session when the user is tombstoned", async () => {
    h.findUnique.mockResolvedValue(liveRow({ deletedAt: new Date() }));
    expect(await jwtCallback()({ token: staleToken() })).toBeNull();
  });

  it("kills the session when sessionVersion has been bumped", async () => {
    h.findUnique.mockResolvedValue(liveRow({ sessionVersion: 1 }));
    expect(await jwtCallback()({ token: staleToken({ sessionVersion: 0 }) })).toBeNull();
  });

  it("still fails OPEN on a database error, without corrupting the identity", async () => {
    // Deliberate, separately-tracked behaviour: signing every user out on a
    // transient blip is worse than the window a just-revoked session lingers.
    // The added refresh must not turn that into a token whose name is now
    // `undefined` — a fail-open that erases the user's name is not fail-open.
    h.findUnique.mockRejectedValue(new Error("connection reset"));

    const token = await jwtCallback()({ token: staleToken({ name: "Saqib" }) });

    expect(token).not.toBeNull();
    expect(token!.name).toBe("Saqib");
    expect(token!.email).toBe("founder@nimbus.app");
  });

  it("does no database read on the sign-in pass", async () => {
    const token = await jwtCallback()({
      token: {},
      user: {
        id: "u9",
        name: "New Signup",
        email: "new@nimbus.app",
        companyId: "c9",
        role: "admin",
        sessionVersion: 3,
      },
    });

    expect(h.findUnique).not.toHaveBeenCalled();
    expect(token!.id).toBe("u9");
    expect(token!.sessionVersion).toBe(3);
  });

  it("leaves a token with no id alone", async () => {
    const token = await jwtCallback()({ token: { name: "Anon" } });
    expect(h.findUnique).not.toHaveBeenCalled();
    expect(token).toEqual({ name: "Anon" });
  });
});
