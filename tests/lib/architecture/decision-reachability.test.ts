/**
 * Structural guard: a DECISION FUNCTION that nothing calls is a decision this
 * product has not actually made.
 *
 * WHY THIS FILE EXISTS. "Shipped, tested, unreachable" is this repo's most
 * productive defect shape. The audit found six instances. Then the two fix
 * waves that closed the audit created four more of exactly the same shape,
 * because the file-ownership rule that stopped ten concurrent agents corrupting
 * each other also stopped each of them wiring its own new helper into call
 * sites it did not own:
 *
 *   gateAuthAction         lib/rate-limit.ts        exported, 12 unit tests, 0 callers
 *   requireFinanceSession  lib/queries/session.ts   exported, unit-tested,   0 callers
 *   appOrigin              lib/env.ts               exported, unit-tested,   0 callers
 *   failedLoginCount       a committed migration     0 code reads or writes it
 *
 * Three findings were recorded as FIXED while a customer would still have
 * experienced all three in full: the login brute-force limiter gated nothing,
 * the ledger's second authorisation layer was never asked, and every emailed
 * invite and reset link was still built by hand from `process.env`.
 *
 * WHY NO OTHER KIND OF TEST CATCHES THIS.
 *
 *   - A UNIT TEST CANNOT. The unit test IS the caller. `appOrigin` had a green
 *     suite covering trailing slashes, whitespace and undefined, and the suite
 *     was the only thing in the repository that called it.
 *   - COVERAGE CANNOT, for the same reason: the lines were covered, by the test.
 *   - REVIEW DID NOT, ten times, because every one of these functions is
 *     discussed by name in prose all over the tree — CLAUDE.md, module headers,
 *     the call sites that were *supposed* to be converted. A reader greps the
 *     name, sees fifteen hits, and moves on. That is the actual mechanism of
 *     this bug, which is why the scanner below erases comments and strings
 *     before it counts anything.
 *   - tests/lib/actions/reachability.test.ts catches only SERVER ACTIONS (the
 *     exports of a `"use server"` module). None of the four above is one. This
 *     file is the same idea applied to single-decision-point helpers, and it
 *     deliberately reuses that file's parsing approach so the two agree about
 *     what a caller is. (Copied rather than imported: importing another
 *     `*.test.ts` re-registers its describe blocks inside this one, so its
 *     failures would be reported against this file. The fixtures at the bottom
 *     are what keep the copy honest.)
 *
 * HOW A DECISION IS FOUND — TWO MECHANISMS, ON PURPOSE.
 *
 *   1. `DECLARED_DECISIONS`, a hand-written list. It is the strict tier: each
 *      entry must be named by a product module OUTSIDE its own, because every
 *      one of these exists precisely so that other modules stop deciding the
 *      thing themselves. A hand list is a maintenance burden and it can rot, so
 *      it is defended two ways: `exportedNames` proves each entry still exists
 *      (a decision renamed out from under the list is the other way it goes
 *      quiet), and the list has a floor length, so it cannot be emptied to get
 *      to green.
 *
 *   2. `markedDecisionFunctions`, derived from the docstring. Any exported
 *      function whose own JSDoc claims to be "the one place"/"the only
 *      place"/"the single decision" joins automatically, with no edit here. The
 *      marker is the prose this codebase already writes — 30-odd blocks use one
 *      of those phrases today — rather than a new `@decision` tag nobody would
 *      remember to add.
 *
 *      WHY BOTH, rather than only the self-maintaining one: the marker catches
 *      exactly ONE of the three functions that actually shipped dead.
 *      `appOrigin` says "the ONE place that decides"; `gateAuthAction` and
 *      `requireFinanceSession` describe themselves without ever using the
 *      phrase. An automatic rule that misses two thirds of the known cases is
 *      a safety net, not the floor. So the hand list is the floor and the
 *      marker is the net that grows by itself.
 *
 *      The derived tier is also deliberately WEAKER: it demands one call site
 *      anywhere in product code, the declaring module included. That is the
 *      exact shape all four offenders had — zero callers anywhere, not even at
 *      home — and it avoids failing on a helper that is exported only so it can
 *      be unit-tested and is genuinely called one line below (`agendaDays` in
 *      components/tasks/task-calendar.tsx, `getTaskPage` in lib/queries/tasks.ts).
 *      Demanding an external caller there would have produced seven false
 *      positives on the day this file was written, which is how a guard earns
 *      its deletion.
 *
 * THERE IS NO ALLOW-LIST, and `KNOWN_UNREACHED` is not one. An allow-list says
 * "this one is fine"; that list says "this one is BROKEN, here is the fix", it
 * is asserted to still be broken so that fixing it fails the test and forces
 * promotion into `DECLARED_DECISIONS`, and it is capped at two entries so it
 * cannot quietly become the place the next six land. The only two honest
 * answers to an unreached decision are still "wire it" or "delete it".
 *
 * FIVE PARSING TRAPS. The first four are the ones tests/lib/actions/
 * reachability.test.ts documents, and they all apply here. The fifth is one
 * that file gets WRONG, found while writing this one:
 *
 *   1. COMMENTS. `gateAuthAction` is named in comments in lib/client-ip.ts and
 *      lib/auth/login-throttle.ts, neither of which calls it. Count comments
 *      and every dead decision looks alive.
 *   2. STRING LITERALS. `captureServerError(e, { action: "…" })` and
 *      scripts' prose both name these functions.
 *   3. IMPORT LINES. `import { appOrigin } from "@/lib/env"` is not a call — it
 *      is the residue a half-finished wiring leaves behind, so import
 *      statements are stripped before anything is counted.
 *   4. TESTS AND SMOKE SCRIPTS ARE NOT CALLERS. Crediting them would make this
 *      file agree with the bug: "exported, unit-tested, unreachable" is the
 *      defect, so the unit test must not be the thing that clears it.
 *   5. TEMPLATE-LITERAL INTERPOLATIONS ARE CODE. Blanking the contents of a
 *      backtick string blanks `${formatAmountForMessage(amount, currency)}`
 *      with it, and that call in lib/actions/transactions.ts is the ONLY caller
 *      of a real decision helper. A scanner without this reports
 *      `formatAmountForMessage` as dead — verified, it did — and a guard that
 *      cries wolf about a healthy function is worth less than no guard. So
 *      `neutralize` re-enters code state at `${`, with brace depth tracked, and
 *      leaves it at the matching `}`. Tracking the depth is the whole of it: an
 *      object literal inside an interpolation (`${fn({ a: 1 })}`) otherwise
 *      closes the interpolation early and corrupts the rest of the file — which
 *      silently lost lib/actions/email-change.ts as a caller of
 *      `gateAuthAction` on the first attempt.
 *
 * THE ES5 TRAP IS LIVE: tsconfig.json sets `lib` but no `target`, so tsc
 * defaults to ES5. `for…of` over a bare iterator (including `matchAll`),
 * spreading a Set or a Map, and named capture groups all pass vitest and fail
 * `npx tsc --noEmit`. Hence `Array.from(...matchAll(...))`, numbered groups,
 * `indexOf` over arrays, and `Map.forEach`.
 *
 * The last describe block drives the detector over synthetic modules, because
 * every assertion over the real tree reports a LIST — and a broken detector
 * reports an empty one, in green, forever.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";

const ROOT = process.cwd();

/**
 * Where a caller may live. `tests/` and `scripts/` are absent on purpose (trap
 * 4), and so is `prisma/`, which seeds data.
 *
 * Note what this costs and why it is the right trade: a helper whose only
 * consumer is scripts/vercel-build.mjs — `productionAppUrlProblem` is one — is
 * genuinely reached and would be reported dead here, so it is not a declared
 * decision. The build script has its own guard (tests/lib/env/*). Widening
 * these roots to include scripts/ would instead let a smoke script vouch for a
 * function no user can reach, which is the defect.
 */
const PRODUCT_ROOTS = ["lib", "app", "components"];

export type Decision = {
  /** The exported binding. */
  name: string;
  /** Repo-relative posix path of the module that declares it. */
  module: string;
  /** What breaks for a user if nothing calls it. Printed on failure. */
  why: string;
};

/**
 * The decisions this project has deliberately centralised: "there is one place
 * this is decided, and everything else routes through it."
 *
 * HOW THIS LIST WAS CHOSEN. Three sources, in order of how much they are worth:
 *
 *   a. The four the fix waves stranded (gateAuthAction, requireFinanceSession,
 *      appOrigin, and financeRecipients, whose own docstring had to say out
 *      loud that it was "correct and unused"). These are the reason the file
 *      exists and they are the reason it starts with a hand list: three of the
 *      four would not have been found by any automatic rule.
 *   b. The helpers CLAUDE.md or a module docstring names as THE single decision
 *      — `sessionTokenStillValid` ("the pure, unit-tested decision"),
 *      `canSeeFinances` ("the real predicate the sidebar, the export route and
 *      /reports use"), `isMemberBlockedRoute`, `homeRouteForRole`,
 *      `planRecurring`, `sanitizeNumericOutput`, `currencyMinorUnits`,
 *      `parseMoneyInput`, `capUnread`, `formatAmountForMessage`, `getClientIp`,
 *      `notifyUsers`, `searchWorkspace`.
 *   c. The two read paths a previous wave had to repoint at the aggregate query
 *      rather than a capped list (`getTaskStatusCounts`, `getTransactionTotals`,
 *      commit 19bd7e7). A KPI read from the wrong source is the same bug class:
 *      a decision made in one place and ignored in another.
 *
 * Every entry below is a CROSS-module contract, which is why the strict rule
 * applies to it. A helper exported only for its own unit test does not belong
 * here; it belongs to the derived tier, which does not demand an external
 * caller.
 */
const DECLARED_DECISIONS: Decision[] = [
  {
    name: "gateAuthAction",
    module: "lib/rate-limit.ts",
    why: "the single entry point to every auth-family rate limit. Unreached, the P0 login brute-force hole is open and signup/reset/token-redeem are unthrottled.",
  },
  {
    name: "requireFinanceSession",
    module: "lib/queries/session.ts",
    why: "the ledger's second authorisation layer (sec-002). Unreached, a demoted co-founder with a stale cookie keeps reading money for the JWT's 30-day life.",
  },
  {
    name: "appOrigin",
    module: "lib/env.ts",
    why: "the one place the public origin is decided (prodready-004). Unreached, every invite and password-reset link is hand-built from process.env and can point at localhost or carry a doubled slash.",
  },
  {
    name: "financeRecipients",
    module: "lib/queries/notifications.ts",
    why: "the write-time half of the finance notification filter (sec-005). Unreached, a member's phone and inbox get the rupee figure before any read filter can see it.",
  },
  {
    name: "getTaskStatusCounts",
    module: "lib/queries/tasks.ts",
    why: "the aggregate behind every task KPI. Unreached, a dashboard number is counted from a capped list and silently wrong above the cap (19bd7e7).",
  },
  {
    name: "getTransactionTotals",
    module: "lib/queries/transactions.ts",
    why: "the whole-ledger roll-up. Unreached, cash/burn/runway get summed from a paged list (money-008).",
  },
  {
    name: "canSeeFinances",
    module: "lib/auth/role-gates.ts",
    why: "the finance predicate both layers must share. Unreached from a surface, that surface has invented its own role comparison and the two layers disagree.",
  },
  {
    name: "isMemberBlockedRoute",
    module: "lib/auth/role-gates.ts",
    why: "the one list of routes a member may not open, shared by middleware, sidebar, command palette and notification filtering.",
  },
  {
    name: "homeRouteForRole",
    module: "lib/auth/role-gates.ts",
    why: "where a redirect sends someone who fails a gate. Unreached, a member is bounced to a page they also cannot open — a loop.",
  },
  {
    name: "sessionTokenStillValid",
    module: "lib/auth/session-version.ts",
    why: "the pure session-invalidation decision (CLAUDE.md). Unreached from lib/auth.ts's jwt callback, a tombstoned user's open tab keeps reading data until the JWT expires.",
  },
  {
    name: "getClientIp",
    module: "lib/client-ip.ts",
    why: "the one place a request's IP is decided, header trust included. Unreached, a limiter keys on a spoofable header or on one shared bucket for everyone.",
  },
  {
    name: "notifyUsers",
    module: "lib/notify/fan-out.ts",
    why: "the only place in-app + push + email fan-out is raised from. A second copy is how the three channels drift.",
  },
  {
    name: "planRecurring",
    module: "lib/recurring/materialize.ts",
    why: "the recurring-rule catch-up plan, claim token included. Unreached, the cron reverts to filtering in memory and double-posts a charge (cron-004).",
  },
  {
    name: "searchWorkspace",
    module: "lib/queries/search.ts",
    why: "the only place workspace search applies tenancy and visibility, so the only place such a bug could be silent.",
  },
  {
    name: "sanitizeNumericOutput",
    module: "lib/format.ts",
    why: "one helper, one decision about locale digit shaping (999 must never render as Eastern-Arabic digits in a money string).",
  },
  {
    name: "currencyMinorUnits",
    module: "lib/format.ts",
    why: "the one place a currency's minor units are decided, so stored scale and displayed scale cannot disagree.",
  },
  {
    name: "parseMoneyInput",
    module: "lib/format.ts",
    why: "the one place typed or imported money text becomes a number. Unreached from the import modal, a CSV row is parsed by a second, laxer rule.",
  },
  {
    name: "formatAmountForMessage",
    module: "lib/utils.ts",
    why: "the one place an amount is rendered into a PERSISTED or EMAILED string (money-001), where a locale-dependent format would be frozen into the row.",
  },
  {
    name: "capUnread",
    module: "lib/chat/unread.ts",
    why: "the one place the unread badge's ceiling is applied, so the number and its plus sign cannot disagree.",
  },
];

/**
 * Decisions that ARE unreached right now, recorded rather than exempted.
 *
 * This is the opposite of an allow-list, and three properties make it so:
 *
 *   • Each entry is asserted to STILL be unreached. Wiring one FAILS this file
 *     and the failure tells you to move it into `DECLARED_DECISIONS`. An
 *     allow-list goes quiet when the bug is fixed; this stays loud until the
 *     inventory matches reality.
 *   • Each entry carries the remedy, in the imperative, at the call site that
 *     needs it. "Unreachable" is not a standing decision, so there is nothing
 *     to exempt — only work not yet done.
 *   • The list is capped (see the assertion). It cannot grow into the place the
 *     next six land.
 *
 * It has one entry because the author of this file owns one file and could not
 * fix it. It is a finding, not an exception.
 */
const KNOWN_UNREACHED: Decision[] = [
  {
    name: "visibleNotifications",
    module: "lib/queries/notifications.ts",
    why:
      "the read-time finance notification filter (sec-005). Called only by getNotifications (the /notifications page). " +
      "listNotificationsAction in lib/actions/notifications.ts — the TOPBAR BELL, the most-read notification surface in " +
      "the app — carries a second, older copy that filters on n.link only, so a finance-CATEGORY row with no link, or a " +
      "link to /dashboard, still shows a member the rupee figure in its message. REMEDY: replace lines 36-47 of " +
      "lib/actions/notifications.ts with `await visibleNotifications(rows, { userId, companyId, role })`. The category " +
      "rule and the supervised-project escape hatch then apply to the bell as well. When that lands, delete this entry " +
      "and add visibleNotifications to DECLARED_DECISIONS.",
  },
];

/** Beyond this, the inventory of open defects has become an allow-list. */
const KNOWN_UNREACHED_CAP = 2;

// ---------------------------------------------------------------------------
// source scanning
// ---------------------------------------------------------------------------

/**
 * Blank out comments and, when `keepStrings` is false, the CONTENTS of string
 * literals — preserving length, so offsets into the result still line up with
 * the original.
 *
 * A template literal's `${…}` interpolations stay CODE either way (trap 5),
 * with brace depth tracked so an object literal inside one does not close it
 * early. Known limitation, shared with the sibling guard: a regex literal
 * containing a quote character (`/['"]/`) is read as the start of a string.
 * Measured on the current tree, no declared decision's caller count changes if
 * that case is handled, and handling it properly needs a real lexer.
 */
function neutralize(src: string, keepStrings: boolean): string {
  const out = src.split("");
  const n = src.length;
  const BACKSLASH = String.fromCharCode(92);

  // A stack of frames, innermost last. "str" = inside a string literal;
  // "tpl" = inside a `${…}` interpolation, whose number is the open-brace depth.
  type Frame = { kind: "str"; quote: string } | { kind: "tpl"; depth: number };
  const stack: Frame[] = [];
  const top = (): Frame | null => (stack.length > 0 ? stack[stack.length - 1]! : null);

  let i = 0;
  while (i < n) {
    const frame = top();
    const inString = frame !== null && frame.kind === "str";
    const c = src[i]!;
    const c2 = i + 1 < n ? src[i + 1]! : "";

    if (!inString) {
      if (c === "/" && c2 === "/") {
        out[i] = " ";
        out[i + 1] = " ";
        i += 2;
        while (i < n && src[i] !== "\n") {
          out[i] = " ";
          i += 1;
        }
        continue;
      }
      if (c === "/" && c2 === "*") {
        out[i] = " ";
        out[i + 1] = " ";
        i += 2;
        while (i < n && !(src[i] === "*" && i + 1 < n && src[i + 1] === "/")) {
          if (src[i] !== "\n") out[i] = " ";
          i += 1;
        }
        if (i < n) {
          out[i] = " ";
          out[i + 1] = " ";
          i += 2;
        }
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        stack.push({ kind: "str", quote: c });
        i += 1;
        continue;
      }
      if (c === "{" && frame !== null && frame.kind === "tpl") {
        frame.depth += 1;
        i += 1;
        continue;
      }
      if (c === "}" && frame !== null && frame.kind === "tpl") {
        if (frame.depth === 0) stack.pop();
        else frame.depth -= 1;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }

    // inside a string literal
    const quote = (frame as { kind: "str"; quote: string }).quote;
    if (c === BACKSLASH) {
      if (!keepStrings) {
        out[i] = " ";
        if (i + 1 < n) out[i + 1] = " ";
      }
      i += 2;
      continue;
    }
    if (quote === "`" && c === "$" && c2 === "{") {
      // Trap 5: an interpolation is code, not text.
      stack.push({ kind: "tpl", depth: 0 });
      i += 2;
      continue;
    }
    if (c === quote) {
      stack.pop();
      i += 1;
      continue;
    }
    if (!keepStrings && c !== "\n") out[i] = " ";
    i += 1;
  }

  return out.join("");
}

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
  /** untouched source: the only thing the docstring marker may read. */
  raw: string;
  /** comments AND string contents blanked: what to read code out of. */
  code: string;
  /** `code` with every import statement removed. See trap 3. */
  body: string;
};

type Universe = Map<string, Mod>;

/**
 * Strip import statements. `\bimport\s+` (whitespace required) leaves
 * `import("…")` alone, so a dynamically imported decision still counts —
 * lib/notify/fan-out.ts reaches `financeRecipients` exactly that way.
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
    const code = neutralize(pair[1], false);
    universe.set(pair[0], { rel: pair[0], raw: pair[1], code, body: withoutImports(code) });
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

// ---------------------------------------------------------------------------
// exports, references, callers
// ---------------------------------------------------------------------------

/**
 * Every exported value binding of a module. Used to prove a declared decision
 * still exists: a rename is the quiet way one goes dead, and it would otherwise
 * show up here as "no caller" with a misleading message.
 *
 * `export type` / `export interface` are erased before anything runs, so they
 * are not bindings. Numbered groups and `Array.from` for the ES5 trap.
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

/**
 * `(^|[^\w$])NAME($|[^\w$])` rather than `\bNAME\b`: `\b` would let
 * `$appOrigin` or `myAppOriginHelper` count. A leading `.` is allowed through
 * deliberately — `mod.financeRecipients(…)` after a dynamic import is a real
 * call, and that is how fan-out.ts reaches it.
 */
function referenceRegExp(name: string): RegExp {
  return new RegExp("(^|[^\\w$])" + name + "($|[^\\w$])");
}

/** Remove the declaration of `name` so a module cannot vouch for itself. */
function withoutOwnDeclaration(body: string, name: string): string {
  return body.replace(
    new RegExp(
      "export\\s+(?:async\\s+)?(?:function\\s*\\*?\\s+|const\\s+|let\\s+|var\\s+)" + name,
      "g"
    ),
    " "
  );
}

/**
 * Product modules OTHER than the declaring one whose CODE (comments, string
 * contents and import statements removed) names this decision.
 */
function referrersOf(universe: Universe, decision: Decision): string[] {
  const re = referenceRegExp(decision.name);
  const out: string[] = [];
  universe.forEach((mod) => {
    if (mod.rel === decision.module) return;
    if (re.test(mod.body)) out.push(mod.rel);
  });
  return out.sort();
}

/** Does the declaring module itself call it, past its own declaration? */
function calledAtHome(universe: Universe, decision: Decision): boolean {
  const mod = universe.get(decision.module);
  if (!mod) return false;
  return referenceRegExp(decision.name).test(withoutOwnDeclaration(mod.body, decision.name));
}

/** Every product call site of a decision, the declaring module included. */
function callSiteCount(universe: Universe, decision: Decision): number {
  return referrersOf(universe, decision).length + (calledAtHome(universe, decision) ? 1 : 0);
}

const idOf = (d: Decision) => `${d.module}:${d.name}`;

// ---------------------------------------------------------------------------
// the self-maintaining half: decisions that say so in their own docstring
// ---------------------------------------------------------------------------

/**
 * The phrases this codebase already uses to mean "this is the single decision
 * point". Chosen by reading the tree rather than inventing a tag: 30-odd
 * docstrings use one of them today, and a convention already in use is the only
 * kind a future author follows without being told.
 */
const DECISION_MARKER = /\b(?:the\s+(?:one|only|single)\s+(?:place|decision)|one\s+decision)\b/i;

/**
 * A JSDoc block immediately followed by an exported declaration.
 *
 * `((?:[^*]|\*(?!\/))*)` rather than `([\s\S]*?)`: the lazy form backtracks
 * across a close-comment token to reach the next `export`, so an earlier block's
 * marker gets credited to a later, unrelated function. That mistake put
 * `getTaskPage` and `pageSize` on the candidate list on the first pass, both
 * inheriting `taskScopeWhere`'s "the one place the visibility rules live".
 * Requiring the body to contain no close-comment token is what makes the attachment
 * real.
 */
const DOCSTRING_THEN_EXPORT =
  /\/\*\*((?:[^*]|\*(?!\/))*)\*\/\s*export\s+(?:async\s+)?(?:function\s*\*?\s+(\w+)|const\s+(\w+))/g;

/**
 * Is this binding a function? A marked CONSTANT is out of scope — the file is
 * about decision FUNCTIONS, and a marked constant that nothing reads is a
 * different (and far less dangerous) shape. `STORED_MONEY_SCALE` and
 * `RunwayPayloadSchema` are marked and are not functions.
 */
function isFunctionShaped(code: string, name: string): boolean {
  if (new RegExp("\\bfunction\\s*\\*?\\s+" + name + "\\b").test(code)) return true;
  return new RegExp(
    "\\b" + name + "\\s*(?::[^=]{0,200})?=\\s*(?:async\\s*)?(?:\\(|function\\b|<)"
  ).test(code);
}

/** Exported functions whose own docstring claims single-decision status. */
function markedDecisionFunctions(universe: Universe): Decision[] {
  const out: Decision[] = [];
  universe.forEach((mod) => {
    const matches = Array.from(mod.raw.matchAll(DOCSTRING_THEN_EXPORT));
    for (const m of matches) {
      const name = m[2] ?? m[3];
      if (!name) continue;
      if (!DECISION_MARKER.test(m[1]!)) continue;
      if (!isFunctionShaped(mod.code, name)) continue;
      out.push({
        module: mod.rel,
        name,
        why: "its own docstring claims to be the one place this is decided",
      });
    }
  });
  return out.sort((a, b) => (idOf(a) < idOf(b) ? -1 : 1));
}

// ---------------------------------------------------------------------------

describe("decision reachability (a decision nobody calls is a decision not made)", () => {
  it("finds the product tree, and every declared decision still exists", () => {
    // Guards the guard. Every assertion below loops over a list; a moved
    // directory or a broken export parser turns this whole file into tests that
    // cannot fail, silently, in green.
    const universe = repoUniverse();
    expect(
      universe.size,
      "the product-module sweep found too few files to have loaded the app"
    ).toBeGreaterThan(150);

    expect(
      DECLARED_DECISIONS.length,
      "DECLARED_DECISIONS has shrunk. Deleting rows is how this file gets to green " +
        "without anything being fixed — if a decision genuinely stopped being one, say " +
        "so in its entry and lower this floor in the same commit"
    ).toBeGreaterThanOrEqual(19);

    const missing: string[] = [];
    const all = DECLARED_DECISIONS.concat(KNOWN_UNREACHED);
    for (const decision of all) {
      const mod = universe.get(decision.module);
      if (!mod) {
        missing.push(`${idOf(decision)} — module not found`);
        continue;
      }
      if (exportedNames(mod.code).indexOf(decision.name) === -1) {
        missing.push(`${idOf(decision)} — not an export of that module`);
      }
    }
    expect(
      missing,
      "A declared decision no longer exists where this list says it does. A rename or a " +
        "move is the other way a decision goes quiet, and it would otherwise be reported " +
        'below as "no caller" with a misleading message. Re-point the entry, or delete it ' +
        "and lower the floor above:\n" +
        missing.map((m) => `  - ${m}`).join("\n")
    ).toEqual([]);
  });

  it("every declared decision is called by a product module outside its own", () => {
    // THE assertion. Ten defects of this exact shape have shipped; four of them
    // were created by the wave that was fixing the first six. See the header.
    const universe = repoUniverse();
    const stranded: Decision[] = [];
    for (const decision of DECLARED_DECISIONS) {
      if (referrersOf(universe, decision).length === 0) stranded.push(decision);
    }

    expect(
      stranded.map(idOf),
      "These functions exist to be THE ONE PLACE something is decided, they compile, they " +
        "have unit tests, and NOTHING in lib/, app/ or components/ outside their own module " +
        "calls them. Comments, string literals, import statements, tests and smoke scripts " +
        "were all excluded — which is exactly how ten of these shipped past review, because " +
        "a grep for the name finds plenty of prose. There is no allow-list here on purpose: " +
        'the two honest answers are "wire it" or "delete it".\n' +
        stranded.map((d) => `  - ${idOf(d)}\n      ${d.why}`).join("\n")
    ).toEqual([]);
  });

  it("every decision whose docstring claims to be the one place is called from somewhere", () => {
    // The self-maintaining half: no edit to this file is needed for a new
    // decision to be covered. Weaker than the assertion above on purpose (the
    // declaring module counts as a call site) so that a helper exported only so
    // it can be unit-tested, and called one line below, is not a false
    // positive. What this still catches is the shape all four of the fix wave's
    // orphans had: zero call sites anywhere, not even at home.
    const universe = repoUniverse();
    const marked = markedDecisionFunctions(universe);

    expect(
      marked.length,
      "the docstring-marker sweep found almost nothing — DECISION_MARKER or " +
        "DOCSTRING_THEN_EXPORT is broken, and this assertion is now vacuous"
    ).toBeGreaterThanOrEqual(3);

    const dead: string[] = [];
    for (const decision of marked) {
      if (callSiteCount(universe, decision) === 0) dead.push(idOf(decision));
    }

    expect(
      dead,
      "These functions say in their own docstring that they are the one place something is " +
        "decided, and NOTHING calls them — not another module, not even the module that " +
        "declares them. That is not centralisation, it is a copy of the rule living " +
        "somewhere else. Wire it, or delete it and delete the claim with it:\n" +
        dead.map((id) => `  - ${id}`).join("\n")
    ).toEqual([]);
  });

  it("keeps the known-unreached inventory honest, and small", () => {
    // Not an allow-list: entries are asserted to still be BROKEN, so wiring one
    // fails here and forces it into DECLARED_DECISIONS. See the header.
    expect(
      KNOWN_UNREACHED.length,
      "KNOWN_UNREACHED is capped. Past this it stops being an inventory of open defects " +
        "and becomes the allow-list this file exists to avoid — fix one before adding one"
    ).toBeLessThanOrEqual(KNOWN_UNREACHED_CAP);

    const universe = repoUniverse();
    const nowWired: string[] = [];
    for (const decision of KNOWN_UNREACHED) {
      const referrers = referrersOf(universe, decision);
      if (referrers.length > 0)
        nowWired.push(`${idOf(decision)} (now called by ${referrers.join(", ")})`);
    }

    expect(
      nowWired,
      "Good news, and an edit to make: this decision now HAS an external caller, so it is " +
        "no longer an open finding. Delete it from KNOWN_UNREACHED and add it to " +
        "DECLARED_DECISIONS, raising the floor, so it can never quietly go dead again:\n" +
        nowWired.map((s) => `  - ${s}`).join("\n")
    ).toEqual([]);
  });

  it("does not credit a comment, a string or an import line as a caller", () => {
    // Traps 1-3, over the real tree, by name. This is the mechanism of the bug:
    // gateAuthAction is discussed by name in two modules that do not call it,
    // so a reviewer's grep finds it "used".
    const universe = repoUniverse();
    const gate: Decision = { name: "gateAuthAction", module: "lib/rate-limit.ts", why: "" };
    const referrers = referrersOf(universe, gate);

    expect(
      referrers,
      "gateAuthAction is called by the auth actions that finally wired it; if this is empty " +
        "the reference scan is broken, not the app"
    ).toContain("lib/actions/auth.ts");
    expect(
      referrers,
      "lib/auth/login-throttle.ts only DISCUSSES gateAuthAction in comments — crediting it " +
        "would make this file agree with the bug it exists to catch"
    ).not.toContain("lib/auth/login-throttle.ts");
    expect(
      referrers,
      "lib/client-ip.ts names gateAuthAction twice, in prose, and calls it zero times"
    ).not.toContain("lib/client-ip.ts");
  });

  it("counts a call written inside a template-literal interpolation", () => {
    // Trap 5, over the real tree. formatAmountForMessage has exactly one
    // caller in the product, and that call is `${formatAmountForMessage(…)}`
    // inside a notification message. A scanner that blanks template contents
    // reports this healthy decision as dead — the first version of this file
    // did, and a guard that cries wolf gets deleted.
    const universe = repoUniverse();
    const referrers = referrersOf(universe, {
      name: "formatAmountForMessage",
      module: "lib/utils.ts",
      why: "",
    });
    expect(
      referrers,
      "the only call to formatAmountForMessage is inside a template literal in " +
        "lib/actions/transactions.ts — if this is empty, neutralize() is eating " +
        "${…} interpolations again"
    ).toContain("lib/actions/transactions.ts");
  });

  it("does not credit a test or a smoke script as a caller", () => {
    // Trap 4. "Exported, unit-tested, unreachable" is the defect, so the unit
    // test must not be what clears it. scripts/qa-finance-planning.mjs
    // discusses alreadyFiredToday at length; nothing calls it.
    const rels: string[] = [];
    repoUniverse().forEach((mod) => rels.push(mod.rel));
    for (const rel of rels) {
      expect(rel.indexOf("tests/"), `tests/ leaked into the caller universe: ${rel}`).not.toBe(0);
      expect(rel.indexOf("scripts/"), `scripts/ leaked into the caller universe: ${rel}`).not.toBe(
        0
      );
    }
  });
});

describe("the decision detector (a sweep is only worth its false-negative rate)", () => {
  // Every assertion above reports a list against the real tree, and a broken
  // detector reports an empty one. The interesting cases live here, driven
  // through the exact same functions.

  const DECIDER = `/**
 * The one place the finance boundary is decided. This block also names
 * strandedDecision, and vouching for it is precisely what must not happen.
 */
export function wiredDecision(role: string): boolean {
  return role !== "member";
}

/**
 * The single decision about who may be told about money.
 */
export function strandedDecision(ids: string[]): string[] {
  return ids;
}

/** The one place the stored scale is decided. */
export const STORED_SCALE = 2;
`;

  const universeWith = (sources: Record<string, string>) =>
    makeUniverse(Object.assign({ "lib/decide.ts": DECIDER }, sources));

  const wired: Decision = { name: "wiredDecision", module: "lib/decide.ts", why: "" };
  const stranded: Decision = { name: "strandedDecision", module: "lib/decide.ts", why: "" };

  it("reports a decision that nothing outside its module names", () => {
    const universe = universeWith({
      "app/(app)/reports/page.tsx": `import { wiredDecision } from "@/lib/decide";
export default function Page() {
  return <main>{String(wiredDecision("admin"))}</main>;
}
`,
    });
    expect(referrersOf(universe, wired)).toEqual(["app/(app)/reports/page.tsx"]);
    expect(referrersOf(universe, stranded)).toEqual([]);
  });

  it("does not count a comment that names the decision", () => {
    const universe = universeWith({
      "lib/queries/money.ts": `/** Narrow with strandedDecision once it is wired. */
// TODO: strandedDecision(recipients)
export const rows = [];
`,
    });
    expect(referrersOf(universe, stranded)).toEqual([]);
  });

  it("does not count a string that names the decision", () => {
    // The shape inside every action in this repo:
    //   captureServerError(e, { gate: "strandedDecision" })
    const universe = universeWith({
      "lib/telemetry.ts": `export const TAGS = ["strandedDecision", 'wiredDecision', \`strandedDecision\`];
`,
    });
    expect(referrersOf(universe, stranded)).toEqual([]);
    expect(referrersOf(universe, wired)).toEqual([]);
  });

  it("does not count an import that is never used", () => {
    // Trap 3: the residue of a half-finished wiring, and the single most likely
    // thing to be left behind by an agent that ran out of turn.
    const universe = universeWith({
      "lib/queries/money.ts": `import { strandedDecision, wiredDecision } from "@/lib/decide";
export const ok = wiredDecision("admin");
`,
    });
    expect(referrersOf(universe, stranded)).toEqual([]);
    expect(referrersOf(universe, wired)).toEqual(["lib/queries/money.ts"]);
  });

  it("counts a call inside a template-literal interpolation, braces and all", () => {
    // Trap 5. The nested object literal is the part that matters: without brace
    // depth tracking its `}` closes the interpolation early and everything
    // after it in the file is read as string text.
    const universe = universeWith({
      "lib/actions/notify.ts": `export function message(role: string, ids: string[]): string {
  return \`allowed=\${wiredDecision(role)} to=\${strandedDecision(ids, { scoped: true }).join(",")} done\`;
}
`,
    });
    expect(referrersOf(universe, wired)).toEqual(["lib/actions/notify.ts"]);
    expect(referrersOf(universe, stranded)).toEqual(["lib/actions/notify.ts"]);
  });

  it("keeps reading code after a template literal that contains an object literal", () => {
    // The email-change.ts regression, minimised: the call that matters comes
    // AFTER the tricky template, and a mis-tracked brace hides it.
    const universe = universeWith({
      "lib/actions/after.ts": `export function go(role: string) {
  const label = \`\${["a"].map((x) => ({ x })).length} items\`;
  return label + wiredDecision(role);
}
`,
    });
    expect(referrersOf(universe, wired)).toEqual(["lib/actions/after.ts"]);
  });

  it("does not credit a similarly-named identifier", () => {
    const universe = universeWith({
      "lib/near-miss.ts": `const myStrandedDecisionHelper = 1;
const $strandedDecision = 2;
export const x = myStrandedDecisionHelper + $strandedDecision;
`,
    });
    expect(referrersOf(universe, stranded)).toEqual([]);
  });

  it("separates 'called at home' from 'called by someone else'", () => {
    // The distinction the two tiers are built on. A helper called only inside
    // its own module is reachable exactly as far as that module's caller is —
    // fine for a test-only export, NOT fine for something whose whole purpose
    // is that other modules route through it.
    const universe = makeUniverse({
      "lib/decide.ts": `${DECIDER}
export function facade(ids: string[]): string[] {
  return strandedDecision(ids);
}
`,
    });
    expect(calledAtHome(universe, stranded)).toBe(true);
    expect(referrersOf(universe, stranded)).toEqual([]);
    expect(callSiteCount(universe, stranded)).toBe(1);
    expect(callSiteCount(universe, wired)).toBe(0);
  });

  it("picks up a newly marked decision function with no edit to the list", () => {
    const universe = universeWith({
      "lib/queries/brand-new.ts": `/**
 * The one place the export window is decided.
 */
export function exportWindow(now: Date): Date {
  return now;
}

/** An ordinary helper with no claim to make. */
export function plainHelper(): number {
  return 1;
}
`,
    });
    const ids = markedDecisionFunctions(universe).map(idOf);
    expect(ids).toContain("lib/queries/brand-new.ts:exportWindow");
    expect(ids).toContain("lib/decide.ts:wiredDecision");
    expect(ids).toContain("lib/decide.ts:strandedDecision");
    expect(ids).not.toContain("lib/queries/brand-new.ts:plainHelper");
  });

  it("does not treat a marked constant, or a module header, as a decision function", () => {
    // STORED_SCALE in the fixture is marked and is a number. And a marker in a
    // MODULE header must not be credited to whatever export happens to come
    // first — lib/queries/session.ts's header says "the one place a scoped read
    // decides who is asking", and the next export is React's memoizer.
    const universe = universeWith({
      "lib/queries/header.ts": `/**
 * Module header: the one place a scoped read decides who is asking.
 */

import { db } from "@/lib/db";

export function unrelatedFirstExport(): number {
  return Number(Boolean(db));
}
`,
    });
    const ids = markedDecisionFunctions(universe).map(idOf);
    expect(ids).not.toContain("lib/decide.ts:STORED_SCALE");
    expect(ids).not.toContain("lib/queries/header.ts:unrelatedFirstExport");
  });

  it("does not let one docstring's marker leak onto a later export", () => {
    // The backtracking bug. A lazy `([\\s\\S]*?)` body lets the marked block
    // above reach past its own close-comment token to the next `export`, so an unmarked
    // function inherits the claim. That put getTaskPage on the candidate list.
    const universe = universeWith({
      "lib/queries/leak.ts": `/**
 * The one place the visibility rules live.
 */
function notExported(): number {
  return 1;
}

/**
 * One bounded page of rows. Says nothing about being the only anything.
 */
export function pagedRows(): number {
  return notExported();
}
`,
    });
    expect(markedDecisionFunctions(universe).map(idOf)).not.toContain(
      "lib/queries/leak.ts:pagedRows"
    );
  });

  it("proves a declared decision's existence check can fail", () => {
    // The rename path. `exportedNames` is what turns "renamed" into a clear
    // message instead of a misleading "no caller".
    const universe = universeWith({});
    const mod = universe.get("lib/decide.ts")!;
    expect(exportedNames(mod.code)).toContain("strandedDecision");
    expect(exportedNames(mod.code)).not.toContain("renamedDecision");
  });
});
