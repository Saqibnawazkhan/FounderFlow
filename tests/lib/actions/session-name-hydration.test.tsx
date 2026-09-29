/**
 * acct-006, client half — the chrome has to notice.
 *
 * Fixing `lib/auth.ts` makes the SESSION tell the truth (see
 * tests/lib/actions/session-name-freshness.test.ts). It does not by itself make
 * the sidebar and the top bar show it, because those render
 * `useStore(s => s.currentUser)`, and the only thing that ever writes that is
 * the hydration effect in `components/providers.tsx` — which bailed out
 * whenever the user ID was unchanged:
 *
 *     if (hydratedUserIdRef.current === newId) return;
 *
 * A rename does not change the id, so a refreshed session was read, compared,
 * and discarded. The audit row calls this out precisely: "even a
 * `router.refresh()` cannot move it."
 *
 * Two behaviours are being asserted, and the second one is the subtler bug:
 *
 *   1. the guard must key on the identity's CONTENT, not just its id; and
 *   2. when a row for the same person already exists in the local `users`
 *      array, the SESSION's name and email must win. That array is seeded
 *      demo data — it has no idea a rename happened — so preferring it
 *      wholesale reintroduced the staleness through the other door.
 *
 * WHY THE GUARD CANNOT SIMPLY BE REMOVED: it exists because an earlier version
 * re-fired on every state change and built a fresh object each run, which
 * triggered React error #185 (maximum update depth) in production. The last
 * case below is that regression, written as a test: an unchanged session must
 * hydrate exactly once no matter how many times the effect runs.
 *
 * WHY THIS FILE LIVES UNDER tests/lib/actions/: that is the directory this
 * agent was granted for new test files, and the behaviour belongs to the same
 * finding as its sibling. It is a component test, hence .tsx and the default
 * jsdom environment.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";

/* ─────────────────────────────────────────────────────────────────────────── */
/* Fakes                                                                       */
/* ─────────────────────────────────────────────────────────────────────────── */

type StoreUser = {
  id: string;
  name: string;
  email: string;
  password: string;
  role: string;
  companyId: string;
  createdAt: string;
};

const S = vi.hoisted(() => ({
  state: {
    init: vi.fn(),
    theme: "light",
    locale: "en",
    hydrateUser: vi.fn(),
    users: [] as Array<Record<string, unknown>>,
  },
}));

// The real store is a zustand instance with persistence and a seed; none of
// that is what this file is about, and a spy is what lets it assert WHAT
// providers decided to hydrate rather than what survived two more guards.
vi.mock("@/lib/store", () => {
  const useStore = Object.assign((selector: (s: typeof S.state) => unknown) => selector(S.state), {
    getState: () => S.state,
  });
  return { useStore };
});

/**
 * A mutable holder, not a fresh object per call: `Inner`'s hydration effect has
 * `session` in its dep array, so a new identity on every render would re-fire it
 * forever and set state outside `act()`. Same note as
 * tests/components/providers.test.tsx.
 */
const SESSION = vi.hoisted(() => ({
  value: { data: null as unknown, status: "unauthenticated" as string },
}));

vi.mock("next-auth/react", () => ({
  SessionProvider: ({ children }: { children: React.ReactNode }) => children,
  useSession: () => SESSION.value,
}));

import { Providers } from "@/components/providers";

/* ─────────────────────────────────────────────────────────────────────────── */

function signedIn(over: Record<string, unknown> = {}) {
  SESSION.value = {
    status: "authenticated",
    data: {
      user: {
        id: "u1",
        name: "Saqib",
        email: "founder@nimbus.app",
        role: "member",
        companyId: "c1",
        ...over,
      },
    },
  };
}

/** The user object providers last asked the store to adopt. */
function lastHydrated(): StoreUser | null {
  const calls = S.state.hydrateUser.mock.calls;
  if (calls.length === 0) throw new Error("providers never hydrated anything");
  return calls[calls.length - 1]![0] as StoreUser | null;
}

beforeEach(() => {
  S.state.hydrateUser.mockClear();
  S.state.init.mockClear();
  S.state.users = [];
  SESSION.value = { data: null, status: "unauthenticated" };
});

describe("acct-006 — a renamed session reaches the app chrome", () => {
  it("re-hydrates when the display name changes under the same user id", () => {
    signedIn({ name: "Saqib" });
    const { rerender } = render(
      <Providers>
        <div />
      </Providers>
    );
    expect(lastHydrated()?.name).toBe("Saqib");

    // The rename lands. Same person, same id — which is exactly the case the
    // old ref guard treated as "nothing to do".
    signedIn({ name: "Saqib Nawaz" });
    rerender(
      <Providers>
        <div />
      </Providers>
    );

    expect(lastHydrated()?.name).toBe("Saqib Nawaz");
  });

  it("re-hydrates when a confirmed email change moves the login address", () => {
    signedIn();
    const { rerender } = render(
      <Providers>
        <div />
      </Providers>
    );

    signedIn({ email: "founder@newdomain.com" });
    rerender(
      <Providers>
        <div />
      </Providers>
    );

    expect(lastHydrated()?.email).toBe("founder@newdomain.com");
  });

  it("prefers the session's name over a stale row in the local users array", () => {
    // The seeded/demo roster knows nothing about a rename. Adopting it
    // wholesale is the same staleness arriving through a different door.
    S.state.users = [
      {
        id: "u1",
        name: "Saqib",
        email: "founder@nimbus.app",
        password: "",
        role: "member",
        companyId: "c1",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    signedIn({ name: "Saqib Nawaz" });

    render(
      <Providers>
        <div />
      </Providers>
    );

    const adopted = lastHydrated();
    expect(adopted?.name).toBe("Saqib Nawaz");
    // …while still carrying what only the local row knows.
    expect(adopted?.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("hydrates once for an unchanged session, however often the effect runs", () => {
    // React error #185 in production came from the opposite failure. The guard
    // has to get looser about names without getting looser about everything.
    signedIn();
    const { rerender } = render(
      <Providers>
        <div />
      </Providers>
    );
    const after = S.state.hydrateUser.mock.calls.length;

    rerender(
      <Providers>
        <div />
      </Providers>
    );
    rerender(
      <Providers>
        <div />
      </Providers>
    );

    expect(S.state.hydrateUser.mock.calls.length).toBe(after);
  });

  it("still wipes the local identity when the session goes away", () => {
    signedIn();
    const { rerender } = render(
      <Providers>
        <div />
      </Providers>
    );

    SESSION.value = { data: null, status: "unauthenticated" };
    rerender(
      <Providers>
        <div />
      </Providers>
    );

    expect(lastHydrated()).toBeNull();
  });
});
