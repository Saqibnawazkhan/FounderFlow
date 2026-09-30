/**
 * The contract: a Server Component may import a COMPONENT from a `"use client"`
 * module, and it may import types. It may not import a runtime VALUE.
 *
 * ── THE BUG THIS ENCODES (the /dashboard crash, reported from the product) ──
 *
 * `app/(app)/dashboard/page.tsx` did:
 *
 *   import { BURN_WINDOW_MONTHS, CASH_FLOW_MONTHS, DashboardClient }
 *     from "./dashboard-client";                 // <- "use client" module
 *   ...
 *   getTransactionTotals({ from: utcMonthsAgo(now, BURN_WINDOW_MONTHS) })
 *
 * Across the RSC boundary React does not hand the server the *value* `3`. Every
 * export of a `"use client"` module becomes a client-reference proxy, so on the
 * server `BURN_WINDOW_MONTHS` is `{}` with `typeof === "object"`. Measured, from
 * a probe in the running dev server:
 *
 *   [A3 PROBE] BURN_WINDOW_MONTHS = {} typeof object
 *              utcMonthsAgo(now, BURN) = Invalid Date
 *
 * `utcMonthsAgo(now, {})` arithmetics to NaN and returns an Invalid Date, which
 * reached Prisma and threw, taking the whole page down to the (app) error
 * boundary:
 *
 *   Invalid `prisma.transaction.groupBy()` invocation:
 *     where: { companyId: "demo-nimbus", date: { gte: new Date("Invalid Date") } }
 *   Invalid value for argument `gte`: Provided Date object is invalid.
 *
 * TypeScript cannot see this: to `tsc` the import is a plain `const 3`, so the
 * whole thing typechecks and the home screen 500s. Only a structural check
 * catches it, which is why this test reads the source rather than rendering.
 *
 * The same mistake silently mis-shaped the cash-flow chart in the same commit:
 * `getMonthlyTotals(CASH_FLOW_MONTHS, now)` was called with `{}` rather than 6.
 *
 * Fixed by moving both constants into `app/(app)/dashboard/windows.ts`, a plain
 * module both sides can import.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../..");
const SCANNED = ["app", "components", "lib"];

const toPosix = (p: string) => path.resolve(p).split(path.sep).join("/");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === ".git") continue;
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(entry)) out.push(p);
  }
  return out;
}

/** `"use client"` must be the first statement, so only the head can carry it. */
function declaresUseClient(source: string): boolean {
  return /^\s*(["'])use client\1/m.test(source.slice(0, 400));
}

const files: string[] = [];
for (const dir of SCANNED) files.push(...walk(path.join(ROOT, dir)));

const clientModule = new Map<string, boolean>();
const sources = new Map<string, string>();
for (const f of files) {
  const src = readFileSync(f, "utf8");
  sources.set(toPosix(f), src);
  clientModule.set(toPosix(f), declaresUseClient(src));
}

/** Resolve a relative or `@/` specifier to one of the files we indexed. */
function resolveSpecifier(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith(".")) base = path.resolve(path.dirname(fromFile), spec);
  else if (spec.startsWith("@/")) base = path.resolve(ROOT, spec.slice(2));
  else return null;
  const candidates = [
    `${base}.tsx`,
    `${base}.ts`,
    path.join(base, "index.tsx"),
    path.join(base, "index.ts"),
  ];
  // Indexed loop: tsconfig sets `lib` but no `target`, so tsc emits ES5 and
  // `for…of` over an array literal is this repo's standing trap (CLAUDE.md).
  for (let i = 0; i < candidates.length; i++) {
    const key = toPosix(candidates[i]);
    if (clientModule.has(key)) return key;
  }
  return null;
}

/** A PascalCase binding is a component and crosses the boundary legitimately. */
const isComponentName = (name: string) => /^[A-Z][A-Za-z0-9]*$/.test(name);

type Violation = { file: string; spec: string; bindings: string[] };

function valueImportsFromClientModules(): Violation[] {
  const violations: Violation[] = [];
  // `[^;'"]*?` for the clause is load-bearing: excluding quotes and semicolons
  // stops the match running past a preceding side-effect import
  // (`import "./globals.css";`) and reporting `"./globals.css";\nimport` as a
  // binding, which an earlier draft of this scan did.
  const importRe = /import\s+((?:type\s+)?[^;'"]*?)\s+from\s+["']([^"']+)["']/g;

  for (let f = 0; f < files.length; f++) {
    const file = files[f];
    const abs = toPosix(file);
    if (clientModule.get(abs)) continue; // client -> client is fine
    const src = sources.get(abs) as string;

    let m: RegExpExecArray | null;
    importRe.lastIndex = 0;
    while ((m = importRe.exec(src)) !== null) {
      const clause = m[1].trim();
      const spec = m[2];
      if (clause.startsWith("type ")) continue; // `import type { … }`
      const target = resolveSpecifier(file, spec);
      if (!target || !clientModule.get(target)) continue;

      const bindings: string[] = [];
      const named = clause.match(/\{([\s\S]*)\}/);
      if (named) {
        const parts = named[1].split(",");
        for (let i = 0; i < parts.length; i++) {
          const raw = parts[i].trim();
          if (!raw || raw.startsWith("type ")) continue; // inline `type X`
          bindings.push(raw.split(/\s+as\s+/)[0].trim());
        }
      }
      const defaultBinding = clause
        .replace(/\{[\s\S]*\}/, "")
        .replace(/,/g, "")
        .trim();
      if (defaultBinding && !defaultBinding.startsWith("*")) bindings.unshift(defaultBinding);

      const offending = bindings.filter((b) => !isComponentName(b));
      if (offending.length) {
        violations.push({
          file: path.relative(ROOT, file).split(path.sep).join("/"),
          spec,
          bindings: offending,
        });
      }
    }
  }
  return violations;
}

describe("the RSC client boundary", () => {
  it("indexed the tree it claims to scan", () => {
    // Guards the guard: a walk that silently found nothing would make every
    // assertion below vacuously true — this repo's most recurrent defect.
    expect(files.length).toBeGreaterThan(200);
    expect(Array.from(clientModule.values()).filter(Boolean).length).toBeGreaterThan(30);
    // The specific pair that crashed /dashboard must be reachable by the scan.
    expect(sources.has(toPosix(path.join(ROOT, "app/(app)/dashboard/page.tsx")))).toBe(true);
    expect(
      clientModule.get(toPosix(path.join(ROOT, "app/(app)/dashboard/dashboard-client.tsx")))
    ).toBe(true);
  });

  it("no server module imports a runtime value from a 'use client' module", () => {
    const violations = valueImportsFromClientModules();
    const report = violations
      .map((v) => `  ${v.file}\n    from ${v.spec}\n    value bindings: ${v.bindings.join(", ")}`)
      .join("\n");
    expect(
      violations,
      `A "use client" module's exports become client-reference proxies ({}) on the ` +
        `server, not values. These imports read as numbers/strings/functions to tsc ` +
        `and are {} at runtime:\n${report}\n` +
        `Move the value into a module WITHOUT "use client" and import it from there.`
    ).toEqual([]);
  });

  it("the dashboard's window sizes are real numbers on the server", () => {
    // The page must get its window sizes from a non-client module, or the burn
    // cutoff is an Invalid Date and the whole dashboard 500s.
    const pageSrc = sources.get(toPosix(path.join(ROOT, "app/(app)/dashboard/page.tsx"))) as string;
    expect(pageSrc).toBeTypeOf("string");

    const importOfConstants =
      /import\s+\{[^}]*\bBURN_WINDOW_MONTHS\b[^}]*\}\s+from\s+["']([^"']+)["']/.exec(pageSrc);
    expect(
      importOfConstants,
      "app/(app)/dashboard/page.tsx no longer imports BURN_WINDOW_MONTHS — update this test"
    ).not.toBeNull();

    const source = resolveSpecifier(
      path.join(ROOT, "app/(app)/dashboard/page.tsx"),
      (importOfConstants as RegExpExecArray)[1]
    );
    expect(source, `could not resolve ${(importOfConstants as RegExpExecArray)[1]}`).not.toBeNull();
    expect(
      clientModule.get(source as string),
      `page.tsx imports BURN_WINDOW_MONTHS from ${(importOfConstants as RegExpExecArray)[1]}, ` +
        `which declares "use client" — so the server receives {} and not a number.`
    ).toBe(false);
  });
});
