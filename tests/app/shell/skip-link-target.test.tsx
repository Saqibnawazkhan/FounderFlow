/**
 * a11y-008 — "Skip to main content" must land somewhere, on every route that
 * renders it. (WCAG 2.4.1 Bypass Blocks.)
 *
 * THE BUG THIS PINS. The skip link lives in the ROOT layout (app/layout.tsx),
 * so it renders on every route in the app, public and authenticated alike. Its
 * target `id="main"` existed in exactly ONE file — app/(app)/layout.tsx, the
 * authenticated shell. On the marketing page, /login, /signup,
 * /forgot-password, /reset-password, /verify-email and /verify-email-change,
 * `document.getElementById("main")` was null: activating the link moved no
 * focus and scrolled nowhere, it only appended `#main` to the URL. Because the
 * link itself visibly focuses, the failure is invisible to sighted QA — only a
 * keyboard user notices that nothing moved. The landing page was the worst
 * case: <header>, a <nav aria-label="Sections">, twelve <section>s and a
 * <footer>, and no <main> landmark at all, so there was neither a skip target
 * nor a main region to jump to.
 *
 * WHY THESE ASSERTIONS AND NOT OTHERS. jsdom has no layout or scroll engine, so
 * no test here can prove the viewport moved. What IS mechanically checkable is
 * the whole of the contract that makes the link work:
 *
 *   1. the id the link names actually resolves to an element in the document
 *      (this is literally `document.getElementById(...)`, the browser's own
 *      lookup, run against the real rendered page);
 *   2. that element is a <main>, so "skip to the content" also means something
 *      to someone navigating by landmark rather than by Tab;
 *   3. it carries tabindex="-1". Without it a fragment jump to a non-focusable
 *      element only moves the *sequential focus navigation starting point* —
 *      `document.activeElement` stays on <body>, so the next Tab does continue
 *      from the right place but nothing has been focused and a screen reader
 *      is not moved. tabindex="-1" is what makes the target programmatically
 *      focusable, and it does not add it to the Tab order.
 *
 * The id is PARSED OUT of the root layout rather than hardcoded here, so
 * renaming the anchor without renaming the targets fails this file instead of
 * shipping.
 */

import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { ComponentType } from "react";
import { render } from "@testing-library/react";

// next/font is a build-time transform; imported straight into vitest it throws.
vi.mock("@/components/landing/fonts", () => ({ display: { variable: "font-display" } }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams("token=a-token"),
}));

vi.mock("react-hot-toast", () => ({
  default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));

// The server actions are irrelevant to a landmark: mocked so importing a page
// doesn't drag the Prisma client into the test process.
//
// The two verification pages no longer agree, so state it per page rather than
// as one rule. app/verify-email/page.tsx still verifies on mount, so its action
// resolves to nothing on purpose and the "verifying" card is what renders.
// app/verify-email-change/page.tsx waits for a click (auth-015 — that link moves
// the address password resets are delivered to, so a mail scanner fetching it
// used to complete the change), so its mock is never called at all and the
// confirm card is the state under test. Both render the <main id="main"> this
// file asserts, which is why the change did not turn anything red — and is
// exactly why the comment needed correcting rather than trusting the green.
vi.mock("@/lib/actions/auth", () => ({ loginAction: vi.fn(), signupAction: vi.fn() }));
vi.mock("@/lib/actions/password-reset", () => ({
  requestPasswordResetAction: vi.fn(),
  resetPasswordAction: vi.fn(),
}));
vi.mock("@/lib/actions/email-verification", () => ({
  verifyEmailAction: vi.fn(() => new Promise(() => {})),
}));
vi.mock("@/lib/actions/email-change", () => ({
  confirmEmailChangeAction: vi.fn(() => new Promise(() => {})),
}));

import LandingPage from "@/app/page";
import LoginPage from "@/app/login/page";
import SignupPage from "@/app/signup/page";
import ForgotPasswordPage from "@/app/forgot-password/page";
import ResetPasswordPage from "@/app/reset-password/page";
import VerifyEmailPage from "@/app/verify-email/page";
import VerifyEmailChangePage from "@/app/verify-email-change/page";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const APP_DIR = path.join(REPO_ROOT, "app");

const rootLayoutSource = fs.readFileSync(path.join(APP_DIR, "layout.tsx"), "utf8");

/**
 * Blanks out comments while preserving line numbering, so prose that discusses
 * `<main>` — which the app-shell layout and the chat layout both do at length —
 * cannot masquerade as a rendered element. The (?<!:) guard keeps https:// whole.
 * Same helper as tests/lib/layout/rtl.test.ts, for the same reason.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(?<!:)\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

/** The fragment the root layout's skip link points at, e.g. "main". */
function skipLinkTargetId(source: string): string {
  const anchor = stripComments(source).match(/<a\b[^>]*?href="#([A-Za-z][\w:.-]*)"/);
  if (!anchor) throw new Error('app/layout.tsx no longer renders an <a href="#…"> skip link');
  return anchor[1];
}

const TARGET_ID = skipLinkTargetId(rootLayoutSource);

/**
 * Every public route the root layout's skip link renders on, paired with the
 * component that route mounts. `/offline` and `/invite/[token]` are listed in
 * PUBLIC_ROUTES_NOT_RENDERED_HERE below, not here.
 */
const PUBLIC_ROUTES: { route: string; file: string; Page: ComponentType }[] = [
  { route: "/", file: "app/page.tsx", Page: LandingPage },
  { route: "/login", file: "app/login/page.tsx", Page: LoginPage },
  { route: "/signup", file: "app/signup/page.tsx", Page: SignupPage },
  { route: "/forgot-password", file: "app/forgot-password/page.tsx", Page: ForgotPasswordPage },
  { route: "/reset-password", file: "app/reset-password/page.tsx", Page: ResetPasswordPage },
  { route: "/verify-email", file: "app/verify-email/page.tsx", Page: VerifyEmailPage },
  {
    route: "/verify-email-change",
    file: "app/verify-email-change/page.tsx",
    Page: VerifyEmailChangePage,
  },
];

/**
 * Public pages deliberately not rendered above, each with the reason. They are
 * still covered by the source sweep at the bottom of this file.
 */
const PUBLIC_ROUTES_NOT_RENDERED_HERE = new Map<string, string>([
  ["app/offline/page.tsx", "the PWA offline fallback — static, covered by the source sweep"],
  ["app/invite/[token]/page.tsx", "takes an awaited params promise; covered by the source sweep"],
]);

/** Repo-relative, forward-slashed. */
function relPath(file: string): string {
  return path.relative(REPO_ROOT, file).split(path.sep).join("/");
}

/** Every .tsx under app/, recursively. */
function appTsxFiles(dir: string = APP_DIR): string[] {
  const out: string[] = [];
  fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...appTsxFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".tsx")) {
      out.push(full);
    }
  });
  return out;
}

describe("the skip link's target (a11y-008)", () => {
  it("names a fragment target in the root layout", () => {
    expect(rootLayoutSource).toContain("Skip to main content");
    expect(TARGET_ID).toBe("main");
  });

  PUBLIC_ROUTES.forEach(({ route, Page }) => {
    it(`${route} has a main landmark the skip link resolves to`, () => {
      render(<Page />);

      // The browser's own lookup, against the real rendered page.
      const target = document.getElementById(TARGET_ID);
      expect(
        target,
        `Activating "Skip to main content" on ${route} calls document.getElementById("${TARGET_ID}") and gets null, so focus does not move — the link only rewrites the URL fragment.`
      ).not.toBeNull();

      expect(
        target?.tagName.toLowerCase(),
        `${route}'s id="${TARGET_ID}" must be on the <main> landmark, so skipping and landmark navigation agree.`
      ).toBe("main");

      expect(
        target,
        `${route}'s skip target needs tabindex="-1" or the fragment jump moves the focus navigation starting point without focusing anything.`
      ).toHaveAttribute("tabindex", "-1");
    });

    it(`${route} renders exactly one main landmark`, () => {
      render(<Page />);
      expect(document.querySelectorAll("main")).toHaveLength(1);
    });
  });
});

describe("skip-link coverage (a11y-008)", () => {
  it("renders every public page, so a new public route cannot escape the check", () => {
    const rendered = new Set(PUBLIC_ROUTES.map((r) => r.file));
    const uncovered = appTsxFiles()
      .filter((f) => path.basename(f) === "page.tsx")
      .map(relPath)
      // The authenticated group gets its target from app/(app)/layout.tsx.
      .filter((rel) => !rel.startsWith("app/(app)/"))
      .filter((rel) => !rendered.has(rel) && !PUBLIC_ROUTES_NOT_RENDERED_HERE.has(rel));

    expect(
      uncovered,
      `These public routes render the root layout's skip link but nothing here checks their target:\n${uncovered.join("\n")}`
    ).toEqual([]);
  });

  it("still finds every page the render list excuses", () => {
    const stale = Array.from(PUBLIC_ROUTES_NOT_RENDERED_HERE.keys()).filter(
      (rel) => !fs.existsSync(path.join(REPO_ROOT, rel))
    );
    expect(
      stale,
      `Gone or renamed — drop them from PUBLIC_ROUTES_NOT_RENDERED_HERE:\n${stale.join("\n")}`
    ).toEqual([]);
  });
});

/**
 * Files under app/ that render a <main> but are NOT owned by this slice, so the
 * id + tabindex has to be applied by whoever owns them. Keyed by path with the
 * reason, and the staleness test below fails the moment one is fixed — an
 * allowlist that outlives its reason rots into decoration (the same shape as
 * NOT_YET_CONVERTED in tests/lib/layout/rtl.test.ts).
 */
/**
 * Files excused from carrying the skip-link id on their <main>.
 *
 * EMPTY, and that is the point. It held five entries for exactly as long as the
 * a11y-008 fix wave took: four public routes whose <main> was outside the
 * owning agent's file set, plus app/(app)/error.tsx, which rendered a <main>
 * nested inside the app shell's own <main id="main"> — two landmarks and
 * invalid nesting on any authenticated route that errored. That one was demoted
 * to a <div> rather than tagged, because the shell already provides the
 * landmark it sits inside.
 *
 * Keep it empty. The guard below fails if an entry here is already fixed, so an
 * excuse cannot outlive its reason; an entry added for a genuine reason must
 * carry that reason as its value.
 */
const MAIN_WITHOUT_ID_ELSEWHERE = new Map<string, string>([]);

describe("every <main> under app/ is a skip target (a11y-008)", () => {
  /** Files whose source contains a `<main` tag (comments stripped first). */
  function filesRenderingMain(): string[] {
    return appTsxFiles().filter((file) => mainTag(file) !== "");
  }

  function mainTag(file: string): string {
    const tag = stripComments(fs.readFileSync(file, "utf8")).match(/<main[\s>][^>]*>/);
    return tag ? tag[0] : "";
  }

  it("tags every rendered <main> with the skip-link id", () => {
    const offenders = filesRenderingMain()
      .map(relPath)
      .filter((rel) => !MAIN_WITHOUT_ID_ELSEWHERE.has(rel))
      .filter((rel) => !new RegExp(`id="${TARGET_ID}"`).test(mainTag(path.join(REPO_ROOT, rel))));

    expect(
      offenders,
      `These render a <main> the skip link cannot reach:\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("still finds an untagged <main> in every file the allowlist excuses", () => {
    const stale = Array.from(MAIN_WITHOUT_ID_ELSEWHERE.entries())
      .filter(([rel]) => {
        const file = path.join(REPO_ROOT, rel);
        if (!fs.existsSync(file)) return true;
        const tag = mainTag(file);
        // Three ways an excuse goes stale: the file is gone, its <main> is now
        // tagged, or it no longer renders a <main> at all (which is how the
        // app/(app)/error.tsx nesting defect was resolved — by demoting the
        // element, not by tagging it). The last case was invisible to the
        // original check, so a demoted file would have kept its excuse forever.
        if (tag === "") return true;
        return new RegExp(`id="${TARGET_ID}"`).test(tag);
      })
      .map(([rel, reason]) => `${rel} (excused: ${reason})`);

    expect(
      stale,
      `Fixed or gone — delete them from MAIN_WITHOUT_ID_ELSEWHERE:\n${stale.join("\n")}`
    ).toEqual([]);
  });
});

describe("the authenticated shell keeps its skip target (a11y-008)", () => {
  // components/layout/command-palette.tsx queries this id at runtime for its
  // focus trap, so renaming or removing it breaks two things at once.
  it("app/(app)/layout.tsx still puts the id on its <main>", () => {
    const shell = stripComments(fs.readFileSync(path.join(APP_DIR, "(app)", "layout.tsx"), "utf8"));
    const tag = shell.match(/<main[\s>][^>]*>/)?.[0] ?? "";
    expect(tag, "app/(app)/layout.tsx no longer renders a <main>").not.toBe("");
    expect(tag).toContain(`id="${TARGET_ID}"`);
    expect(tag).toContain("tabIndex={-1}");
  });
});
