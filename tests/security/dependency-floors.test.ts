/**
 * Structural guard: security floors for the dependencies that ARE the auth gate.
 *
 * THE INCIDENT THIS ENCODES (prodready-007, 2026-09-26). `package.json` pinned
 * `next` to an exact `14.2.5` — roughly thirty patch releases and fifteen months
 * behind — and `next-auth` to `5.0.0-beta.31`. Both carried CRITICAL advisories
 * against the exact mechanism this app relies on for authorization:
 *
 *   • next < 14.2.25 — "Authorization Bypass in Next.js Middleware"
 *     (CVE-2025-29927). A request carrying an `x-middleware-subrequest` header
 *     skips middleware entirely. `middleware.ts` + `authorized()` in
 *     `auth.config.ts` are the ONLY role gate on seven of the eight
 *     member-blocked finance routes (audit finding auth-003: /dashboard,
 *     /expenses, /revenue, /investments, /recurring, /budgets and /activities
 *     call `requireScopedSession()` and nothing else; only /reports calls
 *     `canSeeFinances`). Skipping middleware therefore IS the bypass.
 *   • next < 14.2.35 — "Denial of Service with Server Components", incomplete
 *     fix follow-up. 14.2.35 is the highest floor reachable without leaving the
 *     14.2.x line, so that is the floor we hold.
 *   • next-auth <= 5.0.0-beta.31 — "Configuration errors can cause
 *     existence-based auth checks to fail open (auth object populated with an
 *     error)". `authorized()` does `if (!auth) return false` — an existence
 *     check, verbatim the vulnerable shape.
 *   • @auth/core < 0.41.3 — the email normalizer validates BEFORE Unicode
 *     normalization, so a homoglyph `@` slips past address validation.
 *     Transitive: next-auth pins it exactly, so the floor is held by bumping
 *     next-auth, and this test proves the resolution actually landed.
 *
 * WHY A TEST AND NOT A COMMENT. `npm audit` is advisory, needs a network, and
 * `vercel.json` installs with `--no-audit`. Nothing in the pipeline fails when
 * someone pins back to a vulnerable release to dodge a build error. This file
 * does, offline, in the same suite as everything else.
 *
 * Sibling guards of the same kind: `tests/lib/env/no-prod-credentials.test.ts`
 * (no prod credential on disk) and `tests/lib/db/script-safety.test.ts` (no bare
 * PrismaClient under scripts/).
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = process.cwd();

/**
 * The floors, each carrying the advisory that sets it. Kept as data so a
 * failure message can say WHY the floor exists instead of printing two numbers
 * and leaving the reader to go find the advisory.
 *
 * `dir` is the node_modules path to read the truth from; `dev` marks a
 * devDependency so the declared-range check looks in the right section.
 */
const FLOORS: Array<{
  name: string;
  dir: string;
  floor: string;
  why: string;
  dev?: boolean;
}> = [
  {
    name: "next",
    dir: "next",
    floor: "14.2.35",
    why:
      "CRITICAL CVE-2025-29927 middleware authorization bypass (<14.2.25) — and " +
      "middleware is the only role gate on 7 of the 8 finance routes. Plus cache " +
      "poisoning (<14.2.10), a second authorization bypass (<14.2.15) and DoS via " +
      "Server Components (<14.2.35).",
  },
  {
    name: "next-auth",
    dir: "next-auth",
    floor: "5.0.0-beta.32",
    why:
      "CRITICAL fail-open on existence-based auth checks (<=5.0.0-beta.31), which " +
      "is exactly what authorized() in auth.config.ts performs.",
  },
  {
    name: "@auth/core",
    dir: join("@auth", "core"),
    floor: "0.41.3",
    why:
      "CRITICAL homoglyph @ bypass in the email normalizer (<0.41.3). Transitive " +
      "via next-auth, which pins it exactly — this asserts the pin resolved.",
  },
  {
    name: "eslint-config-next",
    dir: "eslint-config-next",
    floor: "14.2.35",
    why:
      "Not a runtime advisory — held in lockstep with `next` so the lint rules " +
      "match the framework version actually shipping. Drift here is how a " +
      "framework bump quietly stops being linted.",
    dev: true,
  },
];

/**
 * Compare two semver strings. Returns <0, 0 or >0.
 *
 * WHY HAND-ROLLED: `semver` is not a dependency of this project and a guard
 * against supply-chain risk should not add one. The two cases that matter are
 * both traps:
 *
 *   • "14.2.5" vs "14.2.35" — a plain string compare says 14.2.5 is the LARGER
 *     of the two, because '5' > '3'. A naive check therefore PASSES on the
 *     vulnerable version. That is the precise way this guard could have shipped
 *     green and useless, which this repo has done before.
 *   • "5.0.0-beta.31" vs "5.0.0-beta.32" — next-auth v5 is a beta line, so the
 *     prerelease identifiers carry the whole signal. Per semver a numeric
 *     prerelease identifier compares numerically, not lexically ("beta.9" <
 *     "beta.10"), and a version with no prerelease outranks one with it.
 *
 * Style note: index loops and numbered groups, never `matchAll`, `(?<name>…)`
 * or spreading a Set. tsconfig.json sets `lib` but no `target`, so tsc defaults
 * to ES5 where those are TS2802 / TS1503 — they run fine under vitest and fail
 * only at `npm run typecheck`, which is in the pre-push gate.
 */
export function compareVersions(a: string, b: string): number {
  const split = (v: string): { core: number[]; pre: string[] } => {
    const dash = v.indexOf("-");
    const coreText = dash === -1 ? v : v.slice(0, dash);
    const preText = dash === -1 ? "" : v.slice(dash + 1);
    const core = coreText.split(".").map((n) => parseInt(n, 10) || 0);
    while (core.length < 3) core.push(0);
    return { core, pre: preText === "" ? [] : preText.split(".") };
  };

  const left = split(a);
  const right = split(b);

  for (let i = 0; i < 3; i++) {
    const l = left.core[i] ?? 0;
    const r = right.core[i] ?? 0;
    if (l !== r) return l < r ? -1 : 1;
  }

  // A plain release outranks any prerelease of itself: 5.0.0 > 5.0.0-beta.32.
  if (left.pre.length === 0 && right.pre.length === 0) return 0;
  if (left.pre.length === 0) return 1;
  if (right.pre.length === 0) return -1;

  const len = Math.max(left.pre.length, right.pre.length);
  for (let i = 0; i < len; i++) {
    const l = left.pre[i];
    const r = right.pre[i];
    if (l === undefined) return -1; // fewer identifiers = lower precedence
    if (r === undefined) return 1;
    const lNum = /^\d+$/.test(l);
    const rNum = /^\d+$/.test(r);
    if (lNum && rNum) {
      const ln = parseInt(l, 10);
      const rn = parseInt(r, 10);
      if (ln !== rn) return ln < rn ? -1 : 1;
      continue;
    }
    if (lNum !== rNum) return lNum ? -1 : 1; // numeric < alphanumeric
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

/**
 * The lowest version a declared npm range can resolve to. `^14.2.35`,
 * `>=14.2.35` and a bare `14.2.35` all floor at 14.2.35, which is the only
 * property this guard needs — it asserts a floor, it does not model the
 * npm resolver.
 */
export function lowestSatisfying(range: string): string {
  return range
    .trim()
    .replace(/^>=|^[\^~=>]+/, "")
    .trim();
}

/** The version actually on disk, which is the only version that ever runs. */
function installedVersion(dir: string): string {
  const manifest = join(REPO_ROOT, "node_modules", dir, "package.json");
  return JSON.parse(readFileSync(manifest, "utf8")).version as string;
}

const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

describe("the comparator itself (so a passing suite is never a vacuous one)", () => {
  it("does not fall for the 14.2.5 > 14.2.35 string-compare trap", () => {
    // The literal trap this whole file exists to avoid falling into.
    expect("14.2.5" > "14.2.35").toBe(true); // naive compare: wrong
    expect(compareVersions("14.2.5", "14.2.35")).toBeLessThan(0); // ours: right
  });

  it("orders beta identifiers numerically, not lexically", () => {
    expect(compareVersions("5.0.0-beta.31", "5.0.0-beta.32")).toBeLessThan(0);
    expect(compareVersions("5.0.0-beta.9", "5.0.0-beta.10")).toBeLessThan(0);
    expect(compareVersions("5.0.0-beta.32", "5.0.0-beta.32")).toBe(0);
  });

  it("ranks a release above its own prereleases", () => {
    expect(compareVersions("5.0.0", "5.0.0-beta.32")).toBeGreaterThan(0);
    expect(compareVersions("5.0.0-beta.32", "5.1.0-beta.1")).toBeLessThan(0);
    expect(compareVersions("0.41.2", "0.41.3")).toBeLessThan(0);
  });

  it("strips range operators down to the floor they permit", () => {
    expect(lowestSatisfying("^14.2.35")).toBe("14.2.35");
    expect(lowestSatisfying("~14.2.35")).toBe("14.2.35");
    expect(lowestSatisfying(">=14.2.35")).toBe("14.2.35");
    expect(lowestSatisfying("14.2.35")).toBe("14.2.35");
    expect(lowestSatisfying("^5.0.0-beta.32")).toBe("5.0.0-beta.32");
  });
});

describe("security floors on the dependencies that are the auth gate", () => {
  it.each(FLOORS.map((f) => [f.name, f] as const))(
    "%s is installed at or above its advisory floor",
    (_name, f) => {
      const installed = installedVersion(f.dir);
      expect(
        compareVersions(installed, f.floor),
        `${f.name}@${installed} is BELOW the security floor ${f.floor}.\n\n` +
          `Why: ${f.why}\n\n` +
          `Fix: raise it in package.json and reinstall. Do NOT pin back below ` +
          `this floor to dodge a build error — say so out loud instead.`
      ).toBeGreaterThanOrEqual(0);
    }
  );

  it.each(FLOORS.map((f) => [f.name, f] as const))(
    "%s declares a range in package.json that cannot resolve below the floor",
    (_name, f) => {
      const declared = f.dev ? pkg.devDependencies[f.name] : pkg.dependencies[f.name];
      if (declared === undefined) {
        // @auth/core is transitive on purpose: next-auth pins it exactly, and a
        // second declaration here is exactly how those two drift apart. The
        // installed-version assertion above is the real guard for it.
        expect(f.name).toBe("@auth/core");
        return;
      }
      expect(
        compareVersions(lowestSatisfying(declared), f.floor),
        `package.json declares ${f.name}: "${declared}", which permits a version ` +
          `below the security floor ${f.floor}.\n\nWhy: ${f.why}`
      ).toBeGreaterThanOrEqual(0);
    }
  );

  it("keeps next and eslint-config-next on the same minor line", () => {
    // eslint-config-next on a different minor than next is how the Next lint
    // rules quietly stop matching the framework that is actually running.
    const next = installedVersion("next").split(".").slice(0, 2).join(".");
    const cfg = installedVersion("eslint-config-next").split(".").slice(0, 2).join(".");
    expect(cfg).toBe(next);
  });
});
