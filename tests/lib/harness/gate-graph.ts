/**
 * The call graph the auth guards walk, extracted so there is ONE of it.
 *
 * WHAT THIS IS FOR. Two structural guards need the same question answered —
 * "starting from this function body, is a session resolved anywhere within N
 * helper calls?" — and they ask it about different starting points:
 *
 *   - tests/lib/actions/action-auth-gates.test.ts starts at every export of a
 *     `"use server"` module. A `"use server"` export is a POST endpoint anyone
 *     can invoke, so an ungated one is a hole straight to the database.
 *   - tests/ops/page-auth.test.ts starts at every `app/(app)/**` page. A page is
 *     gated by middleware too, but CLAUDE.md requires the two layers to agree
 *     and nothing checked that they did.
 *
 * The question is the same and the traversal is fiddly — import resolution,
 * brace balancing past a generic return annotation, local helpers that are never
 * exported. This repo has already paid twice for letting a fiddly scanner exist
 * in more than one copy (audit A40 and A49, both silent under-scans in duplicated
 * comment strippers), so this one lives in a single module.
 *
 * WHY IT IS NOT A `*.test.ts`. Importing from a test file re-registers that
 * file's describe blocks inside the importer. `vitest.config.ts` collects only
 * `tests/**` paths ending in `.test.ts`/`.test.tsx`, so a plain `.ts` module here
 * is shared code.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It is a text graph, not a type checker. It
 * does not know about control flow, so a gate inside `if (false)` counts; it does
 * not follow a call through a variable, an object property or a higher-order
 * function; and it only knows the declaration forms this repo actually uses
 * (`function`, `async function`, exported or not). Each of those is a
 * false-NEGATIVE risk for the guards built on it — they can say "gated" about
 * something subtler than they understand — which is why both callers keep the hop
 * limit small and assert the reverse direction on fixtures.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { codeOnly, stripComments } from "./source-scan";

export type Mod = {
  /** posix path relative to the repo root — the key everything else uses. */
  rel: string;
  /** comments AND string contents blanked: what to read code out of. */
  code: string;
  /** comments blanked, strings intact: for directives and import specifiers. */
  text: string;
};

/**
 * Every module, keyed by relative path. A plain Map rather than the filesystem
 * so a guard's fixtures drive the exact same resolver the real tree does — a
 * detector proven on a different code path is proven of nothing.
 */
export type Universe = Map<string, Mod>;

/** Every `.ts`/`.tsx` file under `dir`, skipping build output and declarations. */
export function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, found);
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) found.push(full);
  }
  return found;
}

export function makeUniverse(sources: Record<string, string>): Universe {
  const universe: Universe = new Map();
  const entries = Object.entries(sources);
  for (const pair of entries) {
    universe.set(pair[0], {
      rel: pair[0],
      code: codeOnly(pair[1]),
      text: stripComments(pair[1]),
    });
  }
  return universe;
}

/** The real tree, read once per caller. */
export function universeFromDisk(root: string, scanRoots: string[]): Universe {
  const sources: Record<string, string> = {};
  for (const scanRoot of scanRoots) {
    const files = sourceFiles(join(root, scanRoot));
    for (const file of files) {
      sources[
        file
          .slice(root.length + 1)
          .split(sep)
          .join("/")
      ] = readFileSync(file, "utf8");
    }
  }
  return makeUniverse(sources);
}

/** Module-level `"use server"`: the first statement in the file, past comments. */
export function isServerModule(mod: Mod): boolean {
  return /^[\s;]*(?:"use server"|'use server')\s*;/.test(mod.text);
}

export function serverModules(universe: Universe): Mod[] {
  const out: Mod[] = [];
  universe.forEach((mod) => {
    if (isServerModule(mod)) out.push(mod);
  });
  return out.sort((a, b) => (a.rel < b.rel ? -1 : 1));
}

/**
 * The body of the function whose declaration begins at `start`, braces
 * balanced, or null if it cannot be found.
 *
 * Three phases, and the middle one is the trap that produced a wrong answer on
 * the first pass:
 *   1. balance the PARAMETER parens — a destructured or object-typed parameter
 *      contains braces of its own;
 *   2. skip the return annotation by tracking `<`/`>` depth, so the `{` inside
 *      `Promise<ActionResult<{ id: string }>>` is not mistaken for the body;
 *   3. balance the body braces.
 * Comments and string contents must already be blanked, or either can carry a
 * brace that unbalances the count.
 */
export function bodyAt(code: string, start: number): string | null {
  let i = code.indexOf("(", start);
  if (i === -1) return null;

  let parens = 0;
  for (; i < code.length; i += 1) {
    if (code[i] === "(") parens += 1;
    else if (code[i] === ")") {
      parens -= 1;
      if (parens === 0) {
        i += 1;
        break;
      }
    }
  }

  let angle = 0;
  for (; i < code.length; i += 1) {
    const c = code[i];
    // `=>` inside a function type: the `>` is not a closing bracket.
    if (c === "=" && code[i + 1] === ">") {
      i += 1;
      continue;
    }
    if (c === "<") angle += 1;
    else if (c === ">") {
      if (angle > 0) angle -= 1;
    } else if (c === "{" && angle === 0) break;
  }
  if (code[i] !== "{") return null;

  const bodyStart = i;
  let braces = 0;
  for (; i < code.length; i += 1) {
    if (code[i] === "{") braces += 1;
    else if (code[i] === "}") {
      braces -= 1;
      if (braces === 0) {
        i += 1;
        break;
      }
    }
  }
  if (braces !== 0) return null;
  return code.slice(bodyStart, i);
}

/**
 * Every top-level function declaration in a module, exported or not. The
 * unexported ones are the point: `requireAdmin()` in lib/actions/team.ts and
 * `financeScopeFor()` in lib/queries/budgets.ts are both local, and both are
 * where the session check actually happens.
 */
export function declarationsOf(mod: Mod): Map<string, string> {
  const out = new Map<string, string>();
  const found = Array.from(
    mod.code.matchAll(/(?:^|[^\w$.])(?:export\s+)?(?:async\s+)?function\s+(\w+)/g)
  );
  for (const m of found) {
    const body = bodyAt(mod.code, m.index!);
    if (body) out.set(m[1]!, body);
  }
  return out;
}

/** `@/lib/x` and `./x` against the universe's keys. */
export function resolveSpecifier(universe: Universe, fromRel: string, spec: string): string | null {
  let base: string | null = null;
  if (spec.indexOf("@/") === 0) base = spec.slice(2);
  else if (spec.charAt(0) === ".") {
    const dir = fromRel.split("/").slice(0, -1);
    const parts = spec.split("/");
    for (const part of parts) {
      if (part === "." || part === "") continue;
      if (part === "..") dir.pop();
      else dir.push(part);
    }
    base = dir.join("/");
  }
  if (!base) return null;
  const candidates = [base + ".ts", base + ".tsx", base + "/index.ts", base];
  for (const candidate of candidates) {
    if (universe.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Local name -> the module it was imported from, resolved inside the universe.
 * Read from `text` (strings intact) because the specifier IS a string.
 */
export function importsOf(universe: Universe, mod: Mod): Map<string, string> {
  const out = new Map<string, string>();
  const found = Array.from(
    mod.text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)
  );
  for (const m of found) {
    const target = resolveSpecifier(universe, mod.rel, m[2]!);
    if (!target) continue;
    for (const part of m[1]!.split(",")) {
      const spec = part.trim().replace(/^type\s+/, "");
      if (!spec) continue;
      const aliased = /(\w+)\s+as\s+(\w+)/.exec(spec);
      out.set(aliased ? aliased[2]! : spec, target);
    }
  }
  return out;
}

/** Called identifiers in a body, deduplicated, in first-appearance order. */
export function calledNames(body: string): string[] {
  const found = Array.from(body.matchAll(/(^|[^\w$.])(\w+)\s*\(/g));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of found) {
    const name = m[2]!;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * A regex matching a call to any of `primitives`.
 *
 * `(^|[^\w$.])` rather than a lookbehind: this tsconfig sets no `target`, so tsc
 * treats every file as ES5 and rejects several modern regex constructs that
 * vitest itself runs happily. Excluding a preceding `.` keeps a hypothetical
 * `something.auth()` from passing as the Auth.js handle.
 */
export function gateCallRegex(primitives: string[]): RegExp {
  return new RegExp("(^|[^\\w$.])(?:" + primitives.join("|") + ")\\s*\\(");
}

/**
 * How this body reaches one of the primitives, or null if it does not within
 * `hops` helper calls. The string is for the failure message and for the
 * delegation assertions — "it passed" is not a useful answer on its own.
 *
 * A call is followed two ways and only two: into a function declared in the same
 * module (the unexported-helper shape), or into the same-named declaration of a
 * module it was imported from. Anything else stops the walk.
 */
export function gatePath(
  universe: Universe,
  modRel: string,
  body: string,
  hops: number,
  gateCall: RegExp
): string | null {
  if (gateCall.test(body)) return "in its own body";
  if (hops <= 0) return null;

  const mod = universe.get(modRel);
  if (!mod) return null;
  const local = declarationsOf(mod);
  const imported = importsOf(universe, mod);

  for (const name of calledNames(body)) {
    const own = local.get(name);
    if (own) {
      const deeper = gatePath(universe, modRel, own, hops - 1, gateCall);
      if (deeper) return `via ${name}() in this module, which gates ${deeper}`;
      continue;
    }
    const targetRel = imported.get(name);
    if (!targetRel) continue;
    const target = universe.get(targetRel);
    if (!target) continue;
    const body2 = declarationsOf(target).get(name);
    if (!body2) continue;
    const deeper = gatePath(universe, targetRel, body2, hops - 1, gateCall);
    if (deeper) return `via ${name}() in ${targetRel}, which gates ${deeper}`;
  }
  return null;
}
