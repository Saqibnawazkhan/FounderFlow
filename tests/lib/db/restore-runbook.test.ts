/**
 * data-integrity-005 — the published recovery procedure is a CROSS-TENANT WRITE.
 *
 * `softDeleteWorkspace` stamps ONE `now` across all seven `updateMany` calls
 * inside a single `$transaction` (lib/actions/account.ts), so every row of a
 * deleted workspace shares a tombstone timestamp to the millisecond. The runbook
 * — in CLAUDE.md and twice in `lib/actions/account.ts` — then told whoever is
 * restoring it to reunite the child tables by that timestamp ALONE
 * (runbook-quote-ok: the statement below is the defect, quoted so this file
 * states what it guards against — see QUOTE_MARKER):
 *
 *     UPDATE "Transaction" SET "deletedAt" = NULL
 *       WHERE "deletedAt" BETWEEN '<t - 1s>' AND '<t + 1s>';
 *
 * Only the `Company` and `User` lines were ever id- or companyId-scoped. So two
 * workspaces deleted in the same second are indistinguishable to that filter,
 * and the ±1s window widens it further: restoring one customer's fat-fingered
 * delete silently un-deletes ANOTHER customer's transactions, tasks and budgets
 * — into a workspace whose `Company` row stays tombstoned, so neither that
 * customer nor support can see or re-delete them. It is a cross-tenant write
 * performed by the very procedure that exists to be the safety net, at the moment
 * whoever is running it is under the most pressure.
 *
 * THE FIX IS NOT "DROP THE TIMESTAMP". The second copy of the runbook explains
 * why the timestamp is there and it is right: a message or comment its author
 * deleted last week carries its OWN earlier tombstone, and
 * `softDeleteWorkspace`'s `deletedAt: null` filter deliberately leaves it alone.
 * Restoring by `companyId` alone would resurrect it. The correct filter is BOTH —
 * `"companyId" = '<id>' AND "deletedAt" = '<exact t>'` — and the exact stamp
 * rather than a range, because there is exactly one instant to match.
 *
 * WHY A TEST OVER SOURCE TEXT. The runbook is documentation; there is no function
 * to drive. But it is documentation that performs a destructive write when
 * followed, so it is worth the same structural guard the purge sweep gets in
 * `purge-invariants.test.ts`: the rule is derived and checked rather than
 * remembered, and a fourth copy of the runbook added tomorrow is covered on the
 * day it lands.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();

/**
 * Files whose runbook is still wrong, with the reason and the outstanding edit.
 *
 * EMPTY, AND IT GOT THERE THE WAY IT WAS SUPPOSED TO. The agent that closed
 * data-integrity-005 fixed both copies in lib/actions/account.ts and recorded
 * `CLAUDE.md` here rather than editing the project's operating-notes file, which
 * was not its to change. The entry was VERIFIED rather than tolerated: when
 * CLAUDE.md's Tier 3 block was corrected, this map's own check went red with
 * "its exception entry is stale. Delete it from this test." — which is what is
 * being done here. An excuse cannot outlive its reason; the same design as the
 * `NOT_YET_CONVERTED` map in tests/lib/layout/rtl.test.ts.
 *
 * Keep it empty. A new entry is a deliberate statement that a runbook copy is
 * knowingly wrong and that somebody specific owns the edit — not a way to make
 * this file pass.
 */
const PENDING_CORRECTION: Record<string, string> = {};

/** Directories to sweep for runbook copies, plus the repo-root docs. */
const SWEEP_DIRS = ["lib", "app", "scripts", "tests"];
const ROOT_FILES = ["CLAUDE.md"];

interface Statement {
  file: string;
  table: string;
  /** The whole statement, comment leaders stripped, whitespace collapsed. */
  sql: string;
}

/**
 * Marker that says "this statement is QUOTED, not published".
 *
 * The audit scripts under `scripts/qa-*.mjs` reproduce the broken SQL verbatim as
 * the thing they detect, and that quotation is permanent documentation of a real
 * historical defect — correcting it would destroy the evidence. So a quotation
 * opts out by naming itself, in the same spirit as the `locale-free-date-ok:`
 * marker this codebase already uses in `app/(app)/settings/settings-client.tsx`.
 *
 * It is deliberately narrow: it exempts ONE statement, by sitting within 300
 * characters before it, not the whole file. A file that quotes the defect can
 * still not smuggle a real runbook past this test.
 */
const QUOTE_MARKER = "runbook-quote-ok";

/**
 * Turn a file into plain SQL-ish text: drop JSDoc `*` leaders (the runbook lives
 * inside block comments), drop `//` leaders, drop SQL `--` line comments, and
 * collapse whitespace so a statement split over three lines reads as one.
 */
function asSqlText(source: string): string {
  return source
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\*\s?/, "").replace(/^\s*\/\/\s?/, ""))
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n")
    .replace(/\s+/g, " ");
}

function filesToScan(): Array<{ path: string; src: string }> {
  const out: Array<{ path: string; src: string }> = [];
  const push = (full: string) => {
    out.push({
      path: relative(ROOT, full).split(sep).join("/"),
      src: readFileSync(full, "utf8"),
    });
  };
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry.charAt(0) === ".") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx|mjs|md)$/.test(entry)) continue;
      push(full);
    }
  };
  for (const dir of SWEEP_DIRS) walk(join(ROOT, dir));
  for (const file of ROOT_FILES) push(join(ROOT, file));
  return out;
}

/** Every `UPDATE "X" SET "deletedAt" = NULL … ;` anywhere in the repo. */
function restoreStatements(): Statement[] {
  const found: Statement[] = [];
  for (const { path, src } of filesToScan()) {
    const text = asSqlText(src);
    // exec loop, not matchAll: tsconfig has no `target`, so tsc defaults to ES5
    // and `matchAll` in a for…of fails typecheck while passing vitest.
    const re = /UPDATE\s+"(\w+)"\s+SET\s+"deletedAt"\s*=\s*NULL([^;]*);/g;
    let m = re.exec(text);
    while (m !== null) {
      const preamble = text.slice(Math.max(0, m.index - 300), m.index);
      if (preamble.indexOf(QUOTE_MARKER) === -1) {
        found.push({ file: path, table: m[1], sql: m[0] });
      }
      m = re.exec(text);
    }
  }
  return found;
}

/** Does this statement pick its rows by the tombstone timestamp? */
function selectsByTombstone(sql: string): boolean {
  return /WHERE[\s\S]*"deletedAt"/i.test(sql);
}

describe("data-integrity-005 — the restore runbook cannot reach another tenant", () => {
  it("finds the runbook statements at all — guard the guard", () => {
    // Without this, a change to how the runbook is written turns every loop
    // below into a pass over nothing, and the file reads as coverage of a rule
    // it is no longer checking.
    const all = restoreStatements();
    expect(all.length).toBeGreaterThanOrEqual(4);
    const files = all.map((s) => s.file);
    expect(files).toContain("lib/actions/account.ts");
    expect(files).toContain("CLAUDE.md");
  });

  it("scopes every timestamp-selected restore to one workspace", () => {
    for (const s of restoreStatements()) {
      if (!selectsByTombstone(s.sql)) continue; // id- or email-scoped: already narrow
      if (PENDING_CORRECTION[s.file]) continue;
      expect(
        /"companyId"\s*=/.test(s.sql),
        `${s.file} restores "${s.table}" by tombstone timestamp with no companyId clause.\n` +
          `  ${s.sql.trim()}\n` +
          `softDeleteWorkspace stamps ONE instant across every table, so two workspaces ` +
          `deleted in the same second are indistinguishable to this filter — running it ` +
          `un-deletes another customer's rows into a workspace whose Company row stays ` +
          `tombstoned, where nobody can see or re-delete them. Add ` +
          `AND "companyId" = '<companyId>'.`
      ).toBe(true);
    }
  });

  it("uses the exact tombstone instant, never a range", () => {
    // `BETWEEN '<t - 1s>' AND '<t + 1s>'` widens the blast radius for no benefit:
    // the seven updateMany calls share one `now` inside one $transaction, so
    // there is exactly one instant to match.
    for (const s of restoreStatements()) {
      if (PENDING_CORRECTION[s.file]) continue;
      expect(
        /BETWEEN/i.test(s.sql),
        `${s.file} restores "${s.table}" with a BETWEEN window. There is exactly one ` +
          `tombstone instant per workspace delete — match it exactly.`
      ).toBe(false);
    }
  });

  it("every pending-correction entry still describes a real, unfixed copy", () => {
    // The staleness half. When CLAUDE.md is corrected this fails, and whoever
    // corrected it deletes the entry — so the excuse cannot outlive its reason.
    for (const file of Object.keys(PENDING_CORRECTION)) {
      const statements = restoreStatements().filter((s) => s.file === file);
      expect(statements.length, `${file} has no restore statements left to excuse`).toBeGreaterThan(
        0
      );
      const stillWrong = statements.some(
        (s) =>
          (selectsByTombstone(s.sql) && !/"companyId"\s*=/.test(s.sql)) || /BETWEEN/i.test(s.sql)
      );
      expect(
        stillWrong,
        `${file} no longer has an unscoped restore statement, so its PENDING_CORRECTION ` +
          `entry is stale. Delete it from this test.\n  Reason recorded: ${PENDING_CORRECTION[file]}`
      ).toBe(true);
    }
  });
});
