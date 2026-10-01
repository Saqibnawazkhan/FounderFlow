/**
 * Structural guard: a shipped server action that nothing calls is a feature
 * the customer cannot use.
 *
 * WHY THIS FILE EXISTS. "Shipped, tested, unreachable" is this repo's most
 * productive bug shape — six of them, none caught by review, none caught by a
 * unit test, because every unit test in the repo tests the action and not the
 * road to it:
 *
 *   1. `createChannelAction` — complete, correct, 568 lines of green unit
 *      tests, and no create button anywhere. A user reported it. Now called by
 *      components/chat/new-channel-modal.tsx.
 *   2. `openDmAction` — reachable, but its schema asserted `.cuid()` on ids the
 *      system does not mint, so every DM failed while the schema test stayed
 *      green. Reachability and correctness are different questions; this file
 *      answers only the first, and that is still worth an hour of build time.
 *   3. `deleteMessageAction` — no caller. You cannot delete a message.
 *   4. `postRunwayCardAction` — HAS a caller, in components/chat/message-
 *      composer.tsx, and is still unreachable: the button is drawn only when
 *      `canPostRunway` is true, the prop defaults to false, and nothing in the
 *      app ever passes it. The product's own differentiator — posting the
 *      runway snapshot into a conversation — has no entry point. See the
 *      second describe block: "has a caller" is not the same as "is reachable",
 *      and a sweep that only counts callers would call this green.
 *   5. `canManageChannel` (lib/auth/channel-permissions.ts) — twelve green
 *      test cases, no caller, so `archivedAt` can never be set by anyone.
 *   6. `listChannelOptions` (lib/queries/chat.ts) and `listTransactionsAction`
 *      — dead.
 *
 * Two of those six are outside this file's scope on purpose: `canManageChannel`
 * and `listChannelOptions` are a permission predicate and a query, not server
 * actions, and a general "every exported function has a caller" sweep over
 * lib/** is a different (much noisier) test. What this file owns is the
 * endpoint surface: every export of a `"use server"` module under
 * `lib/actions/` or an `actions.ts` beside a page. Those are the 79 things a
 * user is supposed to be able to do.
 *
 * THERE IS DELIBERATELY NO ALLOW-LIST. Its two sibling files
 * (use-server-exports.test.ts, action-auth-gates.test.ts) both keep one,
 * because "this export is safe to expose" and "this endpoint is pre-auth on
 * purpose" are real, standing decisions. "This endpoint has no caller" is not
 * one of those: it is either a missing entry point or a function that should be
 * deleted, and both are fixes rather than exemptions. An allow-list here would
 * be the place the next six land.
 *
 * THREE PARSING TRAPS, all of which produced a wrong answer on the first pass:
 *
 *   1. COMMENTS. `createChannelAction` is named in eleven comments across the
 *      repo — bootstrap.ts, channel-rail.tsx, team.ts — because it is the
 *      canonical example of several things. Count comments and every dead
 *      action looks alive. Strings too: `captureServerError(e, { action:
 *      "deleteMessageAction" })` inside the action's own module is a string, and
 *      `scripts/qa-chat.mjs` discusses both dead actions in prose.
 *   2. IMPORT LINES. An `import { fooAction } from …` is not a call. It is the
 *      shape a half-finished wiring leaves behind, so import statements are
 *      stripped before anything is counted.
 *   3. TESTS AND SCRIPTS ARE NOT CALLERS. `tests/components/new-channel-
 *      modal.test.tsx` calls a `vi.fn()` named `createChannelAction`; the smoke
 *      scripts name both dead actions in comments. A test that exercises an
 *      endpoint no UI reaches is precisely the state bugs 1, 5 and 6 shipped
 *      in — crediting it would make this file agree with the bug.
 *
 * The last describe block drives the detector over synthetic modules, because
 * every assertion over the real tree reports a list — and a broken detector
 * reports an empty one.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { codeOnly, stripComments } from "../harness/source-scan";

const ROOT = process.cwd();

/**
 * Where a caller may live. `scripts/` and `tests/` are absent on purpose — see
 * trap 3 — and so is `prisma/`, which seeds data rather than invoking actions.
 */
const PRODUCT_ROOTS = ["lib", "app", "components"];

/**
 * A module holding server actions: `lib/actions/**` by convention, plus the
 * App Router's own form, a `"use server"` module beside a page, which
 * `app/(app)/chat/[slug]/actions.ts` uses. Both halves are needed — scanning
 * only `lib/actions/` misses two chat endpoints, and scanning all of `app/`
 * would sweep in every page.
 */
function isActionModulePath(rel: string): boolean {
  if (rel.indexOf("lib/actions/") === 0) return true;
  return /^app\/.*\/actions\.tsx?$/.test(rel);
}

// ---------------------------------------------------------------------------
// source scanning
//
// `codeOnly` and `stripComments` come from tests/lib/harness/source-scan.ts,
// which is a plain module rather than a test file — importing a helper out of a
// `*.test.ts` would re-register that file's describe blocks inside this one, so
// the suite would run action-auth-gates twice and report its failures here. That
// constraint is why three copies of the scanner existed; it was never a reason
// to copy it, only a reason not to import it from a test. The copies had audit
// A49 in them: a `"` inside a regex literal read as the start of a string and
// blanked the rest of the file, so a call sitting below a shape-check regex was
// invisible and this guard reported the action it called as unreachable. See
// `counts a caller in a file that also contains a regex literal with a quote`.
// ---------------------------------------------------------------------------

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, found);
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) found.push(full);
  }
  return found;
}

type Mod = {
  /** posix path relative to the repo root — the key everything else uses. */
  rel: string;
  /** comments AND string contents blanked: what to read code out of. */
  code: string;
  /** comments blanked, strings intact: for the `"use server"` directive. */
  text: string;
  /** `code` with every import statement removed. See trap 2. */
  body: string;
};

/**
 * Every product module, keyed by relative path. A plain Map rather than the
 * filesystem so the fixtures at the bottom drive the exact same functions the
 * real tree does — a detector proven on a different code path is proven of
 * nothing.
 */
type Universe = Map<string, Mod>;

/**
 * Strip import statements. `\bimport\s+` (whitespace required) leaves
 * `import("…")` alone, so a dynamically imported action still counts.
 */
function withoutImports(code: string): string {
  return code
    .replace(/\bimport\s+[^;]*?from\s*["'][^"']*["']\s*;?/g, " ")
    .replace(/\bimport\s*["'][^"']*["']\s*;?/g, " ");
}

function makeUniverse(sources: Record<string, string>): Universe {
  const universe: Universe = new Map();
  const entries = Object.entries(sources);
  for (const pair of entries) {
    const code = codeOnly(pair[1]);
    universe.set(pair[0], {
      rel: pair[0],
      code,
      text: stripComments(pair[1]),
      body: withoutImports(code),
    });
  }
  return universe;
}

let cachedRepo: Universe | null = null;

function repoUniverse(): Universe {
  if (cachedRepo) return cachedRepo;
  const sources: Record<string, string> = {};
  for (const root of PRODUCT_ROOTS) {
    const files = sourceFiles(join(ROOT, root));
    for (const file of files) {
      sources[
        file
          .slice(ROOT.length + 1)
          .split(sep)
          .join("/")
      ] = readFileSync(file, "utf8");
    }
  }
  cachedRepo = makeUniverse(sources);
  return cachedRepo;
}

/** Module-level `"use server"`: the first statement in the file, past comments. */
function isServerModule(mod: Mod): boolean {
  return /^[\s;]*(?:"use server"|'use server')\s*;/.test(mod.text);
}

function actionModules(universe: Universe): Mod[] {
  const out: Mod[] = [];
  universe.forEach((mod) => {
    if (isActionModulePath(mod.rel) && isServerModule(mod)) out.push(mod);
  });
  return out.sort((a, b) => (a.rel < b.rel ? -1 : 1));
}

// ---------------------------------------------------------------------------
// the endpoints
// ---------------------------------------------------------------------------

/**
 * Every exported value binding of a module.
 *
 * Today every action in the repo is an `export async function`, but the form is
 * not the point — an action moved to `export const fooAction = async () => …`
 * must not fall out of this sweep on the day it is reformatted. `export type`
 * and `export interface` are erased before Next.js sees the module, so they are
 * no endpoint and are skipped.
 *
 * Array.from over matchAll: this tsconfig sets `lib` but no `target`, so tsc
 * defaults to ES5 and `for…of` over a bare iterator is a TS2802 that vitest
 * runs happily and typecheck rejects. Numbered groups for the same reason —
 * `(?<name>…)` is TS1503.
 */
function exportedNames(code: string): string[] {
  const names: string[] = [];

  const declared = Array.from(
    code.matchAll(/\bexport\s+(?:(?:async\s+)?function\s*\*?|const|let|var|class|enum)\s+(\w+)/g)
  );
  for (const m of declared) names.push(m[1]!);

  const lists = Array.from(code.matchAll(/\bexport\s+(type\s+)?\{([^}]*)\}/g));
  for (const m of lists) {
    if (m[1]) continue;
    for (const part of m[2]!.split(",")) {
      const spec = part.trim();
      if (!spec || spec.indexOf("type ") === 0) continue;
      const aliased = /\bas\s+(\w+)\s*$/.exec(spec);
      names.push(aliased ? aliased[1]! : spec);
    }
  }

  return names;
}

export type Endpoint = { mod: string; name: string };

function allEndpoints(universe: Universe): Endpoint[] {
  const out: Endpoint[] = [];
  for (const mod of actionModules(universe)) {
    for (const name of exportedNames(mod.code)) out.push({ mod: mod.rel, name });
  }
  return out;
}

const idOf = (e: Endpoint) => `${e.mod}:${e.name}`;

// ---------------------------------------------------------------------------
// who references what
// ---------------------------------------------------------------------------

/**
 * `(^|[^\w$])NAME($|[^\w$])` rather than `\bNAME\b`: `\b` would let
 * `$deleteMessageAction` or `myDeleteMessageAction` count. A leading `.` is
 * allowed through deliberately — `actions.deleteMessageAction(…)` via a
 * namespace import is a real call.
 */
function referenceRegExp(name: string): RegExp {
  return new RegExp("(^|[^\\w$])" + name + "($|[^\\w$])");
}

/**
 * Product modules, other than the one that declares it, whose CODE (comments,
 * string contents and import statements removed) names this endpoint.
 */
function referrersOf(universe: Universe, endpoint: Endpoint): string[] {
  const re = referenceRegExp(endpoint.name);
  const out: string[] = [];
  universe.forEach((mod) => {
    if (mod.rel === endpoint.mod) return;
    if (re.test(mod.body)) out.push(mod.rel);
  });
  return out.sort();
}

/** Endpoint ids that no product module outside their own module names. */
function unreachableEndpoints(universe: Universe): string[] {
  const out: string[] = [];
  for (const endpoint of allEndpoints(universe)) {
    if (referrersOf(universe, endpoint).length === 0) out.push(idOf(endpoint));
  }
  return out.sort();
}

/**
 * Endpoint ids whose only referrers are OTHER action modules.
 *
 * Reachability is transitive: an action called only by another action is
 * reachable exactly as far as that one is, and this sweep cannot see the
 * difference. Empty today, and pinned empty so the first case has to be looked
 * at by a person rather than silently credited.
 */
function actionOnlyReferrers(universe: Universe): string[] {
  const out: string[] = [];
  for (const endpoint of allEndpoints(universe)) {
    const referrers = referrersOf(universe, endpoint);
    if (referrers.length === 0) continue;
    let reachedFromUi = false;
    for (const r of referrers) {
      if (!isActionModulePath(r)) reachedFromUi = true;
    }
    if (!reachedFromUi) out.push(`${idOf(endpoint)} (only ${referrers.join(", ")})`);
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// fail-closed prop gates — the postRunwayCardAction shape
// ---------------------------------------------------------------------------

/**
 * A component prop declared optional and defaulted to `false`, whose only job
 * in the tree is to decide whether a control is drawn.
 *
 * Fail-closed is the right default: a caller that has not thought about a
 * capability should show no control. The failure mode is that NO caller ever
 * thinks about it, and then the control is drawn nowhere — which is the whole
 * of bug 4. `postRunwayCardAction` has a caller, a test, a server-side
 * permission re-check, and no way in.
 *
 * Only props of modules that reference a server action are considered, which
 * keeps this to the question this file is about (entry points) rather than a
 * repo-wide dead-prop audit. Measured on the current tree: ten such props,
 * nine passed by someone, one not.
 */
export type PropGate = { mod: string; prop: string; passedBy: string[]; actions: string[] };

/**
 * Does any product module pass `prop` as a JSX attribute?
 *
 * The declaring module counts: `sidebar.tsx` passes `nested` to its own local
 * `NavItem`, and `tasks-client.tsx` passes `dragging`/`isOverlay` to a card
 * component in the same file. Excluding self reported all three as dead, which
 * is exactly the wall of false positives that gets a guard deleted.
 *
 * Attribute position, not merely "the name appears": `prop={…}`, `prop="…"`,
 * or the boolean shorthand `prop` followed by `/>`, `>` or another attribute.
 * The destructuring default (`prop = false,`), the type declaration (`prop?:`)
 * and a read (`prop && …`) all fail to match, which is what makes the answer
 * mean something.
 */
function propPassedBy(universe: Universe, prop: string): string[] {
  const attr = new RegExp("\\s" + prop + '\\s*(=\\s*\\{|=\\s*"|/>|>|\\s+[a-zA-Z])');
  const out: string[] = [];
  universe.forEach((mod) => {
    if (attr.test(mod.code)) out.push(mod.rel);
  });
  return out.sort();
}

function failClosedPropGates(universe: Universe): PropGate[] {
  // Which endpoints does each module reference, and which endpoints does it
  // reference EXCLUSIVELY? The exclusive set is what a dead gate strands.
  const exclusive = new Map<string, string[]>();
  for (const endpoint of allEndpoints(universe)) {
    const referrers = referrersOf(universe, endpoint);
    if (referrers.length !== 1) continue;
    const only = referrers[0]!;
    const list = exclusive.get(only) ?? [];
    list.push(idOf(endpoint));
    exclusive.set(only, list);
  }

  const gates: PropGate[] = [];
  const referencing: string[] = [];
  universe.forEach((mod) => {
    if (isActionModulePath(mod.rel)) return;
    for (const endpoint of allEndpoints(universe)) {
      if (referenceRegExp(endpoint.name).test(mod.body)) {
        referencing.push(mod.rel);
        return;
      }
    }
  });

  for (const rel of referencing) {
    const mod = universe.get(rel)!;
    const seen: string[] = [];
    const defaults = Array.from(mod.code.matchAll(/(\w+)\s*=\s*false\s*,/g));
    for (const m of defaults) {
      const prop = m[1]!;
      if (seen.indexOf(prop) !== -1) continue;
      seen.push(prop);
      // Must be a declared optional prop, not just any `x = false` local.
      if (!new RegExp("\\b" + prop + "\\?\\s*:").test(mod.code)) continue;
      const passedBy = propPassedBy(universe, prop);
      if (passedBy.length > 0) continue;
      gates.push({ mod: rel, prop, passedBy, actions: exclusive.get(rel) ?? [] });
    }
  }

  return gates.sort((a, b) => (a.mod + a.prop < b.mod + b.prop ? -1 : 1));
}

// ---------------------------------------------------------------------------

describe("server-action reachability (a shipped endpoint nobody can reach is not shipped)", () => {
  it("finds the action modules and their endpoints at all", () => {
    // Guards the guard. Every assertion below is a loop over these two lists,
    // so a renamed directory or a broken directive detector turns the whole
    // file into tests that cannot fail — silently, and in green.
    const universe = repoUniverse();
    expect(
      actionModules(universe).length,
      'almost no action module was found — isActionModulePath or the "use server" ' +
        "directive detector is wrong, and every check below is now vacuous"
    ).toBeGreaterThan(20);
    expect(
      allEndpoints(universe).length,
      "no exported binding was parsed out of the action modules"
    ).toBeGreaterThan(50);
    // And the universe must contain the UI, or every endpoint looks dead.
    expect(
      universe.size,
      "the product-module sweep found too few files to have loaded the UI"
    ).toBeGreaterThan(150);
  });

  it("every exported action is named by at least one product module outside its own", () => {
    // THE assertion. Six bugs of this exact shape have shipped; see the header.
    const unreachable = unreachableEndpoints(repoUniverse());

    expect(
      unreachable,
      "These server actions exist, compile, and (mostly) have unit tests, and NOTHING " +
        "in lib/, app/ or components/ names them. Comments, string literals, import " +
        "statements, tests and smoke scripts were all excluded, so each of these is a " +
        "feature the customer has no way to invoke — or a function that should be " +
        "deleted. There is no allow-list here on purpose: pick one of those two.\n" +
        unreachable.map((id) => `  - ${id}`).join("\n")
    ).toEqual([]);
  });

  it("no endpoint is reachable only from another action module", () => {
    // Reachability is transitive and this sweep is not: an action whose only
    // referrer is another action is exactly as reachable as that one, which
    // this file cannot see. Empty today; pinned so the first case gets read.
    const chained = actionOnlyReferrers(repoUniverse());
    expect(
      chained,
      "These endpoints are named only by other action modules, so whether a user can " +
        "reach them depends on whether that caller is reachable — a question this " +
        "sweep does not answer. Check by hand, then either wire a UI or delete:\n" +
        chained.map((id) => `  - ${id}`).join("\n")
    ).toEqual([]);
  });

  it("does not credit a comment, a string or an import line as a caller", () => {
    // Trap 1 and trap 2, over the real tree, by name. lib/chat/bootstrap.ts
    // mentions createChannelAction three times and calls it zero times; it is
    // the reason a naive `grep -l` sweep says all six bugs are fine.
    const universe = repoUniverse();
    const createChannel: Endpoint = { mod: "lib/actions/chat.ts", name: "createChannelAction" };
    const referrers = referrersOf(universe, createChannel);

    expect(
      referrers,
      "createChannelAction is called from the modal that finally shipped its button; if " +
        "this is empty the reference scan is broken, not the app"
    ).toContain("components/chat/new-channel-modal.tsx");
    expect(
      referrers,
      "lib/chat/bootstrap.ts only DISCUSSES createChannelAction in comments — crediting " +
        "it would make this file agree with the bug it exists to catch"
    ).not.toContain("lib/chat/bootstrap.ts");
    expect(referrers).not.toContain("lib/actions/team.ts");
    expect(referrers).not.toContain("components/chat/channel-rail.tsx");
  });

  it("does not credit a test or a smoke script as a caller", () => {
    // Trap 3. tests/components/new-channel-modal.test.tsx calls a vi.fn() by
    // that name; scripts/qa-chat.mjs names both dead actions in prose. An
    // endpoint with a test and no UI is the state bugs 1, 5 and 6 shipped in.
    const rels: string[] = [];
    repoUniverse().forEach((mod) => rels.push(mod.rel));
    for (const rel of rels) {
      expect(rel.indexOf("tests/"), `tests/ leaked into the caller universe: ${rel}`).not.toBe(0);
      expect(rel.indexOf("scripts/"), `scripts/ leaked into the caller universe: ${rel}`).not.toBe(
        0
      );
    }
  });

  it("draws every control that is the only entry point to an endpoint", () => {
    // Bug 4, generalised. A fail-closed optional prop is correct design and a
    // silent single point of failure: if no caller ever passes it, the control
    // is drawn nowhere and the endpoint behind it is as dead as one with no
    // caller at all — while this file's main assertion above stays green,
    // because the import and the call really are there.
    const gates = failClosedPropGates(repoUniverse());

    expect(
      gates.map((g) => `${g.mod}:${g.prop}`),
      "These components declare an optional prop defaulting to false, draw something " +
        "behind it, and NO caller anywhere in the app passes it — so that something is " +
        "drawn nowhere. Listed beside each gate are the endpoints THIS MODULE IS THE " +
        "ONLY REFERRER OF; whichever of them sits behind the gate is imported, called, " +
        "and unreachable, which no coverage number will tell you.\n" +
        gates
          .map(
            (g) =>
              `  - <${g.mod.split("/").pop()} ${g.prop}> is never passed. Sole referrer of: ` +
              (g.actions.length > 0 ? g.actions.join(", ") : "(no endpoint exclusively)")
          )
          .join("\n")
    ).toEqual([]);
  });

  it("keeps the Runway card reachable — the named regression", () => {
    // Pinned separately from the sweep above so the mechanism is spelled out
    // even if the heuristic is ever loosened. `postRunwayCardAction` is the
    // product's differentiator: posting the workspace's cash / burn / runway
    // snapshot into a conversation. It re-checks canPostRunwayCard(role)
    // server-side, so wiring the prop is safe; leaving it unwired means the
    // feature does not exist.
    const universe = repoUniverse();
    const composer = universe.get("components/chat/message-composer.tsx");
    expect(composer, "message-composer.tsx moved — re-point this regression").toBeTruthy();
    expect(
      /canPostRunway\s*\?\s*:/.test(composer!.code),
      "canPostRunway is gone from MessageComposer's props — if the Runway control was " +
        "rewired some other way, delete this test; if the feature was deleted, say so " +
        "in the header"
    ).toBe(true);

    const passers = propPassedBy(universe, "canPostRunway");
    expect(
      passers,
      "Nothing passes canPostRunway to <MessageComposer>, so the Runway button is never " +
        "drawn and postRunwayCardAction has no entry point. The value wanted is " +
        "canPostRunwayCard(session.role), server-rendered and threaded down from the " +
        "chat page — the action re-checks it, so the prop is a convenience, not the gate."
    ).not.toEqual([]);
  });
});

describe("the reachability detector (a sweep is only worth its false-negative rate)", () => {
  // Every assertion above reports a list against the real tree, and a broken
  // detector reports an empty one. So the interesting cases live here, driven
  // through the exact same functions.

  const ACTION_MODULE = `"use server";

/**
 * This comment names strandedAction and wiredAction, and vouching for neither
 * is the point.
 */
import { db } from "@/lib/db";

export type Result = { ok: boolean };

export async function wiredAction(): Promise<Result> {
  return { ok: true };
}

export async function strandedAction(): Promise<Result> {
  await db.message.deleteMany({});
  return { ok: true };
}
`;

  const universeWith = (sources: Record<string, string>) =>
    makeUniverse(Object.assign({ "lib/actions/fixture.ts": ACTION_MODULE }, sources));

  it("reports an endpoint that nothing names", () => {
    const universe = universeWith({
      "components/caller.tsx": `import { wiredAction } from "@/lib/actions/fixture";
export function Caller() {
  return <button onClick={() => wiredAction()}>Go</button>;
}
`,
    });
    expect(unreachableEndpoints(universe)).toEqual(["lib/actions/fixture.ts:strandedAction"]);
  });

  it("counts a caller in a file that also contains a regex literal with a quote", () => {
    // Audit A49, in the direction that costs an hour rather than a customer.
    // app/verify-email-change/page.tsx briefly shape-checked an address with a
    // character class containing a double quote; the scanner read that quote as
    // the start of a string literal, blanked every character to the next quote
    // — end of file, there being none — and this guard reported
    // confirmEmailChangeAction as an endpoint with no caller while the call sat
    // a few lines below the regex. Both fixture endpoints are called here, so
    // the expected answer is the empty list and nothing has to be read into it.
    const universe = universeWith({
      "components/regex-caller.tsx": `import { strandedAction, wiredAction } from "@/lib/actions/fixture";
const SAFE_LABEL = /[^<>"@]+/;
export function RegexCaller({ label }: { label: string }) {
  return SAFE_LABEL.test(label) ? (
    <button onClick={() => strandedAction()}>Go</button>
  ) : (
    <form action={wiredAction} />
  );
}
`,
    });
    expect(unreachableEndpoints(universe)).toEqual([]);
  });

  it("does not count the action module's own body as a caller", () => {
    // An action that calls itself, or names itself in a captureServerError
    // tag, is not reachable from anywhere.
    const universe = universeWith({});
    expect(unreachableEndpoints(universe)).toEqual([
      "lib/actions/fixture.ts:strandedAction",
      "lib/actions/fixture.ts:wiredAction",
    ]);
  });

  it("does not count a comment that names the action", () => {
    const universe = universeWith({
      "components/talks-about-it.tsx": `/** Wired up in a later PR: strandedAction. */
// TODO: call strandedAction from the row menu.
export function Nothing() {
  return null;
}
`,
    });
    expect(unreachableEndpoints(universe)).toContain("lib/actions/fixture.ts:strandedAction");
  });

  it("does not count a string that names the action", () => {
    // The shape inside every action in this repo:
    //   captureServerError(e, { action: "deleteMessageAction" })
    const universe = universeWith({
      "lib/telemetry.ts": `export const TAGS = ["strandedAction", "wiredAction"];
`,
    });
    expect(unreachableEndpoints(universe)).toContain("lib/actions/fixture.ts:strandedAction");
  });

  it("does not count an import that is never used", () => {
    // Trap 2: the residue of a half-finished wiring. This is the one a
    // `grep -r` would get wrong, and the one most likely to be left behind by
    // someone who started adding the button.
    const universe = universeWith({
      "components/half-wired.tsx": `import { strandedAction, wiredAction } from "@/lib/actions/fixture";
export function HalfWired() {
  return <button onClick={() => wiredAction()}>Delete</button>;
}
`,
    });
    expect(unreachableEndpoints(universe)).toEqual(["lib/actions/fixture.ts:strandedAction"]);
  });

  it("counts a call, a prop hand-off and a dynamic import", () => {
    // The three real ways an action gets reached. A form action passed by
    // reference never appears followed by `(`, so a call-shaped detector
    // misses it.
    const universe = universeWith({
      "components/direct.tsx": `import { wiredAction } from "@/lib/actions/fixture";
export const Direct = () => <form action={wiredAction} />;
`,
      "components/lazy.tsx": `export async function Lazy() {
  const mod = await import("@/lib/actions/fixture");
  return mod.strandedAction();
}
`,
    });
    expect(unreachableEndpoints(universe)).toEqual([]);
  });

  it("does not credit a similarly-named identifier", () => {
    const universe = universeWith({
      "components/near-miss.tsx": `const myStrandedActionHandler = 1;
const $strandedAction = 2;
export const x = myStrandedActionHandler + $strandedAction;
`,
    });
    expect(unreachableEndpoints(universe)).toContain("lib/actions/fixture.ts:strandedAction");
  });

  it("ignores a module that is not a server module even under lib/actions/", () => {
    // lib/actions/types.ts is a type-only module with no directive. Auditing
    // it would report ActionResult as an unreachable endpoint.
    const universe = universeWith({
      "lib/actions/types.ts": `export type ActionResult<T> = { success: true; data: T };
export const NOT_AN_ENDPOINT = 1;
`,
    });
    const ids = unreachableEndpoints(universe);
    expect(ids).not.toContain("lib/actions/types.ts:NOT_AN_ENDPOINT");
  });

  it("finds a server module beside a page, not just under lib/actions/", () => {
    // app/(app)/chat/[slug]/actions.ts owns two endpoints. A sweep that only
    // walks lib/actions/ calls them both reachable without looking.
    const universe = universeWith({
      "app/(app)/chat/[slug]/actions.ts": `"use server";
export async function loadThreadAction(): Promise<void> {}
`,
    });
    expect(unreachableEndpoints(universe)).toContain(
      "app/(app)/chat/[slug]/actions.ts:loadThreadAction"
    );
  });

  it("reports a fail-closed prop gate that no caller passes", () => {
    // Bug 4, reconstructed: the import is real, the call is real, the button
    // is real, and `showIt` is never passed — so the endpoint is unreachable
    // while unreachableEndpoints() is empty.
    const universe = universeWith({
      "components/gated.tsx": `import { strandedAction, wiredAction } from "@/lib/actions/fixture";
type Props = { showIt?: boolean; disabled?: boolean };
export function Gated({ showIt = false, disabled = false }: Props) {
  return (
    <div>
      <button disabled={disabled} onClick={() => wiredAction()}>Send</button>
      {showIt && <button onClick={() => strandedAction()}>Runway</button>}
    </div>
  );
}
`,
      "app/(app)/page.tsx": `import { Gated } from "@/components/gated";
export default function Page() {
  return <Gated disabled={false} />;
}
`,
    });
    expect(unreachableEndpoints(universe)).toEqual([]);
    const gates = failClosedPropGates(universe);
    expect(gates.map((g) => `${g.mod}:${g.prop}`)).toEqual(["components/gated.tsx:showIt"]);
    // And the message must be able to name what the dead gate strands.
    expect(gates[0]!.actions).toContain("lib/actions/fixture.ts:strandedAction");
  });

  it("accepts a prop that a caller passes, including the shorthand form", () => {
    const shorthand = universeWith({
      "components/gated.tsx": `import { strandedAction } from "@/lib/actions/fixture";
type Props = { showIt?: boolean };
export function Gated({ showIt = false }: Props) {
  return <div>{showIt && <button onClick={() => strandedAction()}>Runway</button>}</div>;
}
`,
      "app/(app)/page.tsx": `import { Gated } from "@/components/gated";
export default function Page() {
  return <Gated showIt />;
}
`,
    });
    expect(failClosedPropGates(shorthand)).toEqual([]);

    const explicit = universeWith({
      "components/gated.tsx": `import { strandedAction } from "@/lib/actions/fixture";
type Props = { showIt?: boolean };
export function Gated({ showIt = false }: Props) {
  return <div>{showIt && <button onClick={() => strandedAction()}>Runway</button>}</div>;
}
`,
      "app/(app)/page.tsx": `import { Gated } from "@/components/gated";
export default function Page() {
  return <Gated showIt={true} />;
}
`,
    });
    expect(failClosedPropGates(explicit)).toEqual([]);
  });

  it("accepts a prop passed to a sub-component inside its own module", () => {
    // sidebar.tsx / tasks-client.tsx shape. Excluding self reported three
    // healthy props as dead, which is how a guard earns its deletion.
    const universe = universeWith({
      "components/local.tsx": `import { wiredAction } from "@/lib/actions/fixture";
export function Outer() {
  return <Row nested onPick={() => wiredAction()} />;
}
function Row({ nested = false, onPick }: { nested?: boolean; onPick: () => void }) {
  return <button className={nested ? "ps-9" : ""} onClick={onPick} />;
}
`,
    });
    expect(failClosedPropGates(universe)).toEqual([]);
  });

  it("does not mistake a plain local `= false` for a prop gate", () => {
    const universe = universeWith({
      "components/locals.tsx": `import { wiredAction } from "@/lib/actions/fixture";
export function Locals() {
  let settled = false,
    tried = false;
  if (!settled) void wiredAction();
  return <span>{String(tried)}</span>;
}
`,
    });
    expect(failClosedPropGates(universe)).toEqual([]);
  });

  it("reports an endpoint reachable only from another action module", () => {
    const universe = universeWith({
      "lib/actions/other.ts": `"use server";
import { strandedAction } from "@/lib/actions/fixture";
export async function otherAction(): Promise<void> {
  await strandedAction();
}
`,
      "components/caller.tsx": `import { otherAction, wiredAction } from "@/lib/actions/fixture";
export const C = () => <form action={otherAction}>{String(wiredAction)}</form>;
`,
    });
    expect(unreachableEndpoints(universe)).toEqual([]);
    expect(actionOnlyReferrers(universe)).toEqual([
      "lib/actions/fixture.ts:strandedAction (only lib/actions/other.ts)",
    ]);
  });
});
