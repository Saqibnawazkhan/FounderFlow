/**
 * Structural guard: the auto-close sweeper must NOT be reachable as a public
 * Server Action.
 *
 * THE INCIDENT THIS ENCODES (audit finding cron-001). `lib/actions/time.ts`
 * begins with `"use server"` and is imported by four client components. Next.js
 * mints a callable, publicly-routable Server Action id for EVERY export of such
 * a module — not just the ones a component happens to call. `sweepAutoCloseEntries`
 * was written as a cron body: no `auth()`, no role check, no rate limit, and a
 * `where` clause with no `companyId` filter. So an unauthenticated POST with the
 * right action id ended every running timer in every customer workspace at once.
 *
 * Nothing in a diff showed this. The function was never called from the client;
 * being *exported* from a `"use server"` file in the client graph is what
 * published it.
 *
 * The fix is removal from the public surface, not an `auth()` call — see the
 * header of `lib/time/sweep.ts` for why bolting auth on would break the cron
 * instead of securing it.
 *
 * This file discovers the cron route and its import specifier by READING the
 * files, so it keeps working when things are renamed or moved, and it fails
 * loudly rather than passing vacuously if it can no longer find its subjects.
 */

import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const ACTIONS_DIR = join(ROOT, "lib", "actions");
const CRON_DIR = join(ROOT, "app", "api", "cron");
const TIME_ACTIONS = join(ACTIONS_DIR, "time.ts");

/** The function under guard. Named once; every assertion derives from it. */
const SWEEP = "sweepAutoCloseEntries";

const read = (file: string) => readFileSync(file, "utf8");

/**
 * Strip comments before pattern-matching. Without this, the very comments that
 * explain the hazard (including the ones in this test's subjects) would read as
 * the hazard itself and the guard would cry wolf forever.
 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .map((line) => {
      const i = line.indexOf("//");
      return i === -1 ? line : line.slice(0, i);
    })
    .join("\n");
}

/** True when the module carries a top-level `"use server"` directive — i.e.
 *  every one of its exports becomes a network-callable action id. */
function isUseServerModule(source: string): boolean {
  return /^\s*["']use server["']\s*;?\s*$/m.test(codeOnly(source));
}

/** True when the module is a client component. A client importer is what makes
 *  a `"use server"` module's action ids routable from a browser. */
function isUseClientModule(source: string): boolean {
  return /^\s*["']use client["']\s*;?\s*$/m.test(codeOnly(source));
}

/** Collect capture group 1 of every match. Written as an `exec` loop, not
 *  `matchAll`: tsconfig sets no `target`, so iterating an iterator is a
 *  compile error under `npm run typecheck`. */
function allMatches(code: string, pattern: RegExp): string[][] {
  const re = new RegExp(
    pattern.source,
    pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g"
  );
  const out: string[][] = [];
  let m: RegExpExecArray | null = re.exec(code);
  while (m !== null) {
    out.push(m.slice());
    m = re.exec(code);
  }
  return out;
}

/** Exported identifiers: `export function`, `export const/class`, and the names
 *  inside `export { ... }` / `export { ... } from "..."` re-exports. */
function exportedNames(source: string): string[] {
  const code = codeOnly(source);
  const names: string[] = [];
  const add = (name: string) => {
    if (name && names.indexOf(name) === -1) names.push(name);
  };

  allMatches(code, /export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*(\w+)/g).forEach((m) =>
    add(m[1])
  );
  allMatches(code, /export\s+(?:const|let|var|class)\s+(\w+)/g).forEach((m) => add(m[1]));
  allMatches(code, /export\s*\{([^}]*)\}/g).forEach((m) => {
    m[1].split(",").forEach((part) => {
      // `foo as bar` re-exports under `bar`; both halves matter to us.
      part.split(/\s+as\s+/).forEach((piece) => add(piece.trim().replace(/^type\s+/, "")));
    });
  });
  return names;
}

/** Every `.ts`/`.tsx` file under a directory, recursively. */
function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

/** Resolve a `@/...` import specifier to a real file on disk. */
function resolveAlias(specifier: string): string | null {
  if (!specifier.startsWith("@/")) return null;
  const base = join(ROOT, specifier.slice(2));
  for (const candidate of [base + ".ts", base + ".tsx", join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** The `from "..."` specifier of the import statement that pulls in `name`. */
function importSpecifierFor(source: string, name: string): string | null {
  const imports = allMatches(codeOnly(source), /import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g);
  for (let i = 0; i < imports.length; i++) {
    const named = imports[i][1].split(",").map(
      (s: string) =>
        s
          .trim()
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/)[0]
    );
    if (named.indexOf(name) !== -1) return imports[i][2];
  }
  return null;
}

/** The cron route(s) that actually call the sweeper — found, not hardcoded. */
function cronRoutesUsingSweep(): string[] {
  return sourceFiles(CRON_DIR).filter((f) => codeOnly(read(f)).includes(SWEEP));
}

describe("auto-close sweeper is not a public Server Action (cron-001)", () => {
  it("still has the subjects this guard is about", () => {
    // Without this, every assertion below passes vacuously after a rename.
    expect(existsSync(TIME_ACTIONS), TIME_ACTIONS + " is gone — re-point this test").toBe(true);
    expect(
      isUseServerModule(read(TIME_ACTIONS)),
      'lib/actions/time.ts is no longer a "use server" module — re-point this test'
    ).toBe(true);
    // If time.ts stops exporting real actions, the premise of the guard changed.
    const actionExports = exportedNames(read(TIME_ACTIONS)).filter((n) => n.endsWith("Action"));
    expect(actionExports.length, "lib/actions/time.ts exports no actions any more").toBeGreaterThan(
      4
    );
    expect(cronRoutesUsingSweep().length, "no cron route calls " + SWEEP + " any more").toBe(1);
  });

  it("does not export the sweeper from lib/actions/time.ts", () => {
    expect(
      exportedNames(read(TIME_ACTIONS)),
      SWEEP +
        ' is exported from a "use server" module, which gives it a public, ' +
        "unauthenticated POST endpoint. Its query has no companyId filter, so one " +
        "anonymous request closes every running timer in every workspace. Move it to " +
        "lib/time/sweep.ts (a plain server module) — do NOT add auth(), the cron has " +
        "no session."
    ).not.toContain(SWEEP);
  });

  it('does not export the sweeper from ANY "use server" module', () => {
    // Moving the hazard from one action file to another is not a fix.
    const offenders = sourceFiles(ACTIONS_DIR)
      .filter((f) => {
        const src = read(f);
        return isUseServerModule(src) && exportedNames(src).includes(SWEEP);
      })
      .map((f) => relative(ROOT, f));

    expect(offenders, 'these "use server" modules publish ' + SWEEP + " as an action id").toEqual(
      []
    );
  });

  it("has the cron route import the sweeper from a plain (non-action) server module", () => {
    const [route] = cronRoutesUsingSweep();
    const specifier = importSpecifierFor(read(route), SWEEP);
    expect(
      specifier,
      relative(ROOT, route) + " uses " + SWEEP + " without a named import for it"
    ).toBeTruthy();

    const home = resolveAlias(specifier as string);
    expect(home, 'cannot resolve "' + specifier + '" to a file on disk').toBeTruthy();

    const homeSrc = read(home as string);
    expect(
      isUseServerModule(homeSrc),
      relative(ROOT, home as string) +
        ' carries "use server", so importing ' +
        SWEEP +
        " from there republishes the exact endpoint this fix removed"
    ).toBe(false);
    expect(
      exportedNames(homeSrc),
      relative(ROOT, home as string) + " must export " + SWEEP
    ).toContain(SWEEP);
  });

  it("keeps the sweeper's new home out of the client graph", () => {
    // A `"use client"` importer is how an action id becomes reachable from a
    // browser in the first place. The sweeper's module must have no such edge,
    // so the same bug cannot be reintroduced by a stray import.
    const [route] = cronRoutesUsingSweep();
    const specifier = importSpecifierFor(read(route), SWEEP);
    const clientImporters = [
      ...sourceFiles(join(ROOT, "app")),
      ...sourceFiles(join(ROOT, "components")),
    ]
      .filter((f) => {
        const src = read(f);
        return isUseClientModule(src) && importSpecifierFor(src, SWEEP) === specifier;
      })
      .map((f) => relative(ROOT, f));

    expect(clientImporters, "client components importing " + SWEEP).toEqual([]);
  });
});
