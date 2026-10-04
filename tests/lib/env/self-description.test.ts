/**
 * prodready-016 — `lib/env.ts` must describe its own reach truthfully.
 *
 * WHAT THE FINDING ASKED FOR, AND WHAT IS LEFT OF IT. The audit filed this
 * module as "effectively dead code … only ever reached by robots.txt and
 * sitemap.xml", and asked that a module called environment validation either
 * validate the environment the app depends on, or say plainly what it does not
 * cover. Both halves are answered in the tree already: `appOrigin()` was wired
 * on 2026-09-29 (prodready-004), so eleven modules import this one — including
 * `app/layout.tsx`, the root layout — and the header's first paragraph states in
 * so many words that this is NOT app-wide validation and that the build-time
 * gate in `scripts/vercel-build.mjs` is what actually stands between a
 * misconfigured Production scope and a live deploy.
 *
 * What was NOT answered is the thing that makes a self-description worth
 * reading: whether it is true. When these assertions were written the module
 * said "nine modules now import this one" (eleven did) and listed seven
 * `appOrigin()` call sites, omitting `lib/email/templates/security-notice.ts`.
 * Nothing checked either number.
 *
 * WHY THAT IS NOT COSMETIC. The count is load-bearing prose: it is the sentence
 * that tells the next reader how much of the app a throw in this module takes
 * down. This file throws on a failed parse, on `EMAIL_VERIFICATION_REQUIRED=true`
 * and on a loopback origin in production, and the correct answer to "is that
 * safe?" depends entirely on whether two static routes or every route in the
 * product imports it. An under-count is therefore an under-statement of a blast
 * radius, which is the shape of error CLAUDE.md records twice as having cost
 * real damage — a claim about a safety mechanism that was true when written and
 * silently went stale.
 *
 * SO THE CLAIM IS DERIVED, NOT TRUSTED. The importer set is computed by reading
 * the tree, and the module's own block has to match it exactly, both directions.
 * The spelled-out count in the prose is checked against the same number. And the
 * disclaimer itself is pinned, so the honest-scope answer to this finding cannot
 * be deleted without a named failure.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not require the schema to cover
 * every variable the app reads. The auditor's suggested fix asked for that plus
 * an import from `lib/db.ts` "so it validates at startup", and on this module —
 * which `app/layout.tsx` already pulls into every route — that would turn a
 * missing OPTIONAL variable into a 500 on every page. The required set belongs
 * in `scripts/vercel-build.mjs`, where a missing var fails the BUILD and Vercel
 * keeps serving the previous deployment; `tests/lib/env/build-config.test.ts`
 * covers it there.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";

const ROOT = process.cwd();

function source(relPath: string): string {
  return readFileSync(join(ROOT, relPath), "utf8");
}

const ENV_SRC = source("lib/env.ts");

/* ── the importer set, derived from the tree ─────────────────────────────── */

/**
 * Where an importer may live. `tests/` is excluded because a test importing the
 * module is not a route that a throw takes down, and `scripts/` because
 * `scripts/vercel-build.mjs` deliberately mirrors the decision rather than
 * importing a TS module that pulls in zod.
 */
const WALK_ROOTS = ["app", "lib", "components"];

/**
 * Root-level modules the app loads. Excluded: build-tool configs, which run in
 * node outside the request path, and declaration files.
 */
const ROOT_FILE_SKIP = ["tailwind.config.ts", "vitest.config.ts"];

function walk(dir: string, found: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, found);
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) found.push(full);
  }
  return found;
}

function candidateFiles(): string[] {
  const absolute: string[] = [];
  for (const root of WALK_ROOTS) {
    const full = join(ROOT, root);
    try {
      if (statSync(full).isDirectory()) walk(full, absolute);
    } catch {
      // A root that does not exist is not a failure of this test.
    }
  }
  for (const entry of readdirSync(ROOT, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!/\.tsx?$/.test(entry.name)) continue;
    if (entry.name.endsWith(".d.ts")) continue;
    if (ROOT_FILE_SKIP.indexOf(entry.name) !== -1) continue;
    absolute.push(join(ROOT, entry.name));
  }
  const relative: string[] = [];
  for (const full of absolute) {
    relative.push(
      full
        .slice(ROOT.length + 1)
        .split(sep)
        .join("/")
    );
  }
  return relative;
}

/** Every app module that imports `@/lib/env`, as posix paths, sorted. */
function actualImporters(): string[] {
  const out: string[] = [];
  for (const rel of candidateFiles()) {
    if (rel === "lib/env.ts") continue;
    if (source(rel).indexOf('from "@/lib/env"') !== -1) out.push(rel);
  }
  return out.sort();
}

/* ── the importer set, as the module declares it ─────────────────────────── */

const IMPORTER_MARKER = "IMPORTERS (derived and enforced by";

/**
 * The paths listed under the marker block in `lib/env.ts`. Same shape as the
 * ceiling block that `app-origin-call-sites.test.ts` reads: the marker line,
 * then indented `//   <path>` lines, stopping at the first line that is not one.
 */
function declaredImporters(): string[] {
  const start = ENV_SRC.indexOf(IMPORTER_MARKER);
  expect(
    start,
    `lib/env.ts no longer carries the "${IMPORTER_MARKER}…" block this test reads. It is ` +
      "the module's own statement of how much of the app a throw here takes down; without " +
      "it the statement is unchecked prose again"
  ).toBeGreaterThan(-1);
  const out: string[] = [];
  const lines = ENV_SRC.slice(start).split("\n");
  for (let i = 1; i < lines.length; i++) {
    const match = /^\s*\/\/\s{2,}([\w./[\]-]+\.tsx?)\s*$/.exec(lines[i]!);
    if (!match) break;
    out.push(match[1]!);
  }
  return out.sort();
}

/* ── the count spelled out in the prose ──────────────────────────────────── */

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
};

/**
 * The source with comment leaders removed and whitespace collapsed, so a claim
 * reads as one sentence however prettier happened to wrap it. Without this the
 * sweep below misses the real thing: the count it was written to catch sat at
 * the end of a line, with `// ` between it and the rest of its own sentence.
 */
const ENV_PROSE = ENV_SRC.replace(/\n\s*(?:\/\/|\*)?[ \t]*/g, " ").replace(/\s+/g, " ");

/**
 * Every "<n> modules import this one" claim in the source, as numbers. Digits
 * and spelled-out words both count, because both are how a person writes it.
 */
function statedImporterCounts(): number[] {
  const pattern = /\b([a-z]+|\d+)\s+modules?\s+(?:now\s+)?import(?:s)?\s+this\s+one\b/gi;
  const out: number[] = [];
  let match = pattern.exec(ENV_PROSE);
  while (match !== null) {
    const token = match[1]!.toLowerCase();
    const value = /^\d+$/.test(token) ? Number(token) : NUMBER_WORDS[token];
    if (value !== undefined) out.push(value);
    match = pattern.exec(ENV_PROSE);
  }
  return out;
}

/* ───────────────────────────────────────────────────────────────────────── */

describe("lib/env.ts says plainly what it does not cover", () => {
  /**
   * The honest-scope answer to prodready-016. A module named "environment
   * validation" that checks eight of the ~30 names the app reads has to say so
   * in the place someone reads before trusting it, and has to point at the gate
   * that does carry the required set — otherwise the next reader concludes the
   * environment is checked and stops looking.
   */
  it("disclaims app-wide coverage in the header", () => {
    const header = ENV_SRC.slice(0, ENV_SRC.indexOf('import { z } from "zod";'));
    expect(
      /NOT app-wide validation/i.test(header),
      "lib/env.ts's header must still disclaim app-wide coverage. Dropping that sentence is " +
        "exactly the defect prodready-016 filed: the appearance of environment validation " +
        "without the substance"
    ).toBe(true);
    expect(
      header.indexOf("scripts/vercel-build.mjs"),
      "the header must name scripts/vercel-build.mjs as the gate that actually holds the " +
        "required Production vars, so a reader who needs a guarantee is sent to the file " +
        "that gives one"
    ).toBeGreaterThan(-1);
  });
});

describe("lib/env.ts states its own blast radius truthfully", () => {
  it("declares exactly the modules that import it", () => {
    expect(declaredImporters()).toEqual(actualImporters());
  });

  it("spells out a count that matches, and keeps spelling one out", () => {
    const stated = statedImporterCounts();
    expect(
      stated.length,
      "lib/env.ts must state, in prose, how many modules import it — that sentence is how a " +
        "reader learns a throw here takes every route rather than two static files. Deleting " +
        "it rather than correcting it would silence this assertion"
    ).toBeGreaterThan(0);
    const actual = actualImporters().length;
    for (const value of stated) {
      expect(
        value,
        `lib/env.ts claims ${value} modules import it; ${actual} do. An under-count here ` +
          "under-states the blast radius of the throws in this file"
      ).toBe(actual);
    }
  });
});
