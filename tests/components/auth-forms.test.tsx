/**
 * Public auth forms — a credential must never be able to reach a URL.
 * (FaultsAudit A14.)
 *
 * The bug: an auth `<form>` that declares no `method` performs a NATIVE submit
 * when a click lands before React has hydrated, and a native submit defaults to
 * GET. It was caught in a dev-server log as
 * `GET /login?email=demo%40founderflow.app&password=demo123` — a live password
 * in the query string, and from there in the access log, in browser history,
 * and in the `Referer` of whatever loaded next. It needs only a slow first
 * paint, which is why `scripts/smoke-tasks-calendar.mjs` and
 * `scripts/smoke-chat.mjs` both retry sign-in.
 *
 * WHAT THESE TESTS CANNOT DO: reproduce that submit. Testing-library renders an
 * already-hydrated tree, so there is no pre-hydration window in jsdom to click
 * inside. The honest proxy is `renderToStaticMarkup` — byte for byte the markup
 * the server sends and the browser holds while the bundle is still in flight,
 * with no effect having run in it. So the tests below assert the two properties
 * of THAT markup which make a native submit harmless (POST) and impossible
 * (disabled), and back them with a source-level sweep that catches the sixth
 * auth form somebody adds next year.
 *
 * The three checks are pure functions over source or markup, and the last
 * describe block feeds them a deliberately vulnerable form. A sweep that
 * reports "no offenders" because its detector is broken is worse than no sweep,
 * and that is not something the real files can demonstrate while they are
 * correct.
 */

import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { render } from "@testing-library/react";

// next/font is a build-time transform; imported straight into vitest it throws.
vi.mock("@/components/landing/fonts", () => ({ display: { variable: "font-display" } }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams("token=a-reset-token"),
}));

vi.mock("react-hot-toast", () => ({
  default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));

// The server actions are irrelevant here — these tests are about the markup the
// browser gets, not what happens once the form reaches the server.
vi.mock("@/lib/actions/auth", () => ({ loginAction: vi.fn(), signupAction: vi.fn() }));
vi.mock("@/lib/actions/password-reset", () => ({
  requestPasswordResetAction: vi.fn(),
  resetPasswordAction: vi.fn(),
}));
vi.mock("@/lib/actions/team", () => ({ acceptInviteAction: vi.fn() }));

import LoginPage from "@/app/login/page";
import SignupPage from "@/app/signup/page";
import ForgotPasswordPage from "@/app/forgot-password/page";
import ResetPasswordPage from "@/app/reset-password/page";
import { AcceptInviteClient } from "@/app/invite/[token]/accept-invite-client";

const REPO_ROOT = path.resolve(__dirname, "../..");
const APP_DIR = path.join(REPO_ROOT, "app");

/**
 * The sweep covers PUBLIC routes only. The credential forms inside the `(app)`
 * group — change-password, delete-account — are opened by a click on a page
 * that has already hydrated, so they have no pre-hydration window to lose a
 * password in. Saying that here beats letting a reader assume they were missed.
 */
const AUTHENTICATED_GROUP = `${path.sep}(app)${path.sep}`;

/** A field whose value must never be written into a URL. */
const CREDENTIAL_FIELD =
  /autoComplete="(?:current-password|new-password|email)"|type=(?:"password"|\{[^}]*"password"[^}]*\})/;

function tsxFilesUnder(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) tsxFilesUnder(full, found);
    else if (entry.name.endsWith(".tsx")) found.push(full);
  }
  return found;
}

/**
 * Comments out. These files argue about `<form>` and `method="post"` in prose —
 * the first run of this sweep reported login as an offender because it had
 * parsed the `<form>` inside the doc comment explaining the fix. A scan that
 * reads comments can lie in both directions: a tag that is only discussed, and
 * an attribute that is only promised.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments, including {/* … */}
    .replace(/^[ \t]*\/\/.*$/gm, ""); // whole-line // comments
}

/** Every public page that renders a form containing a credential field. */
function credentialFormFiles(): { rel: string; source: string }[] {
  return tsxFilesUnder(APP_DIR)
    .filter((file) => !file.includes(AUTHENTICATED_GROUP))
    .map((file) => ({
      rel: path.relative(REPO_ROOT, file).split(path.sep).join("/"),
      source: stripComments(fs.readFileSync(file, "utf8")),
    }))
    .filter(({ source }) => source.includes("<form") && CREDENTIAL_FIELD.test(source));
}

/**
 * The opening `<tag …>` of every occurrence. Brace-aware, so an inline arrow
 * (`onSubmit={(e) => …}`) cannot truncate a tag at its own `>` and make this
 * report a missing attribute that is actually there.
 */
function openingTags(source: string, tagName: string): string[] {
  const tags: string[] = [];
  const opener = `<${tagName}`;
  let start = source.indexOf(opener);
  while (start !== -1) {
    let depth = 0;
    let end = start;
    while (end < source.length) {
      const ch = source[end];
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
      else if (ch === ">" && depth === 0) break;
      end += 1;
    }
    tags.push(source.slice(start, end + 1));
    start = source.indexOf(opener, end);
  }
  return tags;
}

/** Complaints about a source file's `<form>` tags. Empty means safe. */
function methodOffenders(where: string, source: string): string[] {
  const forms = openingTags(source, "form");
  if (forms.length === 0) return [`${where}: has a credential field but no <form> tag was parsed`];
  return forms
    .filter((tag) => !tag.includes('method="post"'))
    .map(() => `${where}: <form> with no method="post" — a native submit would GET`);
}

/**
 * Complaints about a source file's submit buttons. `!hydrated` is the
 * convention (see the useHydrated doc comment in app/login/page.tsx); asserting
 * the name here is what pushes a future auth form into the same shape.
 */
function gateOffenders(where: string, source: string): string[] {
  return openingTags(source, "button")
    .filter((tag) => tag.includes('type="submit"'))
    .filter((tag) => !/disabled=\{[^}]*!hydrated/.test(tag))
    .map(() => `${where}: <button type="submit"> is live before React arrives`);
}

/** Complaints about rendered first-paint markup, plus how much it examined. */
function firstPaintOffenders(
  where: string,
  html: string
): { offenders: string[]; gatedButtons: number } {
  const offenders: string[] = [];
  let gatedButtons = 0;

  const forms = openingTags(html, "form");
  // A surface that renders no form at all would sail through every check below
  // while telling us nothing, which is the shape of a sweep that has quietly
  // stopped looking.
  if (forms.length === 0) offenders.push(`${where}: rendered no <form> to inspect`);
  for (const tag of forms) {
    if (!tag.includes('method="post"')) {
      offenders.push(`${where}: server-rendered a <form> that would GET`);
    }
  }

  for (const tag of openingTags(html, "button")) {
    if (!tag.includes('type="submit"')) continue;
    // React serialises `disabled={true}` as `disabled=""`; matching that
    // exactly avoids a false pass on a `disabled:` tailwind variant.
    if (!/\bdisabled=""/.test(tag)) {
      offenders.push(`${where}: submit button is clickable in the first-paint HTML`);
      continue;
    }
    gatedButtons += 1;
    // The UX call, asserted rather than left in a comment: inert, but not
    // visibly dead. A control that dims for the first frames of every cold load
    // is worse than one that looks normal and ignores a click nobody could have
    // aimed yet.
    if (tag.includes("disabled:opacity")) {
      offenders.push(`${where}: submit button renders visibly disabled before hydration`);
    }
  }

  return { offenders, gatedButtons };
}

/** Every auth surface that can be rendered standalone, with its route. */
const AUTH_SURFACES: { route: string; element: ReactElement }[] = [
  { route: "/login", element: <LoginPage /> },
  { route: "/signup", element: <SignupPage /> },
  { route: "/forgot-password", element: <ForgotPasswordPage /> },
  { route: "/reset-password", element: <ResetPasswordPage /> },
  {
    route: "/invite/[token]",
    element: (
      <AcceptInviteClient
        token="an-invite-token"
        inviteeName="Ada Byron"
        inviteeEmail="ada@x.dev"
      />
    ),
  },
];

describe("public auth forms (every page that takes a password or an email)", () => {
  // Walks the route tree instead of naming five paths. The value is entirely in
  // the walk: a sixth auth form, copied from the same template a year from now,
  // fails here instead of shipping A14 again.
  it("declares a post method so an unhydrated submit cannot put credentials in a URL", () => {
    const files = credentialFormFiles();
    expect(
      files.length,
      "the sweep found no public credential form at all — it is looking in the wrong place"
    ).toBeGreaterThan(0);

    const offenders = files.flatMap(({ rel, source }) => methodOffenders(rel, source));

    expect(offenders, `credentials could reach a URL from:\n  ${offenders.join("\n  ")}`).toEqual(
      []
    );
  });

  it("keeps every submit button inert until a hydration effect has run", () => {
    const files = credentialFormFiles();
    const examined = files.flatMap(({ source }) =>
      openingTags(source, "button").filter((tag) => tag.includes('type="submit"'))
    );
    expect(
      examined.length,
      "no submit button was examined — the tag walk found nothing"
    ).toBeGreaterThan(0);

    const offenders = files.flatMap(({ rel, source }) => gateOffenders(rel, source));

    expect(offenders, `ungated submit buttons:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });
});

describe("auth first paint (the markup the browser holds before React arrives)", () => {
  // renderToStaticMarkup runs no effects, so this IS the pre-hydration DOM.
  it("does not submit before the form has hydrated", () => {
    const offenders: string[] = [];
    let gatedButtons = 0;

    for (const { route, element } of AUTH_SURFACES) {
      const result = firstPaintOffenders(route, renderToStaticMarkup(element));
      offenders.push(...result.offenders);
      gatedButtons += result.gatedButtons;
    }

    expect(
      gatedButtons,
      "no first-paint submit button was found — the renders produced nothing to gate"
    ).toBeGreaterThan(0);
    expect(offenders, `first paint is unsafe on:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  // The gate has to open again, or the fix is just a broken sign-in page. The
  // smoke scripts would catch that, but minutes later and with a stack trace
  // that blames the browser.
  it("re-arms the submit button once the hydration effect has run", () => {
    let rearmed = 0;

    for (const { route, element } of AUTH_SURFACES) {
      const { container } = render(element);
      for (const button of Array.from(
        container.querySelectorAll<HTMLButtonElement>('button[type="submit"]')
      )) {
        expect(
          button,
          `${route}: submit button never came back after hydration`
        ).not.toBeDisabled();
        rearmed += 1;
      }
    }

    expect(rearmed, "no hydrated submit button was found to check").toBeGreaterThan(0);
  });
});

describe("the A14 detectors (the sweeps are only worth their false-negative rate)", () => {
  // Every assertion above is "the list of offenders is empty". That passes just
  // as happily when the detector is broken, and the real files cannot show
  // otherwise while they are correct — so the vulnerable form lives here.
  const VULNERABLE_SOURCE = `
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-5" noValidate>
      <input type="password" autoComplete="current-password" {...register("password")} />
      <button type="submit" disabled={isSubmitting}>Sign in</button>
    </form>`;

  const FIXED_SOURCE = `
    <form method="post" onSubmit={handleSubmit(onSubmit)} className="space-y-5" noValidate>
      <input type="password" autoComplete="current-password" {...register("password")} />
      <button type="submit" disabled={!hydrated || isSubmitting}>Sign in</button>
    </form>`;

  it("reports a form that would put a password in the query string", () => {
    expect(methodOffenders("fixture", VULNERABLE_SOURCE)).toHaveLength(1);
    expect(methodOffenders("fixture", FIXED_SOURCE)).toEqual([]);
  });

  it("reports a submit button that is live before hydration", () => {
    expect(gateOffenders("fixture", VULNERABLE_SOURCE)).toHaveLength(1);
    expect(gateOffenders("fixture", FIXED_SOURCE)).toEqual([]);
  });

  it("reports first-paint markup whose submit button is clickable", () => {
    const live = firstPaintOffenders(
      "/fixture",
      '<form method="post"><button type="submit">Go</button></form>'
    );
    expect(live.offenders).toHaveLength(1);
    expect(live.gatedButtons).toBe(0);

    const gated = firstPaintOffenders(
      "/fixture",
      '<form method="post"><button type="submit" disabled="">Go</button></form>'
    );
    expect(gated.offenders).toEqual([]);
    expect(gated.gatedButtons).toBe(1);
  });

  it("reports first-paint markup that advertises the gate as a dead control", () => {
    const dimmed = firstPaintOffenders(
      "/fixture",
      '<form method="post"><button type="submit" disabled="" class="disabled:opacity-60">Go</button></form>'
    );
    expect(dimmed.offenders).toHaveLength(1);
  });

  // The detector reads code, not prose. A form that only TALKS about the fix
  // must still be reported — this is the bug the first run of the sweep hit.
  it("does not let a comment vouch for a form", () => {
    const allTalk = `
      /** This form uses method="post" and disabled={!hydrated}. Honest. */
      ${VULNERABLE_SOURCE}`;
    const source = stripComments(allTalk);
    expect(methodOffenders("fixture", source)).toHaveLength(1);
    expect(gateOffenders("fixture", source)).toHaveLength(1);
  });
});
