/*
 * QA audit — domain: harness-auditor (AGENT_INDEX 21).
 *
 * NOBODY AUDITS THE TESTS. This script does.
 *
 * It answers one question about every test in the repo: COULD THIS FAIL? A
 * green suite is evidence of nothing until you know that each assertion in it
 * is capable of going red. This repo has already shipped three tests that were
 * not (a calendar day-edge suite that was vacuous under CI's UTC; `.cuid()`
 * assertions that stayed green while DMs were unusable for every seeded user;
 * smoke-rate-limit.mjs, whose pass criteria sit inside `if (logPath)` on an
 * unset DEV_LOG so it always exits 0). Three is a pattern, not bad luck, so
 * this script goes looking for the fourth mechanically.
 *
 * ── HOW IT PROVES VACUITY ──────────────────────────────────────────────────
 *
 * Tier A — STRUCTURAL (no browser, no DB writes). Derives its expectations
 *   from prisma/schema.prisma, package.json, ci.yml and the source tree rather
 *   than from lists written here, so a module added next month is covered the
 *   day it lands. This is the same technique tests/lib/db/purge-invariants.ts
 *   and tests/lib/notify/fan-out-sites.ts already use, pointed at the harness.
 *
 * Tier B — THE NULL-SERVER MUTATION TEST. The only honest way to know whether
 *   a smoke script can fail is to give it a broken app and see. So this starts
 *   a local HTTP server that answers every request with a valid but EMPTY HTML
 *   page, points each smoke at it with BASE, and records the exit code. A
 *   script that asserts anything real MUST come back non-zero or print a
 *   failure marker. One that comes back 0 and silent cannot fail — it is
 *   decoration, and the runner has been reporting it as OK.
 *
 *   The null server is what makes this safe: no app is running behind it, so
 *   no server action can fire and no browser-driven write can reach Postgres.
 *   Every candidate is additionally STATICALLY CLEARED first (see
 *   `clearedForNullRun`) — any script that writes SQL through `docker exec`,
 *   or calls a Prisma write of any kind, is refused and reported instead of
 *   run. Reads through localDb() are allowed; they are reads.
 *
 * Tier C — THE TRIPWIRE OBSERVATION. tests/lib/tasks/calendar.test.ts claims a
 *   guard that fails loudly if the TZ pin is removed. That claim is itself
 *   untested. This runs the file twice — once under the pinned zone, once
 *   under UTC — and asserts pass-then-FAIL. If it passes under UTC the guard
 *   is decoration and the day-edge cases are vacuous again.
 *
 * ── DATA SAFETY ────────────────────────────────────────────────────────────
 *
 * This script writes NO row of pre-existing data. It creates its own workspace
 * (`qa-harness-<stamp>`) through the real signup flow, scopes every DB
 * assertion to `companyId: myTenantId`, and removes it children-first in
 * `finally`. Tier B runs nothing that could write. `localDb()` pins the client
 * to the loopback docker Postgres; a bare `new PrismaClient()` would auto-load
 * the root .env, which names production Supabase.
 *
 * Run:  node scripts/qa-harness-auditor.mjs
 *       (BASE must point at the dev server for the tenant-signup section)
 */

import puppeteer from "puppeteer-core";
import { localDb } from "./_local-db.mjs";
import { readFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/* ─────────────────────────── conventions ─────────────────────────── */

const AGENT_INDEX = 21;
const DOMAIN = "harness-auditor";
const BASE = process.env.BASE ?? "http://localhost:3000";
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const SHOT_DIR = `C:/Users/USER/AppData/Local/Temp/ff-qa/${DOMAIN}`;
const REPO = fileURLToPath(new URL("..", import.meta.url));
const STAMP = `${Date.now().toString().slice(-7)}`;

const TENANT_NAME = `qa-harness-${STAMP}`;
const TENANT_EMAIL = `qa-harness-${STAMP}@founderflow.test`;
const TENANT_PASSWORD = "Harness123";
const TENANT_USER = "Harness Auditor";

mkdirSync(SHOT_DIR, { recursive: true });

const db = localDb();

let okCount = 0;
const failures = [];

function ok(label) {
  okCount += 1;
  console.log(`  ok  ${label}`);
}

/**
 * Records a failure without throwing, so ONE run reports every broken
 * assertion instead of stopping at the first. The literal ❌ is what
 * scripts/run-all-smoke.sh greps for; `  FAIL ` is the newer dialect it also
 * counts. Printing both means neither runner generation can miss this.
 */
function fail(label, detail) {
  failures.push(label);
  process.exitCode = 1;
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  console.error(`❌ ${label}`);
}

function section(title) {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 62 - title.length))}`);
}

/** Repo-relative, forward-slashed. */
function rel(abs) {
  return relative(REPO, abs).split(sep).join("/");
}

function read(abs) {
  return readFileSync(abs, "utf8");
}

/**
 * Blank out comments while preserving length, so prose that DISCUSSES a
 * hazard is never credited (or blamed) as code. The first run of this script's
 * auth sweep reported app/(app)/budgets/page.tsx as guarded because it named
 * `requireScopedSession()` in a doc comment.
 */
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .split(/\r?\n/)
    .map((line) => {
      const i = line.indexOf("//");
      return i === -1 ? line : line.slice(0, i) + " ".repeat(line.length - i);
    })
    .join("\n");
}

function walk(dir, test, found = []) {
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      walk(full, test, found);
    } else if (test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

/* ══════════════════════════════════════════════════════════════════════
 * TIER A — STRUCTURAL AUDITS OF THE TEST SUITE AND THE HARNESS
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * A1. Reachability. THE headline check.
 *
 * tests/lib/auth/channel-permissions.test.ts has 34 green cases. Eleven of
 * them prove properties of `canManageChannel` and `canPostRunwayCard` —
 * predicates the product never evaluates, because nothing reachable calls the
 * actions behind them. A permission predicate with a passing unit test READS
 * as shipped, which is precisely why six dead actions survived to a go-live
 * audit. Coverage of dead code is worse than no coverage: it is coverage that
 * lies.
 *
 * The rule: an exported action or permission predicate must have at least one
 * call site OUTSIDE the file that declares it and outside tests/. Tests do not
 * count as reachability — that is the whole point.
 */
function auditReachability() {
  section("A1 reachability — exports the product never calls");

  const declaringDirs = [join(REPO, "lib", "actions"), join(REPO, "lib", "auth")];
  const callSiteFiles = [
    ...walk(join(REPO, "lib"), (n) => /\.tsx?$/.test(n)),
    ...walk(join(REPO, "app"), (n) => /\.tsx?$/.test(n)),
    ...walk(join(REPO, "components"), (n) => /\.tsx?$/.test(n)),
  ].map((f) => ({ path: f, src: codeOnly(read(f)) }));

  if (callSiteFiles.length < 50) {
    fail("A1 scan reach", `only ${callSiteFiles.length} source files scanned — wrong roots`);
    return;
  }

  const exported = [];
  for (const dir of declaringDirs) {
    for (const file of walk(dir, (n) => n.endsWith(".ts") && n !== "types.ts")) {
      const src = codeOnly(read(file));
      for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/g)) {
        exported.push({ name: m[1], file });
      }
    }
  }

  if (exported.length < 40) {
    fail("A1 export scan", `found only ${exported.length} exports — the regex stopped matching`);
    return;
  }
  ok(`scanned ${exported.length} exported functions across lib/actions + lib/auth`);

  const dead = [];
  for (const { name, file } of exported) {
    const word = new RegExp(`\\b${name}\\b`);
    const users = callSiteFiles.filter((f) => f.path !== file && word.test(f.src));
    if (users.length === 0) dead.push(`${name} (${rel(file)})`);
  }

  // A known set is NOT hardcoded as an allowance — it is printed so the
  // difference between "the six the audit already found" and "a seventh" is
  // legible in the log.
  if (dead.length === 0) {
    ok("every exported action and permission predicate has a non-test caller");
  } else {
    fail(
      "A1 dead exports",
      `${dead.length} export(s) are unreachable from any non-test module:\n        ` +
        dead.join("\n        ")
    );
  }

  /**
   * The second pass, one step weaker and one step broader: an export with
   * references in lib/ but NONE in app/ or components/. Reference counting
   * cannot see a chain (an action called only from another dead action), and
   * `canManageChannel` is only ever named in COMMENTS — which codeOnly()
   * strips, which is why pass one catches it. This pass catches the rest:
   * server code nothing in the UI tree can reach.
   *
   * KNOWN LIMIT, stated rather than hidden: it cannot see a call site that
   * exists but is gated by a prop defaulting to false. `postRunwayCardAction`
   * is referenced once in components/chat/message-composer.tsx behind
   * `canPostRunway`, which defaults false and no caller passes — so it reads
   * as reachable here and is not. That shape needs prop-default analysis.
   */
  const uiRoots = [join(REPO, "app"), join(REPO, "components")];
  const noUiRef = [];
  for (const { name, file } of exported) {
    const word = new RegExp(`\\b${name}\\b`);
    const inUi = callSiteFiles.some(
      (f) => f.path !== file && uiRoots.some((r) => f.path.startsWith(r)) && word.test(f.src)
    );
    const inLib = callSiteFiles.some((f) => f.path !== file && word.test(f.src));
    if (!inUi && inLib) noUiRef.push(`${name} (${rel(file)})`);
  }
  if (noUiRef.length === 0) {
    ok("no export is reachable only from other server code");
  } else {
    fail(
      "A1 no UI reference",
      `${noUiRef.length} export(s) are named in lib/ but nowhere under app/ or components/, ` +
        `so no user action can reach them:\n        ` +
        noUiRef.join("\n        ")
    );
  }

  // The narrower, sharper claim: a predicate that is TESTED but dead. These
  // are the green cases that made nobody look.
  const testSrc = walk(join(REPO, "tests"), (n) => /\.tsx?$/.test(n))
    .map((f) => read(f))
    .join("\n");
  const testedButDead = dead.filter((d) => new RegExp(`\\b${d.split(" ")[0]}\\b`).test(testSrc));
  if (testedButDead.length === 0) {
    ok("no unit test spends its assertions on an unreachable export");
  } else {
    fail(
      "A1 tested dead code",
      `these have GREEN unit tests and no caller — the tests read as proof the feature ships:\n        ` +
        testedButDead.join("\n        ")
    );
  }
}

/**
 * A2. The missing page-auth guard.
 *
 * The audit found ONE unguarded page (/budgets). A guard written in the style
 * this repo already uses for six other invariants would have found all of
 * them, on the day each landed, without anybody remembering anything. This is
 * that guard, run from outside — which is the finding: it does not exist
 * inside tests/.
 */
function auditPageAuth() {
  section("A2 page auth — the structural guard tests/ does not have");

  const pages = walk(join(REPO, "app", "(app)"), (n) => n === "page.tsx");
  if (pages.length < 10) {
    fail("A2 scan reach", `only ${pages.length} authenticated pages found`);
    return;
  }

  const unguarded = pages.filter(
    (p) => !/requireScopedSession\s*\(|\bauth\s*\(\s*\)/.test(codeOnly(read(p)))
  );

  console.log(`  scanned ${pages.length} pages under app/(app)/`);
  if (unguarded.length === 0) {
    ok("every authenticated page resolves a session server-side");
  } else {
    fail(
      "A2 unguarded pages",
      `${unguarded.length} page(s) render without resolving a session; middleware is the only gate:\n        ` +
        unguarded.map(rel).join("\n        ")
    );
  }

  // The reason this matters for MY domain: no test asserts it.
  const guardExists = walk(join(REPO, "tests"), (n) => /\.tsx?$/.test(n)).some((f) => {
    const s = read(f);
    return s.includes("page.tsx") && /requireScopedSession|auth\(\)/.test(s);
  });
  if (guardExists) ok("tests/ contains a page-auth structural guard");
  else
    fail(
      "A2 guard missing",
      "no file under tests/ sweeps app/(app)/**/page.tsx for a session call, so the next " +
        "unguarded page ships green"
    );
}

/**
 * A3. The missing action-auth guard. Same shape, other layer.
 * `lib/actions/activities.ts` has no `auth()` anywhere in the file.
 */
function auditActionAuth() {
  section("A3 action auth — every exported action must resolve a caller");

  const files = walk(join(REPO, "lib", "actions"), (n) => n.endsWith(".ts") && n !== "types.ts");
  const offenders = [];
  let examined = 0;

  for (const file of files) {
    const src = codeOnly(read(file));
    // One exported function's body, up to the next column-zero close brace.
    const starts = [...src.matchAll(/export\s+async\s+function\s+([A-Za-z0-9_]+)/g)];
    for (let i = 0; i < starts.length; i++) {
      const name = starts[i][1];
      const from = starts[i].index;
      const to = i + 1 < starts.length ? starts[i + 1].index : src.length;
      const body = src.slice(from, to);
      examined += 1;
      // A "list"/"get" reader is still a reader of tenant data.
      if (!/requireScopedSession\s*\(|\bauth\s*\(\s*\)|getServerSession/.test(body)) {
        offenders.push(`${name} (${rel(file)})`);
      }
    }
  }

  if (examined < 40) {
    fail("A3 scan reach", `only ${examined} actions parsed`);
    return;
  }
  console.log(`  parsed ${examined} exported server actions`);

  if (offenders.length === 0) {
    ok("every exported server action resolves a session in its own body");
  } else {
    fail(
      "A3 actions with no auth",
      `${offenders.length} exported action(s) never resolve a caller. Any of these that is ` +
        `reachable is an unauthenticated read or write:\n        ` +
        offenders.join("\n        ")
    );
  }
}

/**
 * A4. Smoke scripts that cannot report a failure.
 *
 * run-all-smoke.sh classifies a run by grepping the log for ❌ or "  FAIL ".
 * A script that prints neither and exits 0 is reported as OK forever. This is
 * the static half; Tier B proves it empirically.
 */
function auditSmokeAssertions() {
  section("A4 smoke scripts — can they report a failure at all?");

  const smokes = readdirSync(join(REPO, "scripts"))
    .filter((f) => /^(smoke.*|verify-ui)\.mjs$/.test(f))
    .sort();

  if (smokes.length < 20) {
    fail("A4 scan reach", `only ${smokes.length} smoke scripts found`);
    return;
  }
  console.log(`  inspecting ${smokes.length} smoke scripts`);

  const mute = [];
  const earlyExit = [];

  for (const name of smokes) {
    const abs = join(REPO, "scripts", name);
    const src = read(abs);
    const code = codeOnly(src);

    // Can it EVER emit a marker the runner counts, or a non-zero exit?
    const emitsMarker = /❌|^\s*FAIL\s|"\s*FAIL|`\s*FAIL|  FAIL /m.test(code);
    const canExitNonZero =
      /process\.exitCode\s*=\s*1/.test(code) ||
      /process\.exit\(\s*[^0]/.test(code) ||
      /process\.exit\(\s*\w+\s*\?\s*0\s*:\s*[^0]/.test(code) ||
      /process\.exit\(\s*[a-zA-Z_.]+\s*===?\s*0\s*\?\s*0\s*:/.test(code) ||
      /process\.exit\([^)]*length[^)]*\?/.test(code);

    if (!emitsMarker && !canExitNonZero) mute.push(name);

    // An unconditional exit(0) that sits BEFORE the pass criteria. This is the
    // smoke-push.mjs shape: headless Chrome cannot create a push subscription,
    // so the "SKIPPED" branch fires every single run and the script exits 0
    // before `pass` is ever computed.
    const exitZero = code.indexOf("process.exit(0)");
    if (exitZero !== -1) {
      const after = code.slice(exitZero);
      if (/❌|FAIL/.test(after)) earlyExit.push(name);
    }
  }

  if (mute.length === 0) {
    ok("every smoke script has some path to a failure marker or a non-zero exit");
  } else {
    fail(
      "A4 mute smokes",
      `${mute.length} script(s) cannot report a failure in any code path — the runner has ` +
        `been logging them as OK:\n        ` +
        mute.join("\n        ")
    );
  }

  if (earlyExit.length === 0) {
    ok("no smoke script short-circuits with exit(0) ahead of its own pass criteria");
  } else {
    fail(
      "A4 skip-before-assert",
      `${earlyExit.length} script(s) reach an unconditional process.exit(0) with failure ` +
        `reporting still downstream of it:\n        ` +
        earlyExit.join("\n        ")
    );
  }
}

/**
 * A5. Scripts that mutate pre-existing data, and restore it to a LITERAL.
 *
 * scripts/smoke-session-invalidation.mjs sets a seeded user's sessionVersion
 * back to 0 rather than to the value it read. If a password reset had already
 * bumped that user to 3, the smoke silently re-validates every token the reset
 * deliberately revoked. scripts/smoke-multi-admin.mjs does the same with
 * `role = 'member'` — it reads the prior role into a variable and then
 * restores a literal anyway.
 */
function auditSeedMutation() {
  section("A5 harness scripts that write to pre-existing data");

  const scripts = readdirSync(join(REPO, "scripts"))
    .filter((f) => f.endsWith(".mjs") && !f.startsWith("qa-") && f !== "_qa-guard.mjs")
    .sort();

  const rawSql = [];
  const literalRestore = [];

  for (const name of scripts) {
    const code = codeOnly(read(join(REPO, "scripts", name)));
    if (/docker\s+exec[^"'`]*psql/.test(code)) {
      // Only flag the ones that WRITE.
      if (/UPDATE\s+"|DELETE\s+FROM\s+"|INSERT\s+INTO\s+"/i.test(code)) rawSql.push(name);
    }
    // A restore that hardcodes the value it is restoring TO.
    for (const m of code.matchAll(
      /UPDATE\s+"(\w+)"\s+SET\s+"?(\w+)"?\s*=\s*('[^']*'|\d+|NULL)/gi
    )) {
      const [, table, column, value] = m;
      if (/^(role|sessionVersion|deletedAt|plan|status)$/i.test(column)) {
        literalRestore.push(`${name}: UPDATE "${table}" SET ${column} = ${value}`);
      }
    }
  }

  if (rawSql.length === 0) {
    ok("no harness script writes SQL directly to the shared database");
  } else {
    fail(
      "A5 raw SQL writes",
      `${rawSql.length} script(s) UPDATE/DELETE the shared database through ` +
        `\`docker exec psql\`, which bypasses _local-db.mjs entirely — ` +
        `tests/lib/db/script-safety.test.ts only forbids a bare \`new Prisma` + `Client()\`, ` +
        `so this ` +
        `path is unguarded:\n        ` +
        rawSql.join("\n        ")
    );
  }

  if (literalRestore.length === 0) {
    ok("no script restores a mutated column to a hardcoded value");
  } else {
    fail(
      "A5 literal restores",
      `these restore a seeded row to a LITERAL rather than to the value they read, so a run ` +
        `against any workspace whose real value differs corrupts it permanently:\n        ` +
        literalRestore.join("\n        ")
    );
  }

  // The guard that would have caught the raw-SQL hole.
  const safetyTest = join(REPO, "tests", "lib", "db", "script-safety.test.ts");
  if (existsSync(safetyTest)) {
    const s = read(safetyTest);
    if (/docker\s+exec|psql/.test(s)) {
      ok("script-safety.test.ts also covers the docker-exec/psql escape hatch");
    } else {
      fail(
        "A5 guard gap",
        "tests/lib/db/script-safety.test.ts forbids a bare `new Prisma" + "Client()` but says " +
        "nothing " +
          "about `docker exec … psql`, which reaches the same database with no host check " +
          "and no loopback proof"
      );
    }
  }
}

/**
 * A6. Assertions that another agent's insert can satisfy.
 *
 * A bare `db.task.count()` answers "did SOMETHING land", not "did MINE land".
 * Sequentially that reads as fine; the moment two scripts run at once it is a
 * FALSE PASS, which is the most expensive outcome a pre-launch audit can
 * produce.
 */
function auditUnscopedAssertions() {
  section("A6 unscoped DB assertions in the harness");

  const scripts = readdirSync(join(REPO, "scripts"))
    .filter((f) => f.endsWith(".mjs") && !f.startsWith("qa-"))
    .sort();

  const bare = [];
  for (const name of scripts) {
    const code = codeOnly(read(join(REPO, "scripts", name)));
    code.split(/\r?\n/).forEach((line, i) => {
      // `db.model.count()` with nothing inside, or findFirst/findMany whose
      // only argument is an orderBy — both answer a question about the whole
      // table.
      if (/\bdb\.[a-zA-Z]+\.count\(\s*\)/.test(line)) {
        bare.push(`${name}:${i + 1} — ${line.trim()}`);
      } else if (/\bdb\.[a-zA-Z]+\.(findFirst|findMany)\(\{\s*orderBy/.test(line)) {
        bare.push(`${name}:${i + 1} — ${line.trim()}`);
      }
    });
  }

  // wipe-data.mjs is exempt BY DESIGN: it is supposed to be unscoped, and
  // _local-db.mjs proves the host is loopback before it can run. Named here
  // rather than pattern-matched so the exemption is visible.
  const exempt = new Set(["wipe-data.mjs"]);
  const flagged = bare.filter((b) => !exempt.has(b.split(":")[0]));

  if (flagged.length === 0) {
    ok("every harness DB assertion is scoped to a tenant");
  } else {
    fail(
      "A6 unscoped assertions",
      `${flagged.length} whole-table read(s) used as evidence. Under any concurrency these ` +
        `can pass on another script's row:\n        ` +
        flagged.join("\n        ")
    );
  }
}

/**
 * A7. Coverage configuration that cannot fail.
 *
 * vitest.config.ts includes only lib/** and components/**, excludes lib/auth.ts
 * — the jwt callback — and sets no threshold. `npm run test:coverage` therefore
 * reports 100% of nothing and exits 0 whatever happens. A coverage report that
 * cannot go red is a dashboard, not a gate.
 */
function auditCoverageConfig() {
  section("A7 coverage config");

  const cfgPath = join(REPO, "vitest.config.ts");
  const cfg = read(cfgPath);

  if (/thresholds?\s*:/.test(cfg)) {
    ok("coverage declares a threshold, so it can fail");
  } else {
    fail(
      "A7 no coverage threshold",
      "vitest.config.ts sets no coverage.thresholds, so `npm run test:coverage` exits 0 at " +
        "any coverage level — including 0%"
    );
  }

  if (/include:\s*\[[^\]]*app\//.test(cfg)) {
    ok("coverage includes app/ (routes, API handlers, crons)");
  } else {
    fail(
      "A7 coverage blind to app/",
      "coverage.include is lib/** + components/** only. The LemonSqueezy webhook, the three " +
        "cron routes, /api/export and all 25 page routes are not merely uncovered — they are " +
        "absent from the report, so the gap is invisible"
    );
  }

  if (/exclude:[^\]]*lib\/auth\.ts/.test(cfg)) {
    fail(
      "A7 auth excluded from coverage",
      "lib/auth.ts — the jwt callback that decides whether a tombstoned user keeps reading " +
        "data — is on coverage.exclude, so its untested branches never show up"
    );
  } else {
    ok("lib/auth.ts is not excluded from coverage");
  }
}

/**
 * A8. The TZ pin lives in package.json, not in vitest.config.ts.
 *
 * That is deliberate and correct (test.env applies after module code may have
 * constructed Dates). The risk it creates is that `npx vitest run` — which
 * this audit's own instructions permit — silently unpins the zone. Assert the
 * pin is on EVERY vitest script, not just `test`.
 */
function auditTzPin() {
  section("A8 timezone pin on the vitest scripts");

  const pkg = JSON.parse(read(join(REPO, "package.json")));
  const vitestScripts = Object.entries(pkg.scripts).filter(([, cmd]) => /\bvitest\b/.test(cmd));

  if (vitestScripts.length === 0) {
    fail("A8 scan reach", "no vitest npm script found");
    return;
  }

  const unpinned = vitestScripts.filter(([, cmd]) => !/cross-env\s+TZ=/.test(cmd));
  if (unpinned.length === 0) {
    ok(`all ${vitestScripts.length} vitest scripts pin TZ via cross-env`);
  } else {
    fail(
      "A8 unpinned vitest script",
      `these run vitest without a TZ pin, so the calendar day-edge cases go vacuous when ` +
        `anyone uses them:\n        ` +
        unpinned.map(([n, c]) => `${n}: ${c}`).join("\n        ")
    );
  }
}

/**
 * A9. CI runs no smoke, and the runner cannot fail.
 *
 * run-all-smoke.sh records ok/fail/pageerr per script to a summary and then
 * ends with `echo "=== DONE ==="`. It never propagates a failure, so wiring it
 * into CI as-is would add a step that is green by construction — the
 * smoke-rate-limit bug at suite scale.
 */
function auditRunnerAndCi() {
  section("A9 the runner and CI");

  const runner = read(join(REPO, "scripts", "run-all-smoke.sh"));

  if (/exit\s+\$?\{?[A-Za-z_]/.test(runner) || /exit\s+1/.test(runner)) {
    ok("run-all-smoke.sh propagates a non-zero exit");
  } else {
    fail(
      "A9 runner always green",
      "scripts/run-all-smoke.sh never exits non-zero. It prints ASSERT/EXIT/TIMEOUT lines " +
        "into a summary a human must read, so as a CI step it would pass with every script " +
        "broken"
    );
  }

  // Every script the runner names must exist — it prints SKIP and carries on.
  const listed = [...runner.matchAll(/^\s{2}([a-z0-9-]+)\s*$/gm)].map((m) => m[1]);
  const missing = listed.filter((n) => !existsSync(join(REPO, "scripts", `${n}.mjs`)));
  if (listed.length < 15) {
    fail("A9 runner parse", `only parsed ${listed.length} script names from the runner`);
  } else if (missing.length === 0) {
    ok(`all ${listed.length} scripts the runner names exist on disk`);
  } else {
    fail("A9 runner names a missing script", `SKIPped silently: ${missing.join(", ")}`);
  }

  // Ordering claim: the runner says rate-limit is last because it trips the
  // login limiter. That is only true if the limiter key differs per script —
  // and getClientIp() returns the literal "unknown" in dev, so every script
  // shares ONE limiters.auth bucket.
  const ip = read(join(REPO, "lib", "client-ip.ts"));
  const sharesBucket = /return\s+"unknown"/.test(ip);
  const anySetsRealIp = readdirSync(join(REPO, "scripts"))
    .filter((f) => /^(smoke.*|verify-ui)\.mjs$/.test(f))
    .some((f) => /x-real-ip/i.test(read(join(REPO, "scripts", f))));
  if (sharesBucket && !anySetsRealIp) {
    fail(
      "A9 shared rate-limit bucket",
      'getClientIp() falls back to the literal "unknown" when no x-real-ip / x-forwarded-for ' +
        "header is present, and no smoke script sets one. Every sign-in in the suite therefore " +
        "shares ONE limiters.auth bucket of 5/60s fed by nine call sites, so a script that " +
        "signs in three users starves whichever runs next — and the failure reads as " +
        '"cannot sign in", not as "rate limited"'
    );
  } else {
    ok("smoke scripts key the rate limiter per script");
  }

  const ci = read(join(REPO, ".github", "workflows", "ci.yml"));
  if (/run-all-smoke|smoke-/.test(ci)) {
    ok("CI runs at least one smoke script");
  } else {
    fail(
      "A9 CI runs no smoke",
      "ci.yml runs typecheck + vitest + lint + build. Not one of the 24 puppeteer smokes " +
        "runs anywhere automated, so every assertion they hold fires only when somebody " +
        "remembers to run them by hand"
    );
  }
}

/**
 * A10. The audit's own guard — does _qa-guard.mjs cover every table?
 *
 * A checksum guard that misses a table is a licence to write to it. Derive the
 * model list from prisma/schema.prisma rather than trusting the guard's own
 * list, which is exactly the technique purge-invariants.test.ts uses on the
 * purge cron.
 */
function auditTheGuard() {
  section("A10 _qa-guard.mjs — the guard's own coverage");

  const schema = read(join(REPO, "prisma", "schema.prisma"));
  const models = [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]);
  if (models.length < 12) {
    fail("A10 schema parse", `only ${models.length} models parsed`);
    return;
  }

  const guard = read(join(REPO, "scripts", "_qa-guard.mjs"));
  const delegate = (m) => m.charAt(0).toLowerCase() + m.slice(1);
  const uncovered = models.filter((m) => !new RegExp(`["']${delegate(m)}["']|db\\.${delegate(m)}\\b`).test(guard));

  console.log(`  schema declares ${models.length} models`);
  if (uncovered.length === 0) {
    ok("the data-safety guard hashes every model in the schema");
  } else {
    fail(
      "A10 guard blind spot",
      `${uncovered.length} model(s) are absent from _qa-guard.mjs, so a write there would ` +
        `not be detected and the sweeper would leave the rows behind: ${uncovered.join(", ")}`
    );
  }

  // Scope: the guard watches ONE company id.
  if (/DEMO_COMPANY_ID\s*=\s*"demo-nimbus"/.test(guard) && !/companies|allCompanies/.test(guard)) {
    console.log(
      "  note: verify() snapshots only demo-nimbus — damage to any other pre-existing\n" +
        "        workspace (a real signup, a leftover throwaway) is invisible to it"
    );
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * TIER B — THE NULL-SERVER MUTATION TEST
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * Refuse to run anything that could write. A smoke is cleared only if it
 * contains no raw SQL path and no Prisma write of any kind. Reads through
 * localDb() are fine — they are reads, and _local-db.mjs has already proved
 * the host is loopback.
 *
 * Note what this deliberately does NOT do: it does not try to reason about
 * whether a `deleteMany` is "narrow enough". A where-clause that looks scoped
 * (`{ title: { startsWith: "Smoke" } }`) can still match a seeded row, and the
 * cost of being wrong here is somebody's data. Any write at all disqualifies.
 */
function clearedForNullRun(name) {
  const code = codeOnly(read(join(REPO, "scripts", name)));
  const hazards = [];
  if (/execSync|spawnSync|docker\s+exec/.test(code)) hazards.push("shells out (raw SQL path)");
  for (const m of code.matchAll(
    /\bdb\.[a-zA-Z]+\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/g
  )) {
    hazards.push(`prisma write: ${m[0].replace(/\($/, "")}`);
  }
  if (/\$executeRaw|\$queryRawUnsafe/.test(code)) hazards.push("raw prisma execute");
  return { cleared: hazards.length === 0, hazards: [...new Set(hazards)] };
}

/** An HTTP server that answers everything with a valid but empty page. */
function startNullServer() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.url === "/favicon.ico") {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><html><head><title>null</title></head><body></body></html>");
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

function runScript(name, base, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(REPO, "scripts", name)], {
      cwd: REPO,
      env: { ...process.env, BASE: base, DEV_LOG: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let done = false;
    const finish = (code, timedOut) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, out, timedOut });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null, true);
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => finish(code, false));
    child.on("error", () => finish(-1, false));
  });
}

async function auditByNullServer() {
  section("B the null-server mutation test — which smokes can actually fail?");

  const smokes = readdirSync(join(REPO, "scripts"))
    .filter((f) => /^(smoke.*|verify-ui)\.mjs$/.test(f))
    .sort();

  const refused = [];
  const candidates = [];
  for (const name of smokes) {
    const { cleared, hazards } = clearedForNullRun(name);
    if (cleared) candidates.push(name);
    else refused.push(`${name} — ${hazards.join("; ")}`);
  }

  console.log(`  ${candidates.length} script(s) cleared to run, ${refused.length} refused`);
  if (refused.length) {
    console.log("  refused (they write; running them would breach the data-safety rule):");
    for (const r of refused) console.log(`      ${r}`);
  }

  if (candidates.length === 0) {
    fail(
      "B nothing runnable",
      "no smoke script could be cleared for the null-server run, so this tier proved nothing"
    );
    return;
  }

  const { server, port } = await startNullServer();
  const nullBase = `http://127.0.0.1:${port}`;
  console.log(`  null server on ${nullBase} — serves a valid, empty page for every route`);

  const cannotFail = [];
  const canFail = [];

  try {
    for (const name of candidates) {
      const { code, out, timedOut } = await runScript(name, nullBase, 150_000);
      const marker = /❌|  FAIL /.test(out);
      const reported = timedOut || code !== 0 || marker;
      const verdict = timedOut
        ? "TIMEOUT (counts — the runner catches it)"
        : reported
          ? `reported (exit=${code}, marker=${marker})`
          : `SILENT PASS (exit=${code}, no marker)`;
      console.log(`    ${reported ? "ok  " : "FAIL"} ${name.padEnd(34)} ${verdict}`);
      if (reported) canFail.push(name);
      else cannotFail.push(name);
    }
  } finally {
    server.close();
  }

  if (cannotFail.length === 0) {
    ok(`all ${canFail.length} cleared smoke scripts failed against an empty app`);
  } else {
    fail(
      "B smokes that cannot fail",
      `${cannotFail.length} script(s) exited 0 with no failure marker against an app that ` +
        `renders NOTHING. They assert nothing; run-all-smoke.sh reports them OK:\n        ` +
        cannotFail.join("\n        ")
    );
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * TIER C — THE TRIPWIRE OBSERVATION
 * ══════════════════════════════════════════════════════════════════════ */

function runVitest(file, tz, timeoutMs = 180_000) {
  return new Promise((resolve) => {
    const child = spawn(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["vitest", "run", file, "--reporter=basic"],
      { cwd: REPO, env: { ...process.env, TZ: tz }, stdio: ["ignore", "pipe", "pipe"], shell: true }
    );
    let out = "";
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      resolve({ code, out });
    };
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", finish);
    child.on("error", () => finish(-1));
  });
}

async function auditTzTripwire() {
  section("C the TZ tripwire — is the calendar guard real?");

  const file = "tests/lib/tasks/calendar.test.ts";

  const pinned = await runVitest(file, "America/Bogota");
  if (pinned.code === 0) {
    ok("calendar suite passes under the pinned zone (America/Bogota)");
  } else {
    fail(
      "C pinned run red",
      `${file} fails under its own pinned zone (exit ${pinned.code}) — the day-edge ` +
        `arithmetic is broken, not the pin`
    );
    return;
  }

  const utc = await runVitest(file, "UTC");
  if (utc.code !== 0 && /must NOT run in UTC|outside UTC/i.test(utc.out)) {
    ok("the tripwire fires under TZ=UTC, naming the pin — the day-edge cases are not vacuous");
  } else if (utc.code !== 0) {
    ok(`the suite fails under TZ=UTC (exit ${utc.code}), so the pin is load-bearing`);
  } else {
    fail(
      "C tripwire is decoration",
      `${file} PASSES under TZ=UTC. In UTC a local calendar day and a UTC calendar day are ` +
        `the same day, so every day-edge assertion in it passes against correct code and ` +
        `against UTC-day bucketing alike. The assertPinned guard did not fire`
    );
  }

  // Runtime case count: a file that contributes zero cases is a file that
  // cannot fail. `it.each` over an empty array is the usual way in.
  const all = await runVitest("tests", "America/Bogota", 420_000);
  const m = all.out.match(/Tests\s+(\d+)\s+passed/);
  const files = all.out.match(/Test Files\s+(\d+)\s+passed/);
  if (m && files) {
    console.log(`  full suite: ${files[1]} files, ${m[1]} cases, exit ${all.code}`);
    if (Number(files[1]) < 60) {
      fail(
        "C suite shrank",
        `only ${files[1]} test files ran; the repo has 63. A file that contributes zero ` +
          `cases is a file that cannot fail`
      );
    } else {
      ok(`${files[1]} test files and ${m[1]} cases actually executed`);
    }
  } else if (all.code === 0) {
    ok("full suite green (case count not parseable from this reporter)");
  } else {
    fail("C full suite red", `exit ${all.code} — see output above`);
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * OWN TENANT — conventions, and one scoped observation
 * ══════════════════════════════════════════════════════════════════════ */

function wire(page) {
  page.on("pageerror", (e) => console.error("PAGEERROR:", e.message));
  page.on("console", (m) => {
    if (m.type() === "error") console.error("CONSOLE.error:", m.text());
  });
}

/**
 * Sign in, retrying until React owns the click.
 *
 * On a cold dev server the form paints before hydration; a click that lands
 * first performs a NATIVE submit, which (the form declares no method) becomes
 * a GET with the credentials in the query string and no sign-in at all.
 * FaultsAudit A14. Copied verbatim from scripts/smoke-chat.mjs.
 */
async function signIn(page, email, password) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle0" });
    await page.waitForSelector("input[type=email]", { timeout: 30000 });
    await page.waitForFunction(
      () => {
        const f = document.querySelector("form");
        const b = document.querySelector('button[type="submit"]');
        return !!f && !!b && !b.disabled;
      },
      { timeout: 30000 }
    );
    await page.type("input[type=email]", email);
    await page.type("input[type=password]", password);
    await page.click("button[type=submit]");
    const left = await page
      .waitForFunction(() => !location.pathname.startsWith("/login"), { timeout: 30000 })
      .then(() => true)
      .catch(() => false);
    if (left) {
      await page.waitForNavigation({ waitUntil: "networkidle0", timeout: 5000 }).catch(() => {});
      return true;
    }
  }
  return false;
}

async function setField(page, selector, value) {
  await page.evaluate(
    (sel, v) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error(`no element for ${sel}`);
      const proto =
        el.tagName === "SELECT"
          ? window.HTMLSelectElement.prototype
          : el.tagName === "TEXTAREA"
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
      el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
    },
    selector,
    value
  );
}

/**
 * Creates this agent's own workspace through the real signup flow. Returns the
 * tenant id, or null.
 *
 * Why this section exists in a static-analysis domain: the conventions demand
 * it, and it buys one observation nothing else can make — that the audit's own
 * data-safety guard treats a fresh tenant as invisible (it snapshots only
 * demo-nimbus), which is the property every other agent's cleanup depends on.
 */
async function createOwnTenant(browser) {
  section("tenant — signing up qa-harness through the real flow");

  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  wire(page);
  // Without this, getClientIp() returns the literal "unknown" and all 21
  // agents share ONE limiters.auth bucket of 5/60s. See A9.
  await page.setExtraHTTPHeaders({ "x-real-ip": `10.99.0.${AGENT_INDEX}` });

  try {
    await page.goto(`${BASE}/signup`, { waitUntil: "networkidle0", timeout: 60000 });
    await page.waitForFunction(() => !!document.querySelector('input[name="email"]'), {
      timeout: 30000,
    });

    await setField(page, 'input[name="name"]', TENANT_USER);
    await setField(page, 'input[name="email"]', TENANT_EMAIL);
    await setField(page, 'input[name="password"]', TENANT_PASSWORD);
    await setField(page, 'input[name="companyName"]', TENANT_NAME);
    await page.evaluate(() => document.querySelector("form")?.requestSubmit());

    // State predicate, never a fixed wait: the signup lands off /signup.
    const left = await page
      .waitForFunction(() => !location.pathname.startsWith("/signup"), { timeout: 45000 })
      .then(() => true)
      .catch(() => false);
    await page.screenshot({ path: `${SHOT_DIR}/tenant-after-signup.png` });

    // EVERY assertion carries my own companyId. A bare count could be
    // satisfied by another agent's signup and produce a false pass.
    const mine = await db.company.findFirst({
      where: { name: TENANT_NAME },
      select: { id: true, name: true },
    });
    if (!mine) {
      fail("tenant signup", `no Company named ${TENANT_NAME} after signup (landed=${left})`);
      await ctx.close();
      return null;
    }
    ok(`own workspace created: ${mine.name} (${mine.id})`);

    const users = await db.user.count({ where: { companyId: mine.id } });
    if (users === 1) ok("exactly one user in my tenant");
    else fail("tenant user count", `expected 1 user in ${mine.id}, found ${users}`);

    const signedIn = await signIn(page, TENANT_EMAIL, TENANT_PASSWORD);
    if (signedIn) ok("can sign in to my own tenant (rate-limit bucket is mine alone)");
    else
      fail(
        "tenant sign-in",
        "could not sign in after 3 hydration-aware attempts — if this is a 429, the " +
          "x-real-ip header is not reaching getClientIp()"
      );

    await ctx.close();
    return mine.id;
  } catch (e) {
    fail("tenant setup threw", e.message);
    await ctx.close().catch(() => {});
    return null;
  }
}

/** Children before parents, and only ever my own rows. */
async function cleanupTenant(tenantId) {
  if (!tenantId) return;
  section("cleanup");
  const ordered = [
    ["messageReaction", { message: { companyId: tenantId } }],
    ["message", { companyId: tenantId }],
    ["channelMember", { channel: { companyId: tenantId } }],
    ["channel", { companyId: tenantId }],
    ["comment", { companyId: tenantId }],
    ["timeEntry", { companyId: tenantId }],
    ["notification", { companyId: tenantId }],
    ["activity", { companyId: tenantId }],
    ["inviteToken", { companyId: tenantId }],
    ["recurringRule", { companyId: tenantId }],
    ["budget", { companyId: tenantId }],
    ["transaction", { companyId: tenantId }],
    ["task", { companyId: tenantId }],
    ["project", { companyId: tenantId }],
    ["notificationPreference", { user: { companyId: tenantId } }],
    ["pushSubscription", { user: { companyId: tenantId } }],
  ];
  let removed = 0;
  for (const [model, where] of ordered) {
    try {
      const { count } = await db[model].deleteMany({ where });
      removed += count;
    } catch (e) {
      console.error(`  cleanup ${model}: ${e.message}`);
    }
  }
  try {
    await db.company.update({ where: { id: tenantId }, data: { ownerId: null } });
    const { count } = await db.user.deleteMany({ where: { companyId: tenantId } });
    removed += count;
    await db.company.delete({ where: { id: tenantId } });
    removed += 1;
    ok(`tenant ${tenantId} removed (${removed} rows)`);
  } catch (e) {
    fail("cleanup tenant", `${tenantId} may survive: ${e.message}`);
  }
}

/* ═════════════════════════════════ main ═════════════════════════════════ */

async function main() {
  console.log(`== qa audit: ${DOMAIN} (agent ${AGENT_INDEX}) ==`);
  console.log(`   BASE=${BASE}  screenshots=${SHOT_DIR}`);

  // Tier A first: it needs neither a browser nor a server, so it still
  // produces findings if the dev server is down.
  auditReachability();
  auditPageAuth();
  auditActionAuth();
  auditSmokeAssertions();
  auditSeedMutation();
  auditUnscopedAssertions();
  auditCoverageConfig();
  auditTzPin();
  auditRunnerAndCi();
  auditTheGuard();

  let tenantId = null;
  let browser = null;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: "new",
      defaultViewport: { width: 1440, height: 900 },
      args: ["--no-sandbox", "--no-proxy-server", "--proxy-bypass-list=*", "--disable-gpu"],
    });
    tenantId = await createOwnTenant(browser);

    await auditByNullServer();
    await auditTzTripwire();
  } catch (e) {
    fail("run threw", e.message);
  } finally {
    await cleanupTenant(tenantId);
    if (browser) await browser.close().catch(() => {});
    await db.$disconnect();
  }

  console.log(`\n== ${failures.length ? "FAIL" : "pass"} == ${okCount} ok, ${failures.length} failed`);
  if (failures.length) {
    console.log("failed checks:");
    for (const f of failures) console.log(`  ❌ ${f}`);
  }
}

main().catch(async (err) => {
  console.error("❌ qa-harness-auditor threw:", err);
  await db.$disconnect().catch(() => {});
  process.exit(1);
});
