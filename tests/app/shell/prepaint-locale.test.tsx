/**
 * i18n-002 — the pre-paint locale, and the preference fetch that reverts the
 * user's own click.
 *
 * ── WHAT IS ACTUALLY BROKEN, WHICH IS NOT WHAT THE FINDING SAYS ────────────
 *
 * The finding reads "the bootstrap is missing, so an Urdu user sees a
 * left-to-right English first paint". The bootstrap is NOT missing:
 * app/layout.tsx has run an inline <head> script since audit S20 that reads the
 * persisted store and sets `lang` + `dir` before the first paint. On a returning
 * device it works.
 *
 * The case that breaks is the one the CLAIM names and the diagnosis misses: a
 * new phone, a private window, or cleared site data. There is no persisted
 * snapshot to read, so the script falls through to en/ltr — and then
 * components/layout/preference-hydrator.tsx learns the real locale from the
 * user's row, after hydration and after a server round-trip, and flips the whole
 * document. No amount of tuning the localStorage read can fix that, because on a
 * first visit the locale is only known SERVER-SIDE, from the session.
 *
 * ── WHY THE FIX IS A COOKIE THE SCRIPT READS, NOT A SERVER-RENDERED lang ───
 *
 * `<html lang dir>` is rendered in exactly ONE place — app/layout.tsx, the
 * single root layout for every route in the app, `/` included. Resolving the
 * locale there server-side means `cookies()` or `auth()` in the root layout,
 * which in Next 14 opts EVERY route out of static generation, including the
 * marketing page, which has no per-user content at all. That is a large,
 * permanent cost for one attribute.
 *
 * The distinction that resolves it: the value has to be PRODUCED server-side,
 * because sign-in is the only moment a fresh device can learn it. It does not
 * have to be READ server-side, because the pre-paint script is already the thing
 * that decides the attributes and it runs before the first paint. A cookie is
 * server-written and readable by that script through `document.cookie`, at no
 * rendering cost.
 *
 * PRECEDENCE IS DELIBERATE: localStorage first, cookie only as the fallback when
 * storage holds nothing. The reverse — cookie wins — would match what
 * PreferenceHydrator does post-hydration, but it makes a locale toggle in THIS
 * browser paint the old language on the next load for as long as the cookie is
 * stale, which is a regression on a path that works today. With storage-first,
 * a browser that has a preference behaves exactly as it does now, and the only
 * behaviour that changes is the empty-storage case that is the bug.
 *
 * ── HOW THESE TESTS AVOID BEING WORTHLESS ──────────────────────────────────
 *
 * ONE THING THESE TESTS DO NOT ASSERT, ON PURPOSE: that `lang` becomes "ur".
 * i18n-001 decoupled the axes — `dir` follows the locale, `lang` follows the
 * document's predominant language, which stays English while Urdu coverage is
 * partial (`documentLangForLocale` in lib/i18n/strings.ts). So `dir === "rtl"` is
 * the observable proof the pre-paint path picked the locale up, and every `lang`
 * expectation below is COMPUTED from LOCALE_TRANSLATION_STATUS rather than
 * hardcoded, so marking Urdu complete moves these tests instead of breaking
 * them. The literal that carries that rule into the inline script is checked by
 * tests/lib/i18n/document-language.test.ts, not here.
 *
 * The bootstrap is a string in a server component; rendering app/layout.tsx in
 * jsdom proves nothing about it. So the script is PARSED OUT of the source and
 * EXECUTED — the same literal the browser gets, run against a real jsdom
 * document, with localStorage and document.cookie set up per case. That is
 * behaviour, not a source grep: a test that only asserted the source mentioned
 * "cookie" would pass on a script that read the wrong name.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { act, render } from "@testing-library/react";
import { SUPPORTED_LOCALES, documentLangForLocale } from "@/lib/i18n/strings";
import type { User } from "@/lib/types";

const H = vi.hoisted(() => ({ getMyAppearanceAction: vi.fn() }));
vi.mock("@/lib/actions/appearance", () => ({
  getMyAppearanceAction: H.getMyAppearanceAction,
}));

import { useStore } from "@/lib/store";
import { PreferenceHydrator } from "@/components/layout/preference-hydrator";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const rootLayoutSource = fs.readFileSync(path.join(REPO_ROOT, "app", "layout.tsx"), "utf8");

/** The inline <head> script, lifted out of the source exactly as it ships. */
function bootstrapSource(): string {
  const literal = rootLayoutSource.match(/const shellBootstrap = `([\s\S]*?)`;/);
  if (!literal) throw new Error("app/layout.tsx no longer declares `const shellBootstrap = `…``");
  return literal[1];
}

/**
 * Run the shipped bootstrap against the current jsdom document. `new Function`
 * rather than an import: the script is a string in a server component, and the
 * point of this file is to exercise the literal the browser actually receives.
 */
function runBootstrap(): void {
  new Function(bootstrapSource())();
}

function clearCookies(): void {
  document.cookie
    .split("; ")
    .filter((c) => c.length > 0)
    .forEach((c) => {
      const name = c.slice(0, c.indexOf("="));
      document.cookie = `${name}=; path=/; max-age=0`;
    });
}

function resetDocument(): void {
  document.documentElement.lang = "";
  document.documentElement.dir = "";
  document.documentElement.classList.remove("dark");
  localStorage.clear();
  clearCookies();
}

/** The shape zustand's persist middleware writes to localStorage. */
function persistStorage(state: Record<string, unknown>): void {
  localStorage.setItem("founderflow-storage", JSON.stringify({ state, version: 0 }));
}

describe("shellBootstrap on a device with nothing stored (i18n-002)", () => {
  beforeEach(resetDocument);
  afterEach(resetDocument);

  it("takes the locale from the server-written cookie when storage is empty", () => {
    // A new phone, a private window, or cleared site data: zustand has written
    // nothing yet, but the sign-in response carried the account's locale.
    document.cookie = "ff_locale=ur; path=/";

    runBootstrap();

    expect(
      document.documentElement.dir,
      "An Urdu account's first paint on a new device is still left-to-right, so the whole shell jumps sides once PreferenceHydrator answers."
    ).toBe("rtl");

    // `lang` is NOT "ur" here, and that is i18n-001's rule, not a gap in this
    // one: direction follows the locale, `lang` follows the document's
    // predominant language, which stays English while Urdu coverage is partial.
    // Computed from LOCALE_TRANSLATION_STATUS rather than hardcoded, so the day
    // Urdu is marked complete this test follows instead of blocking it.
    expect(document.documentElement.lang).toBe(documentLangForLocale("ur"));
  });

  it("takes the theme from the cookie too, so the first paint does not flash light", () => {
    document.cookie = "ff_theme=light; path=/";
    runBootstrap();
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    resetDocument();
    document.cookie = "ff_theme=dark; path=/";
    runBootstrap();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("ignores a cookie value that is not a supported locale", () => {
    // The cookie is not HttpOnly (the script has to read it), so treat its
    // value as untrusted input rather than writing it straight onto <html>.
    document.cookie = "ff_locale=xx-INVALID; path=/";
    runBootstrap();
    expect(document.documentElement.lang).toBe("en");
    expect(document.documentElement.dir).toBe("ltr");
  });

  it("still defaults to en/ltr/dark with neither a cookie nor storage", () => {
    runBootstrap();
    expect(document.documentElement.lang).toBe("en");
    expect(document.documentElement.dir).toBe("ltr");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});

describe("shellBootstrap still prefers what this browser stored (i18n-002)", () => {
  beforeEach(resetDocument);
  afterEach(resetDocument);

  it("uses the persisted locale over the cookie", () => {
    // The regression guard for the precedence decision: a toggle made in this
    // browser must not be undone on the next load by a cookie that has not
    // caught up yet.
    persistStorage({ theme: "dark", locale: "ur" });
    document.cookie = "ff_locale=en; path=/";

    runBootstrap();

    // `dir` is the observable proof the locale was read — see the first test
    // for why `lang` stays on the predominant language.
    expect(document.documentElement.dir).toBe("rtl");
    expect(document.documentElement.lang).toBe(documentLangForLocale("ur"));
  });

  it("uses the persisted theme over the cookie", () => {
    persistStorage({ theme: "light", locale: "en" });
    document.cookie = "ff_theme=dark; path=/";

    runBootstrap();

    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("survives a corrupt storage entry and falls through to the cookie", () => {
    localStorage.setItem("founderflow-storage", "{not json");
    document.cookie = "ff_locale=ur; path=/";

    runBootstrap();

    expect(document.documentElement.dir).toBe("rtl");
  });
});

describe("shellBootstrap's duplicated locale list (i18n-002)", () => {
  it("accepts exactly the locales the dictionary supports", () => {
    // An inline <head> script cannot import, so the script restates the set it
    // will accept. Parse the literal back out and hold it against the real
    // source of truth — the same discipline tests/lib/layout/rtl.test.ts
    // applies to RTL_LOCALES, for the same reason: adding a third locale must
    // not silently leave the pre-paint path rejecting it.
    const declared = bootstrapSource().match(/var LOCALES = \[([^\]]*)\]/);
    expect(declared, "shellBootstrap no longer declares var LOCALES = [...]").toBeTruthy();

    const scriptLocales = (declared?.[1] ?? "")
      .split(",")
      .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ""))
      .filter((entry) => entry.length > 0);

    const dictionaryLocales = SUPPORTED_LOCALES.map((l) => l.code);

    dictionaryLocales.forEach((code) => {
      expect(scriptLocales, `SUPPORTED_LOCALES has "${code}"`).toContain(code);
    });
    scriptLocales.forEach((code) => {
      expect(dictionaryLocales, `shellBootstrap accepts "${code}"`).toContain(code);
    });
  });
});

/** Minimal signed-in user — the hydrator only reads the id. */
const SIGNED_IN = { id: "user-1" } as unknown as User;

describe("PreferenceHydrator does not revert the user's own click (i18n-002)", () => {
  beforeEach(() => {
    H.getMyAppearanceAction.mockReset();
    act(() => {
      useStore.setState({ currentUser: null, locale: "en", theme: "dark" });
    });
  });

  afterEach(() => {
    act(() => {
      useStore.setState({ currentUser: null, locale: "en", theme: "dark" });
    });
  });

  it("keeps a locale chosen while the preference fetch was in flight", async () => {
    let settle: (value: unknown) => void = () => {};
    H.getMyAppearanceAction.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      })
    );

    act(() => {
      useStore.setState({ currentUser: SIGNED_IN });
    });
    render(<PreferenceHydrator />);

    // The user clicks اردو while the round-trip is still out.
    act(() => {
      useStore.getState().setLocale("ur");
    });

    // …and the stale server value lands afterwards.
    await act(async () => {
      settle({ success: true, data: { theme: "dark", locale: "en" } });
    });

    expect(
      useStore.getState().locale,
      "The user clicked اردو, the UI switched, and then it switched back on its own with no signal that anything happened — and the DB write they triggered may or may not have won."
    ).toBe("ur");
  });

  it("keeps a theme chosen while the preference fetch was in flight", async () => {
    let settle: (value: unknown) => void = () => {};
    H.getMyAppearanceAction.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      })
    );

    act(() => {
      useStore.setState({ currentUser: SIGNED_IN });
    });
    render(<PreferenceHydrator />);

    act(() => {
      useStore.getState().setTheme("light");
    });

    await act(async () => {
      settle({ success: true, data: { theme: "dark", locale: "en" } });
    });

    expect(useStore.getState().theme).toBe("light");
  });

  it("still seeds both values when the user has touched nothing", async () => {
    // The guard must not turn into "never apply the server value" — that is the
    // whole reason the hydrator exists (a preference set on another device).
    H.getMyAppearanceAction.mockResolvedValue({
      success: true,
      data: { theme: "light", locale: "ur" },
    });

    act(() => {
      useStore.setState({ currentUser: SIGNED_IN });
    });
    await act(async () => {
      render(<PreferenceHydrator />);
    });

    expect(useStore.getState().locale).toBe("ur");
    expect(useStore.getState().theme).toBe("light");
  });

  it("applies the theme even when only the locale changed mid-flight", async () => {
    // The two preferences are guarded independently: clicking اردو must not
    // also cost the user the theme they set on another device.
    let settle: (value: unknown) => void = () => {};
    H.getMyAppearanceAction.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      })
    );

    act(() => {
      useStore.setState({ currentUser: SIGNED_IN });
    });
    render(<PreferenceHydrator />);

    act(() => {
      useStore.getState().setLocale("ur");
    });

    await act(async () => {
      settle({ success: true, data: { theme: "light", locale: "en" } });
    });

    expect(useStore.getState().locale).toBe("ur");
    expect(useStore.getState().theme).toBe("light");
  });
});
