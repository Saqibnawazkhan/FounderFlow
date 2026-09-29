// @vitest-environment node

/**
 * acct-009, the other half: the personal export has to be REACHABLE.
 *
 * WHY THIS FILE EXISTS. "Shipped, tested, unreachable" is this codebase's
 * signature defect — an action with no caller, a component behind a prop nobody
 * passes, a card with a route and a test and no entry point — and the last two
 * waves each produced a fresh instance of it. A route that answers
 * `?scope=me` for a member, behind a button still wrapped in `{canExport && …}`,
 * would be exactly that: green tests, and a member who still sees one data
 * operation on /settings, called "Delete my account".
 *
 * WHY A SOURCE ASSERTION AND NOT A RENDER. Rendering SettingsClient means
 * standing up the zustand store, the router, the confirm provider, five server
 * actions and six modals to observe one conditional. The property here is
 * structural — WHICH JSX subtree the button sits in — and that is legible in the
 * source. tests/lib/cron/purge-invariants (parses schema.prisma) and
 * tests/security/script-safety (sweeps scripts/) are the same pattern.
 *
 * WHY THE SCANNER IS ITSELF TESTED. A source test can pass because its detector
 * is blind — the failure mode this repo has produced seven times is a test that
 * encodes the bug. So `insideCanExportBlock` is run first against a synthetic
 * copy of the PRE-FIX shape, where the personal button IS inside the gate, and
 * that case must come back positive. Only then does the same function get
 * pointed at the real file. If the scanner ever stops seeing the difference, the
 * first assertion goes red before the real one can go falsely green.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SETTINGS_CLIENT = join(process.cwd(), "app", "(app)", "settings", "settings-client.tsx");
const GATE = "{canExport && (";

/**
 * The text of the `{canExport && ( … )}` JSX expression container, found by
 * balancing braces from its opening `{`. The block's contents are ordinary
 * balanced JSX (`{t.settings.exportWorkspace}`, a ternary), so a depth counter
 * is exact here; it is not a general JSX parser and is not trying to be.
 */
function financeGatedBlock(src: string): string {
  const start = src.indexOf(GATE);
  if (start < 0) return "";
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return src.slice(start);
}

/** Is this button's click handler behind the finance gate? */
function insideCanExportBlock(src: string, call: string): boolean {
  return financeGatedBlock(src).includes(call);
}

/** The shape the file had before acct-009: one card, entirely behind the gate. */
const PRE_FIX = `
      <Section icon={Database} label={t.settings.dataStorage}>
        {canExport && (
          <div className="mb-4">
            <p>{t.settings.exportWorkspace}</p>
            <button onClick={() => handleExport("workspace")}>
              {exporting === "workspace" ? t.settings.exportPreparing : "Export"}
            </button>
            <button onClick={() => handleExport("me")}>Download my data</button>
          </div>
        )}
      </Section>
`;

describe("the scanner can actually see the defect", () => {
  it("reports the personal button as gated in the pre-fix shape", () => {
    expect(insideCanExportBlock(PRE_FIX, 'handleExport("me")')).toBe(true);
    expect(insideCanExportBlock(PRE_FIX, 'handleExport("workspace")')).toBe(true);
  });

  it("finds a non-empty block to look in", () => {
    // Guards the other direction: an `indexOf` that missed would make every
    // "not inside the gate" assertion below pass vacuously.
    expect(financeGatedBlock(readFileSync(SETTINGS_CLIENT, "utf8")).length).toBeGreaterThan(200);
  });
});

describe("/settings offers a member more than 'Delete my account' (acct-009)", () => {
  const src = readFileSync(SETTINGS_CLIENT, "utf8");

  it("shows the personal export to every role", () => {
    expect(src).toContain('handleExport("me")');
    expect(
      insideCanExportBlock(src, 'handleExport("me")'),
      "The personal export is inside {canExport && …}, so a member still cannot " +
        "reach it and the route work is unreachable — the defect acct-009 is about."
    ).toBe(false);
  });

  it("keeps the WORKSPACE export behind the finance gate", () => {
    expect(
      insideCanExportBlock(src, 'handleExport("workspace")'),
      "Widening who may export must not widen what a member sees: the " +
        "full-workspace file stays admin/cofounder-only."
    ).toBe(true);
  });

  it("asks the route for a scope rather than filtering the answer", () => {
    // The client must never be the thing that decides what a member's file
    // contains — that decision belongs to app/api/export/route.ts, which
    // simply does not query the money tables for scope=me.
    expect(src).toContain("/api/export?scope=");
    expect(src).not.toMatch(/transactions\s*[:=]/);
  });

  it("does not disable one export button while the other is running", () => {
    // Two buttons, one in-flight flag. `disabled={exporting}` with a boolean
    // would grey out both and label both "Preparing…".
    expect(src).toContain('useState<null | "workspace" | "me">(null)');
    expect(src).toContain("disabled={exporting !== null}");
  });
});
