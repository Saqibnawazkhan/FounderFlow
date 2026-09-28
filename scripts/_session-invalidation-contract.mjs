/**
 * The pass/fail decision behind scripts/smoke-session-invalidation.mjs — pure,
 * browserless and unit-tested. Same split, and for the same reason, as
 * scripts/_local-db.mjs and scripts/_staging-db.mjs: a rule that decides
 * something important belongs somewhere the suite can run it, not inside a
 * script that only executes when somebody remembers to drive a browser.
 *
 * ── WHY IT EXISTS (auth-002) ───────────────────────────────────────────────
 *
 * The probe's pass condition used to be:
 *
 *     const errored = body.includes("Something broke loading this page");
 *     const killed  = (p) => p.errored || p.onLogin;
 *
 * That string is app/(app)/error.tsx. A revoked session landed there because
 * `requireScopedSession()` threw `new Error("Not authenticated")`, and both of
 * that card's CTAs re-enter the same loop — so a user whose password changed on
 * another device was left staring at a permanent error screen whose only exit
 * was typing /login by hand. That IS auth-002. lib/queries/session.ts now calls
 * `redirect("/login")` instead, which is the fix.
 *
 * So the old condition demanded the bug: it passed against the fixed app AND it
 * would have passed against a regression back to the error card. This repo has
 * produced that defect — a test written from the old behaviour rather than the
 * intended one — seven times, and this was the seventh.
 *
 * The rules below are therefore stated in the user's terms: a revoked session
 * gets a NAVIGATION to /login, and the error boundary is a named failure rather
 * than an acceptable alternative.
 *
 * Contract asserted in tests/lib/auth/session-invalidation-probe.test.ts.
 */

/** Copy owned by app/(app)/error.tsx — the auth-002 regression signal. */
export const ERROR_BOUNDARY_TEXT = "Something broke loading this page";

/** Copy owned by app/(app)/tasks/tasks-client.tsx — proof a session is live. */
export const AUTHED_TASKS_TEXT = "Tasks";

/**
 * Every string this probe pattern-matches, and the file that owns it.
 *
 * A probe that greps copy it does not own does NOT start failing when that copy
 * is reworded — it starts matching nothing and reports a clean pass forever.
 * `checkSentinels` turns that silent blindness into a loud stop, and the suite
 * runs it against the real working tree so it fires on the commit that moves the
 * text rather than months later.
 */
export const SENTINELS = [
  {
    file: "app/(app)/error.tsx",
    needle: ERROR_BOUNDARY_TEXT,
    why: "the error-boundary copy this probe treats as the auth-002 REGRESSION signal",
  },
  {
    file: "lib/queries/session.ts",
    needle: 'redirect("/login")',
    why: "the redirect this probe requires as its PASS condition for a revoked session",
  },
  {
    file: "app/(app)/tasks/tasks-client.tsx",
    needle: `>${AUTHED_TASKS_TEXT}</h1>`,
    why: "the heading this probe reads as proof the session was still live BEFORE the mutation",
  },
];

/** The pathname only. `url.includes("/login")` — the old test — also matches a
 *  `?callbackUrl=/login` on a page that loaded perfectly well, which would read
 *  a LIVE session as a killed one and pass the probe for the wrong reason. */
function pathnameOf(url) {
  try {
    return new URL(String(url)).pathname;
  } catch {
    return String(url);
  }
}

/**
 * Classify one page load of /tasks.
 *
 *   "authed"  — the real page rendered, so the session is live
 *   "login"   — Next issued the redirect a revoked session must get
 *   "error"   — the app/(app)/error.tsx dead end, i.e. auth-002 regressed
 *   "unknown" — none of the above; NEVER a pass, in either position
 *
 * The error boundary is checked before the authed heading because the boundary
 * replaces the page content, and "unknown" exists so a blank page or a timeout
 * cannot be mistaken for either a live session or a revoked one.
 */
export function classifyProbe({ url, body }) {
  const pathname = pathnameOf(url);
  const text = String(body ?? "");
  if (pathname === "/login") return "login";
  if (text.includes(ERROR_BOUNDARY_TEXT)) return "error";
  if (pathname === "/tasks" && text.includes(AUTHED_TASKS_TEXT)) return "authed";
  return "unknown";
}

/**
 * Did this half of the smoke prove that revoking a session revokes it?
 *
 * Both halves matter and they fail for opposite reasons, so each gets its own
 * sentence rather than one bare FAIL:
 *
 *   • `before` must be "authed". A probe that was already logged out passes
 *     every invalidation test ever written, having proved nothing.
 *   • `after` must be "login", exactly. "error" is not an acceptable
 *     alternative — it is the dead end auth-002 exists to have removed, and
 *     accepting it is how this probe spent a release asserting the bug.
 */
export function scoreInvalidation(before, after) {
  const problems = [];

  if (before.state !== "authed") {
    problems.push(
      `session was not live BEFORE the mutation (state=${before.state}` +
        `${before.url ? `, url=${before.url}` : ""}) — the probe proved nothing about invalidation`
    );
  }

  if (after.state === "error") {
    problems.push(
      `auth-002 REGRESSION: a revoked session landed in the "${ERROR_BOUNDARY_TEXT}" boundary ` +
        "instead of being redirected to /login. Both of that card's CTAs re-enter the same loop, " +
        "so the user's other device is now a permanent error screen"
    );
  } else if (after.state !== "login") {
    problems.push(
      `revoked session was NOT redirected to /login (state=${after.state}` +
        `${after.url ? `, url=${after.url}` : ""})`
    );
  }

  return { pass: problems.length === 0, problems };
}

/**
 * Are the strings this probe matches on still where it thinks they are?
 *
 * `readFile(relativePath)` returns the file's text, or null if it is gone — so
 * this stays pure and the caller decides whether that is the working tree (the
 * script, and the suite) or a fixture (the tests for the failure paths).
 *
 * Returns `{ ok, message }`. The message is the operator-facing wall of text,
 * headed "RE-POINT THIS CHECK", because the correct response is to update the
 * constants above and re-read the pass conditions — not to investigate the app.
 */
export function checkSentinels(readFile) {
  const broken = [];
  for (const s of SENTINELS) {
    const source = readFile(s.file);
    if (source == null) {
      broken.push(`  ${s.file} — file not found. It holds ${s.why}.`);
    } else if (!String(source).includes(s.needle)) {
      broken.push(`  ${s.file} — no longer contains ${JSON.stringify(s.needle)}, ${s.why}.`);
    }
  }

  if (broken.length === 0) return { ok: true, message: "" };

  return {
    ok: false,
    message: [
      "RE-POINT THIS CHECK — scripts/smoke-session-invalidation.mjs is out of date.",
      "",
      "It decides pass/fail by matching strings that live in other files, and at",
      "least one of them has moved. It CANNOT report a meaningful result in this",
      "state: a silent non-match looks exactly like a pass.",
      "",
      ...broken,
      "",
      "Fix: update the constants in scripts/_session-invalidation-contract.mjs to",
      "the new text, then re-read `scoreInvalidation` to confirm it still",
      "describes the behaviour you want (see the auth-002 note above).",
    ].join("\n"),
  };
}
