/**
 * Structural guard: the smoke harness must be able to fail, must not corrupt the
 * data it reads, and must not pass by accident.
 *
 * WHY THIS FILE EXISTS. The 26 scripts under `scripts/smoke*.mjs` are the only
 * automated coverage of auth, finance, projects and chat as a user experiences
 * them — CLAUDE.md requires a targeted smoke for exactly those features before a
 * push. An audit of the harness itself found five separate ways for one of them to
 * report success while proving nothing, and it found them in the scripts covering
 * sign-in and web push:
 *
 *   harness-001  smoke, smoke-auth and smoke-confirm contained zero failure
 *                markers, zero `process.exitCode` assignments and no non-zero
 *                exit. Sign-in could have been completely broken, with no session
 *                cookie set at all, and the suite summary would have read OK.
 *   harness-002  smoke-push printed "SKIPPED" and `process.exit(0)` from a branch
 *                that fires on every headless run — upstream of `pass = clicked
 *                && subscribed` and of the line that prints the marker. Same
 *                shape in smoke-rate-limit, whose entire pass criteria sat inside
 *                `if (process.env.DEV_LOG)`, which the runner never sets.
 *   harness-003  two scripts flipped a seeded teammate's role and sessionVersion
 *                and restored a LITERAL instead of the value they read. Writing
 *                `sessionVersion = 0` over a version a password reset had bumped
 *                re-validates every revoked token for that account.
 *   harness-009  no script set `x-real-ip`, so they shared rate-limit buckets and
 *                one script's sign-ins could starve the next — a false-failure
 *                generator that reads as an auth regression.
 *   harness-012  four scripts proved a write landed by counting every row in a
 *                table, which another tenant's insert can satisfy.
 *
 * Every one was found by reading. Each rule below is that reading, made
 * mechanical, so the twenty-seventh script is covered on the day it lands.
 *
 * WHAT THIS CANNOT DO: run anything. It reads source. A script that satisfies
 * every rule here can still be wrong about the product — these rules are about
 * whether it is CAPABLE of telling you.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../lib/harness/source-scan";

const ROOT = process.cwd();
const SCRIPTS = join(ROOT, "scripts");

/**
 * Every smoke script. `smoke.mjs` matches too, which it must: it was one of the
 * three that could not fail.
 *
 * Read through `stripComments` (comments blanked, string literals intact),
 * because every rule below is about code and every one of these files now
 * DISCUSSES the hazard it used to contain. Strings have to survive: the SQL and
 * the shell commands are string literals.
 */
function smokeScripts(): { name: string; code: string }[] {
  return readdirSync(SCRIPTS)
    .filter((f) => /^smoke.*\.mjs$/.test(f))
    .sort()
    .map((name) => ({
      name,
      code: stripComments(readFileSync(join(SCRIPTS, name), "utf8")),
    }));
}

const RUNNER = join(SCRIPTS, "run-all-smoke.sh");

/**
 * Smoke scripts deliberately absent from scripts/run-all-smoke.sh.
 *
 * EMPTY. A script nobody runs is the same defect as a script that cannot fail —
 * both are coverage that exists only on paper — so the two scripts that were
 * missing from the list were added to it rather than excused here. The staleness
 * test below means an entry cannot outlive its reason.
 */
const NOT_IN_RUNNER = new Map<string, string>([]);

describe("every smoke script can report a failure (audit harness-001, harness-002)", () => {
  it("found the scripts at all", () => {
    // Guards the guard: every rule in this file iterates this list, so an empty
    // read is a green suite that inspected nothing.
    const scripts = smokeScripts();
    expect(scripts.length, "almost no smoke script was found under scripts/").toBeGreaterThan(20);
    expect(scripts.map((s) => s.name)).toContain("smoke-auth.mjs");
    expect(scripts.map((s) => s.name)).toContain("smoke.mjs");
  });

  it("prints a failure marker the runner counts", () => {
    // run-all-smoke.sh classifies a script by grepping its log for `❌` or a
    // line beginning "  FAIL ". A script that prints neither is reported OK
    // whatever it found.
    const mute = smokeScripts()
      .filter((s) => !/❌/.test(s.code) && !/FAIL/.test(s.code))
      .map((s) => s.name);
    expect(
      mute,
      "These print no failure marker, so scripts/run-all-smoke.sh reports them OK " +
        "regardless of what they observed:\n" +
        mute.join("\n")
    ).toEqual([]);
  });

  it("can exit non-zero", () => {
    // A marker alone is not enough — it makes the runner say ASSERT, but a human
    // running one script by hand reads `$?`. Accept any of the three shapes this
    // directory uses.
    const alwaysZero = smokeScripts()
      .filter((s) => {
        const setsExitCode = /process\.exitCode\s*=\s*[^0]/.test(s.code);
        const exitsNonZero = /process\.exit\(\s*(?:[1-9]|[a-zA-Z_$])/.test(s.code);
        return !setsExitCode && !exitsNonZero;
      })
      .map((s) => s.name);
    expect(
      alwaysZero,
      "These can only ever exit 0, so a failure is invisible to any caller that " +
        "reads an exit status:\n" +
        alwaysZero.join("\n")
    ).toEqual([]);
  });

  it("puts no early process.exit(0) upstream of its own failure reporting", () => {
    // THE harness-002 shape, and the one that is invisible in review: a skip
    // branch that fires on every run, sitting above the line that would have
    // reported the failure. A literal `process.exit(0)` is never right in these
    // scripts — the last line is always `process.exit(process.exitCode ? 1 : 0)`
    // or `process.exit(pass ? 0 : 1)`, both of which carry the verdict.
    const offenders: string[] = [];
    smokeScripts().forEach(({ name, code }) => {
      const at = code.indexOf("process.exit(0)");
      if (at === -1) return;
      // Is there failure-reporting code AFTER it? If so it is unreachable on
      // that path.
      const rest = code.slice(at + 1);
      if (/❌|FAIL|process\.exitCode/.test(rest)) {
        offenders.push(`${name} exits 0 with failure reporting still downstream`);
      } else {
        offenders.push(`${name} ends in a literal process.exit(0), which asserts nothing`);
      }
    });
    expect(
      offenders,
      "A literal process.exit(0) makes every assertion below it unreachable. Exit " +
        "on the verdict instead, or exit 78 for 'this environment cannot run the " +
        "check' — which the runner reports as NOTRUN rather than OK:\n" +
        offenders.join("\n")
    ).toEqual([]);
  });
});

describe("every smoke script gets its own rate-limit bucket (audit harness-009)", () => {
  it("declares a SMOKE_IP", () => {
    const missing = smokeScripts()
      .filter(({ code }) => !/const\s+SMOKE_IP\s*=\s*["'][\d.]+["']/.test(code))
      .map((s) => s.name);
    expect(
      missing,
      "These set no x-real-ip, so lib/client-ip.ts finds no trusted address and " +
        "lib/rate-limit.ts falls back to per-account limits shared with every other " +
        "script signing in as the same seeded user:\n" +
        missing.join("\n")
    ).toEqual([]);
  });

  it("gives every page it opens that header", () => {
    // A script with three browser contexts and one header is two thirds
    // unprotected, and the shortfall is invisible in a diff.
    const short: string[] = [];
    smokeScripts().forEach(({ name, code }) => {
      const pages = (code.match(/\.newPage\(\)/g) ?? []).length;
      const headers = (code.match(/setExtraHTTPHeaders\(\{\s*"x-real-ip":\s*SMOKE_IP/g) ?? [])
        .length;
      if (pages !== headers) short.push(`${name}: ${pages} page(s), ${headers} header(s)`);
    });
    expect(
      short,
      "Every page a script opens needs the header, or that page's requests fall " +
        "back to the shared bucket:\n" +
        short.join("\n")
    ).toEqual([]);
  });

  it("declares SMOKE_IP before the first use of it", () => {
    // `const` is in a temporal dead zone, so a declaration that lands below the
    // first `setExtraHTTPHeaders` is a ReferenceError at run time — and these
    // scripts are not run by the suite, so nothing else would catch it.
    const badOrder: string[] = [];
    smokeScripts().forEach(({ name, code }) => {
      const decl = code.search(/const\s+SMOKE_IP\s*=/);
      const use = code.indexOf('"x-real-ip": SMOKE_IP');
      if (decl >= 0 && use >= 0 && decl > use) {
        badOrder.push(`${name}: declared at offset ${decl}, used at ${use}`);
      }
    });
    expect(
      badOrder,
      "SMOKE_IP is used before it is declared, which throws a ReferenceError on " +
        "the first navigation:\n" +
        badOrder.join("\n")
    ).toEqual([]);
  });

  it("gives each script a DIFFERENT address", () => {
    // The whole point. Two scripts on one address is the shared bucket again,
    // with the extra cost that it looks fixed.
    const byIp = new Map<string, string[]>();
    smokeScripts().forEach(({ name, code }) => {
      const m = /const\s+SMOKE_IP\s*=\s*["']([\d.]+)["']/.exec(code);
      if (!m) return;
      const list = byIp.get(m[1]!) ?? [];
      list.push(name);
      byIp.set(m[1]!, list);
    });
    const shared: string[] = [];
    byIp.forEach((names, ip) => {
      if (names.length > 1) shared.push(`${ip} — ${names.join(", ")}`);
    });
    expect(shared, `Two scripts share one bucket:\n${shared.join("\n")}`).toEqual([]);

    // And not on the 10.99.0.x range scripts/qa-*.mjs uses, or a QA agent and a
    // smoke script collide instead.
    const onQaRange: string[] = [];
    byIp.forEach((names, ip) => {
      if (ip.startsWith("10.99.0.")) onQaRange.push(`${ip} — ${names.join(", ")}`);
    });
    expect(onQaRange, `10.99.0.x belongs to scripts/qa-*.mjs:\n${onQaRange.join("\n")}`).toEqual(
      []
    );
  });
});

describe("no smoke script proves a write by counting the whole table (audit harness-012)", () => {
  it("scopes every count", () => {
    // `db.task.count()` with no argument counts every tenant in the database.
    // `afterTasks === beforeTasks + 1` is then satisfiable by somebody else's
    // insert while the write under test silently failed — and a false pass ends
    // the investigation.
    const offenders: string[] = [];
    smokeScripts().forEach(({ name, code }) => {
      code.split("\n").forEach((line, i) => {
        if (/\bdb\.\w+\.count\(\s*\)/.test(line)) {
          offenders.push(`${name}:${i + 1} — ${line.trim()}`);
        }
      });
    });
    expect(
      offenders,
      "Add a `where` naming the tenant this script owns:\n" + offenders.join("\n")
    ).toEqual([]);
  });

  it("does not identify its own row by ordering the table", () => {
    // `findFirst({ orderBy: { createdAt: "desc" } })` returns whoever wrote
    // last, so the log prints another tenant's row as corroboration for the
    // false pass above. Look the row up by something this run generated.
    const offenders: string[] = [];
    smokeScripts().forEach(({ name, code }) => {
      code.split("\n").forEach((line, i) => {
        if (/\.(?:findFirst|findMany)\(\{\s*orderBy\b/.test(line)) {
          offenders.push(`${name}:${i + 1} — ${line.trim()}`);
        }
      });
    });
    expect(
      offenders,
      "Look the row up by the unique title/body/email this run generated:\n" + offenders.join("\n")
    ).toEqual([]);
  });
});

/**
 * Columns where writing a guessed value is a silent security or permissions
 * change rather than a tidy-up:
 *
 *   sessionVersion  per lib/auth/session-version.ts, a token is valid when its
 *                   version matches the row's, and a legacy token carrying no
 *                   version defaults to 0. Writing 0 RE-VALIDATES every old
 *                   token for that account, undoing a password reset's
 *                   revocation.
 *   deletedAt       writing NULL un-deletes an account somebody deactivated.
 *   role            writing 'member' demotes a cofounder.
 *   plan / status   writing a literal changes what a workspace is entitled to.
 */
const GUARDED_COLUMNS = ["sessionVersion", "deletedAt", "role", "plan", "status"];

/**
 * Writes to a guarded column, in one line of script source, that use a bare
 * literal rather than something derived from what the script read.
 *
 * ALLOWED, and each for a stated reason:
 *   - `${…}`  — the value this run captured, which is the whole fix.
 *   - `now()` and any other function call — the mutation UNDER TEST, not a
 *     restore. smoke-session-invalidation.mjs soft-deletes with `now()`.
 *   - `"sessionVersion" + 1` and other column expressions — likewise.
 *
 * The value capture stops at ` WHERE `, and that boundary is the whole of this
 * function's difficulty. A greedy capture swallows the WHERE clause, so
 * `SET role = 'member' WHERE email = '${TARGET}'` reads as interpolated and the
 * offender is waved through — a false negative in the exact statement this rule
 * exists for. `the detector refuses the shapes it is for` below is that case,
 * and it is why this is a named function rather than a regex inline in a loop.
 */
function literalWritesTo(line: string): { column: string; value: string }[] {
  const pattern = new RegExp(
    'SET\\s+"?(' + GUARDED_COLUMNS.join("|") + ')"?\\s*=\\s*(.+?)(?:\\s+WHERE\\b|\\s*;|$)',
    "gi"
  );
  const out: { column: string; value: string }[] = [];
  // `exec` in a loop rather than `matchAll` in a `for…of`: tsconfig sets no
  // `target`, so tsc treats this file as ES5 and the iterator form is TS2802
  // while vitest transpiles it happily.
  let m = pattern.exec(line);
  while (m !== null) {
    const value = m[2]!.trim();
    const interpolated = value.indexOf("${") >= 0;
    const isFunctionCall = /^[a-z_]+\s*\(/i.test(value);
    const isColumnExpression = /^"\w+"/.test(value);
    if (!interpolated && !isFunctionCall && !isColumnExpression) {
      out.push({ column: m[1]!, value });
    }
    m = pattern.exec(line);
  }
  return out;
}

describe("no smoke script restores a literal over a value it read (audit harness-003)", () => {
  it("writes only a captured value, a column expression or a function to those columns", () => {
    const offenders: string[] = [];
    smokeScripts().forEach(({ name, code }) => {
      code.split("\n").forEach((line, i) => {
        literalWritesTo(line).forEach(({ column, value }) => {
          offenders.push(`${name}:${i + 1} — SET ${column} = ${value}`);
        });
      });
    });
    expect(
      offenders,
      "Capture the prior value and restore THAT. A literal here is a silent " +
        "permissions or session change against whatever workspace the script ran " +
        "over:\n" +
        offenders.join("\n")
    ).toEqual([]);
  });

  it("the detector refuses the shapes it is for", () => {
    // Guard-the-guard. The assertion above is "the offender list is empty",
    // which a regex that matches nothing satisfies perfectly. Both statements
    // here are verbatim from the two scripts as they shipped.
    const sessionVersion = `psql(\`UPDATE "User" SET "sessionVersion" = 0 WHERE email = 'sarah@nimbus.app';\`);`;
    expect(literalWritesTo(sessionVersion)).toEqual([{ column: "sessionVersion", value: "0" }]);

    const tombstone = `psql(\`UPDATE "User" SET "deletedAt" = NULL WHERE email = 'fatima@nimbus.app';\`);`;
    expect(literalWritesTo(tombstone)).toEqual([{ column: "deletedAt", value: "NULL" }]);

    // THE false negative a greedy capture produces: a literal value with an
    // interpolation later in the same statement.
    const role = `psqlScalar(\`UPDATE "User" SET role = 'member' WHERE email = '\${TARGET}';\`);`;
    expect(literalWritesTo(role)).toEqual([{ column: "role", value: "'member'" }]);
  });

  it("the detector allows the shapes that are correct", () => {
    // The other direction, so the rule cannot be satisfied by refusing
    // everything — which would push the next person to delete it.
    const captured = `\`UPDATE "User" SET role = '\${startRole}' WHERE email = '\${TARGET}';\``;
    expect(literalWritesTo(captured)).toEqual([]);

    const underTest = `psql(\`UPDATE "User" SET "deletedAt" = now() WHERE email = 'fatima@nimbus.app';\`);`;
    expect(literalWritesTo(underTest)).toEqual([]);

    const bump = `psql(\`UPDATE "User" SET "sessionVersion" = "sessionVersion" + 1 WHERE email = 'x';\`);`;
    expect(literalWritesTo(bump)).toEqual([]);
  });
});

describe("the suite runner reports what it found (audit harness-008)", () => {
  const runner = readFileSync(RUNNER, "utf8");

  it("accumulates failures and exits on them", () => {
    // It had no `exit` statement anywhere in it and no accumulator, so every run
    // ended 0 whatever it classified. Wiring that into CI adds a step that is
    // green by construction.
    expect(runner, "run-all-smoke.sh keeps no failure counter").toMatch(/failures=/);
    expect(runner, "run-all-smoke.sh never increments its failure counter").toMatch(
      /failures=\$\(\(failures \+ 1\)\)/
    );
    // The final statement is the exit status. `[ "$failures" -eq 0 ]` is a
    // command whose own status becomes the script's, which is why there is no
    // literal `exit` here.
    expect(runner.trimEnd().split("\n").pop()).toMatch(/\[ "\$failures" -eq 0 \]/);
  });

  it("does not let a missing script pass as a skip", () => {
    // A named script that is not on disk used to print SKIP and `continue`,
    // leaving the run green — so deleting or renaming a smoke silently removed
    // its coverage.
    expect(runner).toMatch(/MISSING/);
    expect(runner).toMatch(/missing=\$\(\(missing \+ 1\)\)/);
  });

  it("names every smoke script on disk", () => {
    const listed = runner;
    const unlisted = smokeScripts()
      .map((s) => s.name.replace(/\.mjs$/, ""))
      .filter((base) => !NOT_IN_RUNNER.has(`${base}.mjs`))
      // Word-boundary match so `smoke` does not match inside `smoke-auth`.
      .filter((base) => !new RegExp(`(^|\\s)${base}(\\s|$)`, "m").test(listed));
    expect(
      unlisted,
      "These scripts exist and the runner never runs them, so they only execute " +
        "when somebody remembers them by name:\n" +
        unlisted.join("\n")
    ).toEqual([]);
  });

  it("every not-in-runner entry is still absent, so the list cannot go stale", () => {
    const stale: string[] = [];
    Array.from(NOT_IN_RUNNER.entries()).forEach(([file, reason]) => {
      const base = file.replace(/\.mjs$/, "");
      if (new RegExp(`(^|\\s)${base}(\\s|$)`, "m").test(runner)) {
        stale.push(`${file} is in the runner now (listed as: ${reason})`);
      }
    });
    expect(stale, `Delete these from NOT_IN_RUNNER:\n${stale.join("\n")}`).toEqual([]);
  });

  it("CI still runs no smoke script, and that is recorded rather than assumed", () => {
    // The other half of harness-008, and it is NOT fixed: .github/workflows/ci.yml
    // runs prisma validate, typecheck, vitest, lint, prettier and build, and not
    // one smoke script. Wiring one in needs a throwaway Postgres and a dev
    // server in the job, which is a decision about CI minutes rather than a
    // repo edit — so it is left to a human and pinned here instead of being
    // quietly forgotten. When a smoke step lands, this test fails and asks to be
    // replaced with an assertion about it.
    const ci = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
    expect(
      /run-all-smoke|smoke-/.test(ci),
      "CI now references a smoke script. Replace this test with one that asserts " +
        "the step exists and that its failure fails the job."
    ).toBe(false);
  });
});
