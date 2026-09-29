/**
 * components/providers.tsx — the two global decisions it makes for every route:
 * whether motion is reduced (a11y-009) and what language the document claims to
 * be in (i18n-001, in the last describe block).
 *
 * a11y-009 — does the app honour `prefers-reduced-motion` for framer-motion?
 *
 * WHY THIS FILE EXISTS AND WHY IT LOOKS LIKE THIS (read before editing).
 *
 * `app/globals.css` has a correct `@media (prefers-reduced-motion: reduce)`
 * block that pins `animation-duration` and `transition-duration` to 0.01ms.
 * That covers every CSS-driven animation in the product — Radix `data-state`
 * cross-fades, `animate-pulse` skeletons, the `.reveal` landing stagger. It
 * cannot cover framer-motion, which writes inline `transform` / `opacity` from
 * JS on every frame; no CSS rule can reach a style the animation loop rewrites
 * 60 times a second.
 *
 * framer-motion's own switch for this is `MotionConfigContext.reducedMotion`,
 * and its default is the string `"never"`
 * (node_modules/framer-motion/dist/es/context/MotionConfigContext.mjs). "never"
 * means *never reduce*, i.e. opt-out by default. So a tree with no
 * `<MotionConfig>` ignores the OS preference completely, however correct the
 * stylesheet is.
 *
 * TWO TRAPS, both of which make a naive version of this test pass against the
 * broken code — which is this repo's most recurrent defect class:
 *
 *  1. `tests/setup.ts:20` stubs `window.matchMedia` to answer
 *     `matches: false` for EVERY query. A test that renders and asserts "no
 *     motion" therefore asserts nothing: the browser it is pretending to be has
 *     not asked for reduced motion. Every test below installs its own stub.
 *
 *  2. framer-motion queries `"(prefers-reduced-motion)"` — the boolean form,
 *     with no `: reduce` value
 *     (dist/es/utils/reduced-motion/index.mjs:9). A stub that only special-cases
 *     the string `"(prefers-reduced-motion: reduce)"` answers `false` here and
 *     the test silently proves nothing. `stubReducedMotion()` below matches the
 *     feature name, not a whole query string.
 *
 * A THIRD thing to know: `prefersReducedMotion.current`
 * (dist/es/utils/reduced-motion/state.mjs) is MODULE-GLOBAL and latched by the
 * first visual element to mount in the module registry —
 * `VisualElement.mount()` only calls `initPrefersReducedMotion()` when
 * `hasReducedMotionListener.current` is false. Vitest gives each test *file* a
 * fresh registry but not each test, so the stub must be in place before the
 * first `motion.*` mount in this file, and a single file cannot observe both
 * answers behaviourally. That is why the "does not over-reduce" case asserts the
 * context value (`"user"`, not `"always"`) instead of re-rendering with the
 * stub flipped.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { MotionConfigContext, motion } from "framer-motion";
import { useContext } from "react";
import { Providers } from "@/components/providers";
import { useStore } from "@/lib/store";

// Providers wraps everything in next-auth's SessionProvider, which would try to
// fetch /api/auth/session. Neither the provider nor the session is what this
// file is about.
//
// NO_SESSION is a module constant, not a fresh object per call: Inner's hydration
// effect has `session` in its dep array, and a new identity every render makes it
// re-fire and setState outside act().
const NO_SESSION = { data: null, status: "unauthenticated" as const };
vi.mock("next-auth/react", () => ({
  SessionProvider: ({ children }: { children: React.ReactNode }) => children,
  useSession: () => NO_SESSION,
}));

/** Answer `matches` for any `prefers-reduced-motion` query, false otherwise. */
function stubReducedMotion(matches: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    // Deliberately a substring test on the FEATURE NAME: framer asks for
    // "(prefers-reduced-motion)" and CSS-facing code asks for
    // "(prefers-reduced-motion: reduce)". Both must get the same answer or this
    // file tests a browser that does not exist.
    matches: query.includes("prefers-reduced-motion") ? matches : false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

// Install before the first render in the file — see trap 3 in the header.
stubReducedMotion(true);

beforeEach(() => {
  stubReducedMotion(true);
});

/**
 * A stand-in for the real offenders: the topbar notification + account panels
 * (components/layout/topbar.tsx), the mobile drawer (components/layout/
 * sidebar.tsx) and the theme toggle. All of them slide and scale — `x`/`y` and
 * `scale` — which is exactly the vestibular-trigger class WCAG 2.3.3 is about.
 *
 * The duration is deliberately huge. If motion is NOT suppressed, the element is
 * still essentially at its start offset after a few frames, so the assertion
 * cannot pass by accident on a fast machine.
 */
function SlidingPanel() {
  return (
    <motion.div
      data-testid="panel"
      initial={{ x: -240, scale: 0.9, opacity: 0 }}
      animate={{ x: 0, scale: 1, opacity: 1 }}
      transition={{ duration: 10 }}
    />
  );
}

/** Lets a test read what framer-motion is actually configured with. */
function ReducedMotionProbe() {
  const { reducedMotion } = useContext(MotionConfigContext);
  return <span data-testid="probe">{String(reducedMotion)}</span>;
}

/** Let framer's frame loop run a handful of frames. */
async function flushFrames() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
}

describe("a user who asked their OS to reduce motion (a11y-009)", () => {
  it("gets no slide and no scale from a framer-motion panel inside the app tree", async () => {
    render(
      <Providers>
        <SlidingPanel />
      </Providers>
    );
    await flushFrames();

    const panel = screen.getByTestId("panel");
    // framer-motion collapses `transform` to the literal "none" once every
    // transform component sits at its default, so "none" is the observable
    // signature of "it snapped to the end state instead of travelling there".
    expect(
      panel.style.transform,
      "the OS preference is set, so the panel must not travel 240px or scale up " +
        '— framer-motion needs <MotionConfig reducedMotion="user"> in ' +
        'components/providers.tsx; its default is reducedMotion: "never", ' +
        "which means never reduce"
    ).toBe("none");
  });

  it("still fades, because opacity is not a vestibular trigger", async () => {
    render(
      <Providers>
        <SlidingPanel />
      </Providers>
    );
    await flushFrames();

    const panel = screen.getByTestId("panel");
    // framer only snaps `positionalKeys` (width/height/top/left/right/bottom +
    // every transform) under reduced motion; opacity keeps animating. That is
    // the correct reading of 2.3.3 — cross-fades are not motion — and this
    // assertion is here so nobody "fixes" a future complaint by reaching for
    // reducedMotion="always", which would kill the fade too.
    const opacity = Number(panel.style.opacity);
    expect(opacity).toBeGreaterThanOrEqual(0);
    expect(opacity).toBeLessThan(1);
  });
});

describe("the reduced-motion setting is the user's, not ours", () => {
  it("configures framer-motion with reducedMotion=user", () => {
    render(
      <Providers>
        <ReducedMotionProbe />
      </Providers>
    );
    // "user" = follow the media query. "always" would strip motion from
    // everyone including people who never asked; "never" is framer's
    // opt-out default and is the bug.
    expect(
      screen.getByTestId("probe").textContent,
      'framer-motion must be told to follow the media query ("user"). "never" ' +
        'is the library default and ignores the OS entirely; "always" would ' +
        "remove motion for users who never asked for it."
    ).toBe("user");
  });

  it("covers the whole app tree, not a subtree", () => {
    // The probe is passed as `children`, i.e. exactly where app/layout.tsx puts
    // the entire route tree. If MotionConfig were placed beside `children`
    // rather than around them, this reads "never".
    render(
      <Providers>
        <div>
          <div>
            <ReducedMotionProbe />
          </div>
        </div>
      </Providers>
    );
    expect(screen.getByTestId("probe").textContent).toBe("user");
  });
});

/**
 * i18n-001 — <html lang> must describe the language the document is ACTUALLY in.
 *
 * Urdu coverage is partial: the dictionary holds 282 strings over seven
 * namespaces (nav, topbar, breadcrumb, auth, common, projects, settings) and the
 * product still has 559 untranslated English literals in 56 files, of which only
 * /projects is fully covered beyond the shared shell. The exact figures are in
 * the wave report; what matters here is that "partial" is the state, and a
 * partially translated document is predominantly English.
 *
 * Setting `lang="ur"` on that document tells every screen reader to apply Urdu
 * grapheme-to-phoneme rules to all of it, including all 38 aria-labels and 45
 * toasts. English orthography under Urdu phoneme rules is not accented English,
 * it is noise — so one click in Settings made the product LESS usable than
 * leaving it in English, and User.locale persists that across devices.
 *
 * `dir` is a separate axis and must keep following the locale: the shell IS
 * translated, and an RTL user needs the mirror. Conflating the two was the
 * original error.
 */
describe("the document's declared language is the language it is in (i18n-001)", () => {
  /** Put the store in `locale` before mounting, so no setState lands mid-render. */
  function renderIn(locale: "en" | "ur") {
    act(() => {
      useStore.setState({ locale });
    });
    render(<Providers>{null}</Providers>);
  }

  afterEach(() => {
    act(() => {
      useStore.setState({ locale: "en" });
    });
    document.documentElement.lang = "en";
    document.documentElement.dir = "ltr";
  });

  it("stays en under locale=ur while Urdu coverage is partial", () => {
    renderIn("ur");

    expect(
      document.documentElement.lang,
      "the document is overwhelmingly English (559 untranslated literals across " +
        '56 files), so lang="ur" makes a screen reader read English through Urdu ' +
        "phonemes on every one of them — worse than not translating at all"
    ).toBe("en");
  });

  it("still mirrors the layout for Urdu", () => {
    renderIn("ur");

    expect(
      document.documentElement.dir,
      "direction and language are separate axes. The shell (nav, topbar, " +
        "breadcrumbs, command palette, settings, auth) IS translated and needs " +
        "the RTL mirror; fixing lang must not cost the user that."
    ).toBe("rtl");
  });

  it("is still en/ltr for an English user", () => {
    renderIn("en");

    expect(document.documentElement.lang).toBe("en");
    expect(document.documentElement.dir).toBe("ltr");
  });
});
