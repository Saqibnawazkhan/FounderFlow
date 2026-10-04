/**
 * sec-013 — the client's idea of the current user's ROLE comes from the server
 * session, and from nowhere the person at the browser can edit.
 *
 * WHAT THIS GUARDS. `components/providers.tsx` is the only writer of the store's
 * `currentUser`, and the sidebar's finance-nav filter reads its `role`
 * (components/layout/sidebar.tsx:215). The hydration effect looks the signed-in
 * email up in `useStore.getState().users` — an array that is part of the
 * `founderflow-storage` localStorage blob (`partialize` in lib/store.ts), so it
 * is fully editable with devtools. If that row's `role` could reach
 * `hydrateUser`, a member could type `"admin"` into localStorage and hand
 * themselves admin chrome.
 *
 * WHY A SEPARATE FILE FROM tests/lib/actions/session-name-hydration.test.tsx.
 * That file was written for acct-006 and asserts `name` (and that `createdAt`
 * still comes from the local row). It catches a regression that reorders the
 * object literal — moving `...(local ?? …)` after the explicit keys makes the
 * name stale and that file goes red. It does NOT catch a regression confined to
 * the security-relevant fields, e.g.
 *
 *     role: local?.role ?? sUser.role ?? "member",
 *
 * which leaves every name assertion green while reopening the escalation. The
 * fields asserted below are exactly that gap: `role`, `companyId` (the tenant)
 * and `id` (whose rows the store's scoped selectors return).
 *
 * THESE CASES WERE WATCHED FAILING. With `role`/`companyId`/`id` flipped to
 * prefer the local row, the first three fail with the tampered values
 * ("admin" / "c-victim" / "u-admin"); restored, they pass.
 *
 * THE STORE ALSO PERSISTS `currentUser` ITSELF, so a tampered role is live from
 * the moment Zustand replays localStorage until this effect overwrites it. An
 * earlier version of this header called that "the window between persist and
 * `useSession()` resolving" and left it at that. THAT WAS WRONG ON THE FAILURE
 * PATH, and adversarial verification caught it: `users` is replayed with no
 * `version`, `migrate` or `merge`, so a row with a missing or non-string `email`
 * made the lookup throw, the catch swallowed it WITHOUT hydrating, and the
 * tampered `currentUser` then governed for the entire page lifetime — permanent,
 * not a flash, and re-thrown on every later run because the identity ref never
 * advances past a throw. The lookup is now total and the catch hydrates from the
 * session regardless, and the last two cases below pin both halves.
 *
 * What `partialize` chooses to keep is still a separate question in a separate
 * file; what is asserted here is that no path through THIS effect can leave a
 * local row in charge of the role.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";

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
  /** Set to make reading `users` throw, so the catch can be exercised. */
  throwOnUsers: false,
}));

// A spy store, so these cases assert what Providers DECIDED to hydrate rather
// than what survived `hydrateUser`'s own same-identity guard downstream.
vi.mock("@/lib/store", () => {
  const useStore = Object.assign((selector: (s: typeof S.state) => unknown) => selector(S.state), {
    getState: () => {
      // The ONE place these cases can inject a failure into the merge. The
      // effect reads the roster through `getState()`, so throwing here stands
      // in for anything above `hydrateUser` going wrong — a store shape this
      // build does not expect, a selector that changed, a future field.
      if (S.throwOnUsers) throw new TypeError("persisted store is not what this build expects");
      return S.state;
    },
  });
  return { useStore };
});

/**
 * A mutable holder, not a fresh object per call: `Inner`'s hydration effect has
 * `session` in its dep array, so a new identity on every render would re-fire it
 * forever and set state outside `act()`.
 */
const SESSION = vi.hoisted(() => ({
  value: { data: null as unknown, status: "unauthenticated" as string },
}));

vi.mock("next-auth/react", () => ({
  SessionProvider: ({ children }: { children: React.ReactNode }) => children,
  useSession: () => SESSION.value,
}));

import { Providers } from "@/components/providers";

/** The signed-in member, as `auth.config.ts`'s session callback hands it over. */
function signedInMember(over: Record<string, unknown> = {}) {
  SESSION.value = {
    status: "authenticated",
    data: {
      user: {
        id: "u-member",
        name: "Ayesha",
        email: "ayesha@nimbus.app",
        role: "member",
        companyId: "c-nimbus",
        ...over,
      },
    },
  };
}

/** What someone with devtools open writes into `founderflow-storage`. */
function tamperedLocalRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "u-member",
    name: "Ayesha",
    email: "ayesha@nimbus.app",
    password: "",
    role: "member",
    companyId: "c-nimbus",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function lastHydrated(): StoreUser | null {
  const calls = S.state.hydrateUser.mock.calls;
  if (calls.length === 0) throw new Error("providers never hydrated anything");
  return calls[calls.length - 1]![0] as StoreUser | null;
}

function renderProviders() {
  render(
    <Providers>
      <div />
    </Providers>
  );
}

const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

beforeEach(() => {
  errorSpy.mockClear();
  S.throwOnUsers = false;
  S.state.hydrateUser.mockClear();
  S.state.init.mockClear();
  S.state.users = [];
  SESSION.value = { data: null, status: "unauthenticated" };
});

describe("sec-013 — localStorage cannot grant a role", () => {
  it("keeps the session's role when the local row claims admin", () => {
    S.state.users = [tamperedLocalRow({ role: "admin" })];
    signedInMember();

    renderProviders();

    expect(lastHydrated()?.role).toBe("member");
  });

  it("keeps the session's companyId when the local row names another tenant", () => {
    S.state.users = [tamperedLocalRow({ companyId: "c-victim" })];
    signedInMember();

    renderProviders();

    expect(lastHydrated()?.companyId).toBe("c-nimbus");
  });

  /*
   * THE MALFORMED-ROW PATH, which is where this effect used to fail OPEN.
   *
   * Found by adversarial verification, not by writing this file: a persisted row
   * with no `email` made `u.email.toLowerCase()` throw, the catch logged and
   * returned without hydrating, and the tampered `currentUser` Zustand had
   * already replayed stayed in charge for the whole page lifetime. The proof was
   * exactly the first assertion below — `expected "vi.fn()" to be called at least
   * once` — so a row that is not even a plausible user was enough to disable the
   * one line that makes the session authoritative.
   *
   * Both halves are pinned: the lookup must survive the row, and the catch must
   * still hand the session to `hydrateUser` if anything above it throws.
   */
  /*
   * THE CATCH ITSELF, pinned separately — and it needed its own case.
   *
   * The lookup guard above and this fail-safe are redundant by design, and that
   * redundancy made the first draft of these tests weaker than they looked:
   * reverting the catch left all of them green, because with a total lookup
   * nothing throws and the catch never runs. A defence no test can reach is one
   * nobody can safely change later.
   *
   * So this case throws from somewhere the lookup guard cannot help — reading the
   * store at all — and asserts the session still wins. Revert the fail-safe and
   * it fails alone.
   */
  it("hands the session to hydrateUser even when the merge throws outright", () => {
    S.throwOnUsers = true;
    signedInMember();

    renderProviders();

    expect(
      S.state.hydrateUser,
      "a throw in the merge left whatever localStorage had replayed in charge"
    ).toHaveBeenCalled();
    expect(lastHydrated()?.role).toBe("member");
    expect(lastHydrated()?.id).toBe("u-member");
    expect(errorSpy, "the failure should still be reported").toHaveBeenCalled();
  });

  it("still hydrates from the session when a persisted row has no email at all", () => {
    S.state.users = [{ id: "u-admin", role: "admin" } as unknown as StoreUser];
    signedInMember();

    renderProviders();

    expect(
      S.state.hydrateUser,
      "a malformed localStorage row stopped the session from being applied at all"
    ).toHaveBeenCalled();
    expect(lastHydrated()?.role).toBe("member");
    expect(lastHydrated()?.id).toBe("u-member");

    /*
     * AND IT MUST NOT HAVE THROWN TO GET HERE.
     *
     * The two defences are redundant by design — a total lookup, and a catch that
     * hydrates from the session anyway — so the assertions above pass with EITHER
     * one reverted. That makes them worth exactly half of what they look worth,
     * and I only noticed by reverting each half and watching all seven stay green.
     *
     * `console.error` is the discriminator: the catch logs before it recovers, so
     * a silent run proves the lookup absorbed the row rather than the catch
     * rescuing it. Revert the `typeof u?.email === "string"` guard and this line
     * fails on its own while the rest stay green.
     */
    expect(
      errorSpy,
      "the lookup threw and the catch recovered; the guard in the lookup is not doing its job"
    ).not.toHaveBeenCalled();
  });

  it("still hydrates from the session when a persisted row's email is not a string", () => {
    S.state.users = [{ id: "u-admin", role: "admin", email: 42 } as unknown as StoreUser];
    signedInMember();

    renderProviders();

    expect(S.state.hydrateUser).toHaveBeenCalled();
    expect(lastHydrated()?.role).toBe("member");
  });

  it("keeps the session's id when the local row claims to be someone else", () => {
    S.state.users = [tamperedLocalRow({ id: "u-admin" })];
    signedInMember();

    renderProviders();

    expect(lastHydrated()?.id).toBe("u-member");
  });

  it("matches the local row case-insensitively and still refuses its role", () => {
    // The lookup lowercases both sides, so a differently-cased address is the
    // same person — and must not become a way around the rule above.
    S.state.users = [tamperedLocalRow({ email: "Ayesha@Nimbus.App", role: "cofounder" })];
    signedInMember();

    renderProviders();

    expect(lastHydrated()?.role).toBe("member");
  });

  it("falls back to member, not to the local row, when the session carries no role", () => {
    // `auth.config.ts:84` already defaults `session.user.role` to "member", so
    // this state should be unreachable in the app. Pinned anyway: the fallback
    // chain in providers.tsx is what would be read if that default were ever
    // removed, and it must not reach for attacker-controlled storage.
    S.state.users = [tamperedLocalRow({ role: "admin" })];
    signedInMember({ role: undefined });

    renderProviders();

    expect(lastHydrated()?.role).toBe("member");
  });
});
