/**
 * Structural guard: an export from a `"use server"` module is a PUBLIC HTTP
 * ENDPOINT, so nothing internal may be exported from one.
 *
 * THE INCIDENT THIS ENCODES. `sweepAutoCloseEntries` was the daily cron helper
 * that closes abandoned time entries. It lived in `lib/actions/time.ts` — a
 * `"use server"` module — and it was exported, because the cron route needed to
 * import it. That single `export` keyword published it to the internet.
 *
 * Next.js compiles every export of a `"use server"` module into an action id
 * and registers a POST handler for it. The id is a build-stable hash, it ships
 * inside the client bundle for any page that imports anything from the module,
 * and the handler takes the arguments the client sends. It is not "internal"
 * in any sense the runtime respects. So an anonymous request could invoke:
 *
 *     db.timeEntry.findMany({ where: { clockOutAt: null, ... } })   // no companyId
 *     db.timeEntry.update(...)                                      // for every row found
 *
 * — a global, cross-tenant, unscoped, MUTATING query, with no session check in
 * it, because a cron helper has no session to check. Every open time entry in
 * every customer's workspace, closeable by anyone who could read a JS bundle.
 *
 * WHY THE NAMING CONVENTION IS LOAD-BEARING, NOT COSMETIC. There is no way to
 * mark an export of a `"use server"` module as private — the language has no
 * word for it and Next.js offers no annotation. The only durable defence is
 * that "is this reachable from the internet?" must be answerable by LOOKING at
 * the declaration, in the diff, without opening the caller. `*Action` is that
 * answer: the suffix asserts "I am a user-invocable endpoint and I check
 * permissions myself". An export without it is a claim of privacy that the
 * runtime does not honour, which is why this file refuses it outright rather
 * than trying to judge whether the body happens to be safe.
 *
 * The fix for a helper that a route needs is always the same shape: move the
 * helper into a plain, non-`"use server"` module (`lib/...`) and let both the
 * route and any action import it from there. The module boundary does the work
 * that the `export` keyword cannot.
 *
 * This file walks the directory tree instead of naming modules, so the
 * twenty-fifth action module is covered on the day it lands. The last describe
 * block feeds the detector a reconstruction of the bug, because every
 * assertion above is "the offender list is empty" — which passes just as
 * happily when the detector has stopped working.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { codeOnly, stripComments } from "../harness/source-scan";

const ROOT = process.cwd();

/**
 * Where server actions can live. `lib/actions/` is the convention, but the App
 * Router lets a route own a `"use server"` module beside its page — which
 * `app/(app)/chat/[slug]/actions.ts` does — and a `"use server"` directive is
 * legal in a `.tsx` file too, so neither the directory nor the extension is any
 * protection. Scanning only `lib/` would leave a hole the size of `app/`.
 */
const SCAN_ROOTS = ["lib", "app", "components"];

/**
 * Exports of a `"use server"` module that are NOT named `*Action` and are
 * nonetheless allowed to exist.
 *
 * It is empty, and that is the point. An allow-list that can be appended to in
 * the same commit as the violation it excuses is not a control — so the test
 * below pins its size. Adding an entry means editing a number in a test that
 * says, in its failure message, exactly what you are signing off on. That is
 * the difference between a decision and a drift.
 *
 * Format, if it ever gains an entry: "path/to/module.ts:exportName" — module
 * qualified, never a bare name, so one exemption cannot silently cover a
 * same-named export somewhere else.
 */
const ALLOWED_NON_ACTION_EXPORTS = new Set<string>([
  // (empty — see above. Each future entry needs a comment giving the reason
  // this export is safe to expose as an unauthenticated POST endpoint.)
]);

/** Pinned so growth is deliberate, not incidental. */
const ALLOWED_COUNT = 0;

// `codeOnly` (comments and string CONTENTS blanked) and `stripComments`
// (comments only, so the `"use server"` directive is still a readable string)
// come from tests/lib/harness/source-scan.ts, shared with the two sibling
// guards. The copy that used to live here had audit A49 in it: a `"` inside a
// regex literal read as the start of a string and blanked the rest of the
// module, so an export declared below a shape-check regex vanished from this
// sweep entirely. See `still sees an export declared below a regex literal with
// a quote`.

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, found);
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) found.push(full);
  }
  return found;
}

function rel(path: string): string {
  return path
    .slice(ROOT.length + 1)
    .split(sep)
    .join("/");
}

/**
 * A module-level `"use server"` directive: the first statement in the file,
 * after comments. A directive inside one function body only exports that
 * function, which the same rule covers anyway once it is exported.
 */
function hasServerDirective(sourceWithStrings: string): boolean {
  return /^[\s;]*(?:"use server"|'use server')\s*;/.test(sourceWithStrings);
}

export type ServerModule = { rel: string; code: string };

/** Every `"use server"` module under the scan roots. */
function serverModules(): ServerModule[] {
  return SCAN_ROOTS.flatMap((root) => sourceFiles(join(ROOT, root)))
    .map((file) => {
      const raw = readFileSync(file, "utf8");
      return { rel: rel(file), raw, code: codeOnly(raw) };
    })
    .filter(({ raw }) => hasServerDirective(stripComments(raw)))
    .map(({ rel: r, code }) => ({ rel: r, code }));
}

/**
 * Every exported VALUE binding of a module, plus a complaint for each export
 * form whose names cannot be read statically.
 *
 * Types are exempt and must be: `export type` / `export interface` are erased
 * before Next.js ever sees the module, so they create no endpoint. `enum` is
 * NOT erased and is therefore not exempt.
 *
 * `export *` gets its own complaint rather than being skipped. A star re-export
 * out of a `"use server"` module publishes whatever the other module exports
 * TODAY plus whatever it gains next year, under names nobody wrote here — the
 * exact failure this file exists to prevent, one level of indirection away.
 */
function exportedValueNames(code: string): { names: string[]; opaque: string[] } {
  const names: string[] = [];
  const opaque: string[] = [];

  // Array.from over every matchAll: this tsconfig has no `target`, so tsc
  // defaults to ES5 and `for…of` over an iterator is a TS2802 that vitest
  // never sees. Numbered groups for the same reason — (?<name>…) is TS1503.
  const declared = Array.from(
    code.matchAll(/\bexport\s+(?:(?:async\s+)?function\s*\*?|const|let|var|class|enum)\s+(\w+)/g)
  );
  for (const m of declared) {
    names.push(m[1]!);
  }

  // `export { a, b as c }` — the re-export form. `export type { … }` is erased.
  const lists = Array.from(code.matchAll(/\bexport\s+(type\s+)?\{([^}]*)\}/g));
  for (const m of lists) {
    if (m[1]) continue;
    for (const part of m[2]!.split(",")) {
      const spec = part.trim();
      if (!spec || spec.startsWith("type ")) continue;
      const aliased = /\bas\s+(\w+)\s*$/.exec(spec);
      names.push(aliased ? aliased[1]! : spec);
    }
  }

  if (/\bexport\s+\*/.test(code)) {
    opaque.push("export * — re-exports names this file never wrote");
  }
  if (/\bexport\s+default\b/.test(code)) {
    opaque.push("export default — an endpoint with no name to hold to the convention");
  }

  return { names, opaque };
}

/**
 * Complaints about one module's export surface. Empty means every export
 * announces itself as a user-invocable action.
 */
function exportOffenders(module: ServerModule): string[] {
  const { names, opaque } = exportedValueNames(module.code);
  const offenders = opaque.map((why) => `${module.rel}: ${why}`);

  for (const name of names) {
    if (/Action$/.test(name)) continue;
    if (ALLOWED_NON_ACTION_EXPORTS.has(`${module.rel}:${name}`)) continue;
    offenders.push(`${module.rel}: export "${name}" is not named *Action`);
  }

  return offenders;
}

describe('"use server" export surface (every export is a public POST endpoint)', () => {
  it("finds the action modules at all", () => {
    // Guards the guard. Every assertion below is a loop over this list, so a
    // renamed directory or a broken directive detector turns the whole file
    // into tests that cannot fail — silently, and in green.
    const modules = serverModules();
    expect(
      modules.length,
      'the sweep found almost no "use server" modules — SCAN_ROOTS or the ' +
        "directive detector is wrong, and every check below is now vacuous"
    ).toBeGreaterThan(15);

    // And it must find endpoints inside them, not just files.
    const exports = modules.flatMap((m) => exportedValueNames(m.code).names);
    expect(exports.length, "no exported binding was parsed out of any module").toBeGreaterThan(50);
  });

  it('does not mistake a module that only talks about "use server" for one', () => {
    // Named regression. lib/queries/transactions.ts opens with a doc comment
    // saying it is deliberately NOT a "use server" module, so a detector that
    // reads comments reports every query helper in it as an exposed endpoint —
    // and a reviewer who sees a wall of false positives stops reading the file.
    const found = serverModules().map((m) => m.rel);
    expect(found).not.toContain("lib/queries/transactions.ts");
  });

  it('exports nothing from a "use server" module that is not a user-invocable action', () => {
    // THE regression test. On the tree where `sweepAutoCloseEntries` was still
    // exported from lib/actions/time.ts, this names it.
    const offenders = serverModules().flatMap(exportOffenders);

    expect(
      offenders,
      'Every export of a "use server" module is a callable POST endpoint with a ' +
        "build-stable id that ships in the client bundle. These are exported without " +
        "claiming to be endpoints, so nothing has checked that they authenticate, " +
        "scope to a company, or rate-limit. Move the helper to a plain module under " +
        "lib/ and import it from both sides:\n" +
        offenders.map((o) => `  - ${o}`).join("\n")
    ).toEqual([]);
  });

  it("keeps the exemption list empty, and makes any entry a deliberate edit", () => {
    // An allow-list that can grow in the same commit as the violation it
    // excuses is decoration. Pinning the size means an exemption cannot be
    // added without editing this number — and reading the reason next to it.
    expect(
      ALLOWED_NON_ACTION_EXPORTS.size,
      `ALLOWED_NON_ACTION_EXPORTS has ${ALLOWED_NON_ACTION_EXPORTS.size} entries but ` +
        `ALLOWED_COUNT says ${ALLOWED_COUNT}. If you are adding an exemption: say in a ` +
        `comment why this export is safe as an unauthenticated POST endpoint, then bump ` +
        `ALLOWED_COUNT. If you are removing one: bump it down. Never edit only one side.`
    ).toBe(ALLOWED_COUNT);
  });

  it("holds no stale exemption for an export that no longer exists", () => {
    // A stale entry is not a leftover, it is a standing licence: the next
    // export to take that name inherits the exemption without anyone deciding.
    const live = new Set(
      serverModules().flatMap((m) => exportedValueNames(m.code).names.map((n) => `${m.rel}:${n}`))
    );
    const stale = Array.from(ALLOWED_NON_ACTION_EXPORTS).filter((e) => !live.has(e));
    expect(stale, `exempted exports that no longer exist: ${stale.join(", ")}`).toEqual([]);
  });
});

describe("the detector itself (a sweep is only worth its false-negative rate)", () => {
  // Every assertion above reports an empty list, which is also what a broken
  // detector reports. The real files cannot demonstrate otherwise while they
  // are correct, so the violation lives here — a reconstruction of
  // lib/actions/time.ts as it shipped, cron helper and all.
  const TIME_TS_AS_IT_SHIPPED = `"use server";

/**
 * Time-tracking server actions. This comment mentions "use server" and
 * sweepAutoCloseEntries, and vouching for neither is the point.
 */
import { db } from "@/lib/db";

export interface SweepResult {
  attempted: number;
}

export async function clockInAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return { success: true, data: { id: "x" } };
}

/** Cron handler — runs daily (see vercel.json). */
export async function sweepAutoCloseEntries(): Promise<SweepResult> {
  const stale = await db.timeEntry.findMany({ where: { clockOutAt: null } });
  return { attempted: stale.length };
}
`;

  const asModule = (source: string): ServerModule => ({
    rel: "lib/actions/fixture.ts",
    code: codeOnly(source),
  });

  it("reports the cron helper that shipped as a public endpoint", () => {
    const offenders = exportOffenders(asModule(TIME_TS_AS_IT_SHIPPED));
    expect(offenders).toEqual([
      'lib/actions/fixture.ts: export "sweepAutoCloseEntries" is not named *Action',
    ]);
  });

  it("does not report the action beside it, nor the erased type", () => {
    // `clockInAction` is fine, and `export interface SweepResult` is erased
    // before Next.js sees the module, so it creates no endpoint. A detector
    // that flagged either would be rewritten into uselessness within a week.
    const offenders = exportOffenders(asModule(TIME_TS_AS_IT_SHIPPED));
    expect(offenders.join("\n")).not.toContain("clockInAction");
    expect(offenders.join("\n")).not.toContain("SweepResult");
  });

  it("is not fooled by a doc comment that only discusses the directive", () => {
    // The lib/queries/transactions.ts shape, as a fixture rather than a name,
    // so the behaviour survives that file being renamed or deleted.
    const discussesOnly = `/**
 * Read-side queries. Mirrors lib/actions/transactions.ts but with no
 * "use server" round-trip — just data.
 */
export async function listTransactions() {
  return [];
}
`;
    expect(hasServerDirective(stripComments(discussesOnly))).toBe(false);
    expect(hasServerDirective(stripComments(TIME_TS_AS_IT_SHIPPED))).toBe(true);
  });

  it("reads past a leading directive that is not first, but still module-level", () => {
    // `"use client"` first would mean this is not a server module at all; a
    // stray semicolon or blank line before the directive must not hide it.
    expect(hasServerDirective(stripComments(`\n\n  "use server";\nexport {};\n`))).toBe(true);
    expect(hasServerDirective(stripComments(`"use client";\n"use server";\n`))).toBe(false);
  });

  it("catches the export forms that hide a name", () => {
    const star = asModule(`"use server";\nexport * from "@/lib/time/sweep";\n`);
    expect(exportOffenders(star)).toEqual([
      "lib/actions/fixture.ts: export * — re-exports names this file never wrote",
    ]);

    const dflt = asModule(`"use server";\nexport default async function () {}\n`);
    expect(exportOffenders(dflt)).toEqual([
      "lib/actions/fixture.ts: export default — an endpoint with no name to hold to the convention",
    ]);
  });

  it("catches a helper smuggled out through a re-export list or a const", () => {
    // `export async function` is the shape the repo uses, so it is the shape a
    // detector gets tuned to. These two are the same endpoint by another road.
    const viaList = asModule(
      `"use server";\nasync function sweepEntries() {}\nexport { sweepEntries };\n`
    );
    expect(exportOffenders(viaList)).toEqual([
      'lib/actions/fixture.ts: export "sweepEntries" is not named *Action',
    ]);

    const viaConst = asModule(`"use server";\nexport const sweepEntries = async () => {};\n`);
    expect(exportOffenders(viaConst)).toEqual([
      'lib/actions/fixture.ts: export "sweepEntries" is not named *Action',
    ]);

    // And an alias must be judged on the name it is PUBLISHED under, since
    // that is the one the action id is minted for.
    const viaAlias = asModule(
      `"use server";\nasync function sweep() {}\nexport { sweep as sweepAction };\n`
    );
    expect(exportOffenders(viaAlias)).toEqual([]);
  });

  it("still sees an export declared below a regex literal with a quote", () => {
    // Audit A49. The scanner read the double quote inside the character class
    // as the start of a string literal and blanked the rest of the module, so
    // the export below it vanished and this guard — the one whose whole job is
    // to notice a helper published as a public POST endpoint — reported nothing.
    const withRegex = asModule(`"use server";
const SAFE_LABEL = /[^<>"@]+/;
export async function sweepEntries() {}
`);
    expect(exportOffenders(withRegex)).toEqual([
      'lib/actions/fixture.ts: export "sweepEntries" is not named *Action',
    ]);
  });

  it("does not credit a name that only appears inside a string", () => {
    const stringOnly = asModule(
      `"use server";\nconst msg = "export async function sweepEntries";\nexport async function okAction() {}\n`
    );
    expect(exportOffenders(stringOnly)).toEqual([]);
  });
});
