/**
 * auth-002 — the smoke probe that had started asserting the bug.
 *
 * `scripts/smoke-session-invalidation.mjs` decides whether a revoked JWT session
 * was really revoked. Its pass condition was:
 *
 *     const errored = body.includes("Something broke loading this page");
 *     const killed  = (p) => p.errored || p.onLogin;
 *
 * That string is app/(app)/error.tsx. A revoked session landed there because
 * `requireScopedSession()` threw `new Error("Not authenticated")`, and both of
 * that card's CTAs re-enter the same loop — so the user's other device became a
 * permanent error screen with no way out but typing /login by hand. THAT is
 * auth-002, and lib/queries/session.ts:118 now calls `redirect("/login")`.
 *
 * So the probe accepted the defect as a pass, and would have gone on accepting
 * it after a regression. It is the seventh instance in this repo of a test
 * written from the old behaviour instead of the intended one — which is why the
 * decision now lives in a pure module (the `scripts/_local-db.mjs` /
 * `scripts/_staging-db.mjs` pattern) and is asserted HERE, where it runs in the
 * suite with no dev server and no browser.
 *
 * The last block is the other half of the brief: a probe that pattern-matches
 * copy owned by other files does not start FAILING when that copy is reworded,
 * it starts matching nothing and reports a clean pass forever. `checkSentinels`
 * is run against the real working tree below, so the day one of those strings
 * moves, the suite says "re-point this check" instead of going quietly blind.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  ERROR_BOUNDARY_TEXT,
  SENTINELS,
  checkSentinels,
  classifyProbe,
  scoreInvalidation,
} from "../../../scripts/_session-invalidation-contract.mjs";

const REPO_ROOT = path.resolve(__dirname, "../../..");

describe("scoreInvalidation — what counts as a revoked session", () => {
  it("passes only when the revoked session is redirected to /login", () => {
    expect(scoreInvalidation({ state: "authed" }, { state: "login" }).pass).toBe(true);
  });

  it("FAILS when the revoked session lands in the error boundary", () => {
    // The assertion the old probe had backwards. This is the whole finding.
    const result = scoreInvalidation({ state: "authed" }, { state: "error" });
    expect(result.pass).toBe(false);
    expect(result.problems.join(" ")).toContain("auth-002");
  });

  it("fails when the session simply survived the revocation", () => {
    expect(scoreInvalidation({ state: "authed" }, { state: "authed" }).pass).toBe(false);
  });

  it("fails on an indeterminate 'after' rather than guessing", () => {
    expect(scoreInvalidation({ state: "authed" }, { state: "unknown" }).pass).toBe(false);
  });

  it("fails when the session was never live BEFORE the mutation", () => {
    // Otherwise the run proves nothing: a probe that was already logged out
    // "passes" every invalidation test ever written.
    const result = scoreInvalidation({ state: "login" }, { state: "login" });
    expect(result.pass).toBe(false);
    expect(result.problems.join(" ")).toMatch(/before/i);
  });
});

describe("classifyProbe — reading the browser's answer", () => {
  it("calls a real /login navigation a redirect", () => {
    expect(
      classifyProbe({ url: "http://localhost:3000/login?callbackUrl=%2Ftasks", body: "Sign in" })
    ).toBe("login");
  });

  it("does NOT call /tasks a redirect just because '/login' appears in the URL", () => {
    // `url.includes("/login")` was the old test. A callbackUrl or any query
    // carrying the string would have read as a killed session.
    expect(classifyProbe({ url: "http://localhost:3000/tasks?from=/login", body: "Tasks" })).toBe(
      "authed"
    );
  });

  it("recognises the error boundary as its own state, not as 'killed'", () => {
    expect(classifyProbe({ url: "http://localhost:3000/tasks", body: ERROR_BOUNDARY_TEXT })).toBe(
      "error"
    );
  });

  it("refuses to call a blank page authed", () => {
    expect(classifyProbe({ url: "http://localhost:3000/tasks", body: "" })).toBe("unknown");
  });
});

describe("checkSentinels — the probe fails loudly when its markers move", () => {
  it("reports a moved marker with 're-point this check', not silence", () => {
    const result = checkSentinels(() => "a file that no longer says any of it");
    expect(result.ok).toBe(false);
    expect(result.message.toLowerCase()).toContain("re-point this check");
    // Every marker named, so the fix is mechanical rather than a hunt.
    for (const s of SENTINELS) expect(result.message).toContain(s.file);
  });

  it("reports a marker whose whole file has been deleted", () => {
    const result = checkSentinels(() => null);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not found/i);
  });

  it("every marker it matches on still exists in this working tree", () => {
    // The live guard. If this goes red, the smoke script is checking for text
    // the app no longer renders — re-point it before trusting another run.
    const result = checkSentinels((rel: string) => {
      try {
        return fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
      } catch {
        return null;
      }
    });
    expect(result.message).toBe("");
    expect(result.ok).toBe(true);
  });
});
