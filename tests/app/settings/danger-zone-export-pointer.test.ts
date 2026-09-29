// @vitest-environment node

/**
 * acct-018 — the copy is offered where the decision is made, and it is HONEST
 * about which file contains what.
 *
 * WHAT WAS LEFT. acct-009 built the expensive half: `GET /api/export?scope=me`
 * plus an ungated "Export my data" card in Data & storage, reachable by every
 * role. What it did not build is a pointer. The Danger zone section and both
 * delete confirmations contained no mention of export, download or taking a
 * copy, so the offer only reached a customer who happened to scroll past it on
 * the way down to the button that ends their access. A person deciding to leave
 * reads the danger zone, not the section above it.
 *
 * THE TRAP, AND WHY MOST OF THIS FILE IS ABOUT IT. "Download your data first"
 * is a LIE in exactly the branch that destroys the most. `personalExport`
 * deliberately never queries Transaction, Budget or RecurringRule — money
 * belongs to the workspace, not to a person — while BOTH whole-workspace
 * branches (`deleteAccountAction`'s sole-user branch and `deleteWorkspaceAction`)
 * tombstone all three. So a single undifferentiated "export first" line would
 * hand a solo founder a file with none of their ledger in it and tell them it
 * was their data. The omission is therefore read out of
 * app/api/export/route.ts here, the same way tests/lib/i18n/delete-copy.test.ts
 * reads the 90-day window out of the purge cron rather than typing it: the copy
 * is held against the code that decides it.
 *
 * WHY SOURCE ASSERTIONS. Rendering SettingsClient means standing up the zustand
 * store, the router, the confirm provider, five server actions and six modals to
 * observe which JSX subtree a sentence sits in; the property under test is
 * structural and is legible in the source. tests/app/export/export-button-
 * reachable.test.ts, tests/lib/cron/purge-invariants and tests/security/
 * script-safety are the same pattern.
 *
 * WHAT A SOURCE ASSERTION CANNOT DO, added after a verifier caught it. Every
 * `exportHint` assertion in this file reads the COMPUTATION. Deleting the one
 * line in delete-account-modal.tsx that puts the value on the screen left all 18
 * tests here green — computed, tested, rendered nowhere, which is this repo's
 * signature defect reproduced inside the fix for another finding. The renders are
 * therefore pinned by mounting the two dialogs, in
 * tests/app/settings/delete-modals-export-hint.test.tsx. This file owns the
 * WORDING and the structure; that one owns what a customer sees.
 *
 * WHY THE SCANNERS ARE THEMSELVES TESTED. This repo's signature defect is a test
 * that encodes the bug, so every detector below is first pointed at a synthetic
 * copy of the WRONG shape and must come back positive there.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DICTIONARIES,
  en,
  splitAroundPlaceholder,
  ur,
  type Locale,
  type Strings,
} from "@/lib/i18n/strings";

const SETTINGS_CLIENT = join(process.cwd(), "app", "(app)", "settings", "settings-client.tsx");
const ACCOUNT_MODAL = join(process.cwd(), "app", "(app)", "settings", "delete-account-modal.tsx");
const WORKSPACE_MODAL = join(
  process.cwd(),
  "app",
  "(app)",
  "settings",
  "delete-workspace-modal.tsx"
);
const EXPORT_ROUTE = join(process.cwd(), "app", "api", "export", "route.ts");

const settingsSrc = readFileSync(SETTINGS_CLIENT, "utf8");
const accountModalSrc = readFileSync(ACCOUNT_MODAL, "utf8");
const workspaceModalSrc = readFileSync(WORKSPACE_MODAL, "utf8");

/**
 * One `<Section …>…</Section>` of the settings page, found by its icon prop.
 * Sections are siblings, never nested, so the first closing tag after the
 * opening one is this section's.
 */
function sectionByIcon(src: string, icon: string): string {
  const open = src.indexOf(`<Section icon={${icon}}`);
  if (open < 0) return "";
  const close = src.indexOf("</Section>", open);
  return close < 0 ? src.slice(open) : src.slice(open, close);
}

/**
 * A top-level `function <name>(…) { … }`, verbatim. Top-level declarations in
 * these files close on a `}` in column 1, which is what the search keys on.
 */
function functionBody(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return "";
  const end = src.indexOf("\n}", start);
  return end < 0 ? src.slice(start) : src.slice(start, end + 2);
}

/** A single `const <name> = … ;` statement, verbatim. */
function constStatement(src: string, name: string): string {
  const start = src.indexOf(`const ${name} =`);
  if (start < 0) return "";
  const end = src.indexOf(";", start);
  return end < 0 ? src.slice(start) : src.slice(start, end + 1);
}

/**
 * Does this hint expression branch on which destruction is about to happen?
 * An undifferentiated hint is the bug: it promises the ledger to the one
 * customer whose file will not contain it.
 */
function branchesOnScope(statement: string): boolean {
  return statement.includes("deletesWorkspace");
}

/** The token DangerZoneExportHint substitutes the link for. */
const DATA_SECTION_TOKEN = "{dataSection}";

/**
 * How many times a template carries a token. Exactly one is the contract: none
 * leaves the anchor with nowhere to go, and two would render the second
 * occurrence to the customer as literal `{dataSection}`.
 */
function tokenCount(template: string, token: string): number {
  let count = 0;
  let at = template.indexOf(token);
  while (at >= 0) {
    count += 1;
    at = template.indexOf(token, at + token.length);
  }
  return count;
}

/** Every locale this build ships, not the two that happened to exist when written. */
function eachLocale(assert: (dict: Strings, code: Locale) => void): void {
  const codes = Object.keys(DICTIONARIES) as Locale[];
  expect(codes.length, "DICTIONARIES is empty; this sweep would pass vacuously").toBeGreaterThan(0);
  codes.forEach((code) => assert(DICTIONARIES[code], code));
}

/**
 * The expression that supplies the label on one of the two download BUTTONS in
 * Data & storage — the `…` in
 * `{exporting === "<scope>" ? t.settings.exportPreparing : …}`.
 *
 * Returns "" if the shape has moved, which the caller asserts against rather
 * than skipping: a silently empty extraction is how a sweep goes green over
 * nothing.
 */
function exportButtonLabelExpression(src: string, scope: "workspace" | "me"): string {
  const m = new RegExp(
    'exporting === "' + scope + '"\\s*\\?\\s*t\\.settings\\.exportPreparing\\s*:\\s*([^}]+)\\}'
  ).exec(src);
  return m ? m[1].trim() : "";
}

/** …resolved to the words a reader of `dict` actually sees printed on it. */
function resolveLabel(expression: string, dict: Strings): string {
  const literal = /^"([^"]*)"$/.exec(expression);
  if (literal) return literal[1];
  const key = /^t\.settings\.([A-Za-z0-9_]+)$/.exec(expression);
  if (!key) return "";
  const table = dict.settings as unknown as Record<string, string>;
  return typeof table[key[1]] === "string" ? table[key[1]] : "";
}

/** The body of `personalExport` — the query set that defines `scope=me`. */
function personalExportBody(): string {
  const src = readFileSync(EXPORT_ROUTE, "utf8");
  const start = src.indexOf("async function personalExport");
  const end = src.indexOf("async function workspaceExport");
  expect(
    start >= 0 && end > start,
    "app/api/export/route.ts no longer has personalExport followed by workspaceExport. " +
      "The copy below is derived from what personalExport omits; find where it moved."
  ).toBe(true);
  return src.slice(start, end);
}

/** The Arabic block, which is what Urdu is written in. */
const URDU_SCRIPT = /[؀-ۿ]/;

/* ───────────────────────────── detector self-tests ───────────────────────── */

describe("the scanners can see the shapes they are looking for", () => {
  it("extracts a section by its icon and stops at its own closing tag", () => {
    const fake =
      '<Section icon={Database} label="a">FIRST</Section>\n<Section icon={Skull} label="b">SECOND</Section>';
    expect(sectionByIcon(fake, "Database")).toContain("FIRST");
    expect(sectionByIcon(fake, "Database")).not.toContain("SECOND");
    expect(sectionByIcon(fake, "Skull")).toContain("SECOND");
  });

  it("flags an undifferentiated hint as not branching", () => {
    // The wrong fix: one line for both destructions.
    expect(branchesOnScope("const exportHint = t.settings.exportBeforeAccountDeleteHint;")).toBe(
      false
    );
    expect(
      branchesOnScope(
        "const exportHint = deletesWorkspace ? t.settings.exportBeforeWorkspaceDeleteHint : t.settings.exportBeforeAccountDeleteHint;"
      )
    ).toBe(true);
  });

  it("extracts a top-level function and stops at its own closing brace", () => {
    const fake =
      "function A() {\n  if (x) {\n    return 1;\n  }\n}\nfunction B() {\n  return 2;\n}\n";
    expect(functionBody(fake, "A")).toContain("return 1");
    expect(functionBody(fake, "A")).not.toContain("return 2");
    expect(functionBody(fake, "B")).toContain("return 2");
  });

  it("flags the pre-fix danger zone, which mentioned no export at all", () => {
    // The shape this finding is about, kept here verbatim so the assertions below
    // are provably not vacuous: a danger zone whose only prose is dangerZoneNote.
    const PRE_FIX =
      '<Section icon={Skull} label={t.settings.dangerZone} tone="danger">\n' +
      '  <p className="mb-4 text-sm text-fg-muted">{t.settings.dangerZoneNote}</p>\n' +
      '  <div className="space-y-3">\n' +
      "    <p>{t.settings.deleteAccount}</p>\n" +
      "  </div>\n" +
      "</Section>";
    expect(sectionByIcon(PRE_FIX, "Skull")).not.toContain("<DangerZoneExportHint");
    expect(sectionByIcon(PRE_FIX, "Skull")).not.toMatch(/export|download|copy/i);
    expect(functionBody(PRE_FIX, "DangerZoneExportHint")).toBe("");
  });

  it("counts a token, and counts zero when the locale dropped it", () => {
    expect(tokenCount("download it from {dataSection} above", DATA_SECTION_TOKEN)).toBe(1);
    // The shape finding 3 is about: a translation that inlined the section name
    // and lost the slot, leaving the link to land on the end of the sentence.
    expect(tokenCount("download it from Data & storage above", DATA_SECTION_TOKEN)).toBe(0);
    expect(tokenCount("{dataSection} and {dataSection}", DATA_SECTION_TOKEN)).toBe(2);
  });

  it("reads a button's label expression, whether it is a key or a literal", () => {
    const fake =
      '<button>\n  {exporting === "workspace"\n    ? t.settings.exportPreparing\n' +
      "    : t.settings.exportWorkspaceAction}\n</button>\n" +
      '<button>{exporting === "me" ? t.settings.exportPreparing : "Download my data"}</button>';
    expect(exportButtonLabelExpression(fake, "workspace")).toBe("t.settings.exportWorkspaceAction");
    expect(exportButtonLabelExpression(fake, "me")).toBe('"Download my data"');
    expect(exportButtonLabelExpression(fake, "workspace")).not.toBe("t.settings.exportWorkspace");
    expect(exportButtonLabelExpression("<button>Export</button>", "me")).toBe("");
    expect(resolveLabel("t.settings.exportWorkspaceAction", en)).toBe(
      en.settings.exportWorkspaceAction
    );
    expect(resolveLabel("t.settings.exportWorkspaceAction", ur)).toBe(
      ur.settings.exportWorkspaceAction
    );
    expect(resolveLabel('"Download my data"', ur)).toBe("Download my data");
    expect(resolveLabel("t.settings.noSuchKey", en)).toBe("");
  });

  it("finds a non-empty danger zone and Data & storage section to look in", () => {
    // Guards the other direction: a missed indexOf would make every assertion
    // below pass vacuously.
    expect(sectionByIcon(settingsSrc, "Skull").length).toBeGreaterThan(200);
    expect(sectionByIcon(settingsSrc, "Database").length).toBeGreaterThan(200);
  });
});

/* ──────────────────── the pointer exists where the decision is ───────────── */

describe("the danger zone offers a copy before it destroys one (acct-018)", () => {
  const dangerZone = sectionByIcon(settingsSrc, "Skull");

  // One indirection, asserted in two halves: the section renders the hint, and
  // the hint is the copy plus the anchor. The property is unchanged — "the danger
  // zone shows a link to Data & storage" — and neither half is true on its own,
  // so neither can go green while the pointer is missing.
  const hint = functionBody(settingsSrc, "DangerZoneExportHint");

  it("renders an export hint inside the Danger zone section", () => {
    expect(
      dangerZone,
      "the Danger zone is where the customer decides; a download card two sections " +
        "up that is never mentioned here is only reachable by accident"
    ).toContain("<DangerZoneExportHint");
    expect(hint.length, "the component the section renders must exist").toBeGreaterThan(80);
    expect(hint).toContain("dangerZoneExportHint");
  });

  it("links to the Data & storage section rather than only naming it", () => {
    expect(hint).toContain('href="#data-storage"');
    expect(
      sectionByIcon(settingsSrc, "Database"),
      "the anchor needs a target, or the link scrolls nowhere"
    ).toContain('id="data-storage"');
  });

  it("names the section through a placeholder in every locale, not just two", () => {
    // Was two hard-coded assertions, en and ur. `DangerZoneExportHint` splits on
    // this token and puts the anchor in the gap, so a locale without it renders
    // the whole sentence followed by a bare "Data & storage" link hanging off the
    // end. Sweeping DICTIONARIES means a third locale inherits the guard instead
    // of inheriting the bug with nothing naming it.
    eachLocale((dict, code) => {
      expect(
        tokenCount(dict.settings.dangerZoneExportHint, DATA_SECTION_TOKEN),
        `${code}.settings.dangerZoneExportHint must carry exactly one ${DATA_SECTION_TOKEN} — ` +
          "it is the slot the link to Data & storage is rendered into"
      ).toBe(1);
    });
  });

  it("degrades to a sentence, not a dangling link, if a locale loses the token", () => {
    // The sweep above keeps every SHIPPED locale honest. This is the other half:
    // `split("{dataSection}")` on a token-less string returns one element, `after`
    // comes back undefined, and the component renders the whole sentence with a
    // bare "Data & storage" hyperlink stuck on the end. The decision is a pure
    // function so the degradation is testable rather than asserted.
    expect(
      splitAroundPlaceholder("download it from {dataSection} above", DATA_SECTION_TOKEN)
    ).toEqual({ before: "download it from ", after: " above" });
    expect(
      splitAroundPlaceholder("download it from Data & storage above", DATA_SECTION_TOKEN),
      "no slot means no anchor — the caller must be able to tell, not get `undefined`"
    ).toBeNull();
    expect(splitAroundPlaceholder(DATA_SECTION_TOKEN, DATA_SECTION_TOKEN)).toEqual({
      before: "",
      after: "",
    });

    expect(hint, "the component must use the guarded split, not a raw one").toContain(
      "splitAroundPlaceholder"
    );
    expect(hint, "a bare .split() is the shape that produces the dangling link").not.toContain(
      ".split("
    );
  });

  it("keeps the download OUT of the danger zone", () => {
    // acct-007 is this page's own record of what dressing a harmless action in
    // danger red cost. A download destroys nothing, so the card stays where a
    // person looks for it.
    expect(
      dangerZone,
      "the export card must not be moved into the danger zone — pointing at it is the fix"
    ).not.toContain("handleExport(");
    expect(sectionByIcon(settingsSrc, "Database")).toContain('handleExport("me")');
  });

  it("promises nothing about what the file contains", () => {
    // This line is on screen for every role, before the app knows whether this
    // account-delete is a personal one or a whole-workspace cascade. Naming the
    // ledger here would be the lie the modal hints exist to avoid.
    expect(en.settings.dangerZoneExportHint).not.toMatch(/transaction|budget|everything/i);
  });
});

/* ───────────────── the pointer tells the truth in both branches ──────────── */

describe("the hint branches the way the destruction branches", () => {
  it("scope=me really does omit the money tables", () => {
    // The premise the copy rests on. If this ever changes, the warning below
    // becomes the wrong warning and this test says so first.
    const body = personalExportBody();
    expect(body).not.toContain("db.transaction.");
    expect(body).not.toContain("db.budget.");
    expect(body).not.toContain("db.recurringRule.");
  });

  it("the account modal picks its hint from `deletesWorkspace`", () => {
    const statement = constStatement(accountModalSrc, "exportHint");
    expect(
      statement.length,
      "delete-account-modal.tsx should compute its hint in one named statement so " +
        "the branch is legible here and to the next reader"
    ).toBeGreaterThan(20);
    expect(
      branchesOnScope(statement),
      "the modal is the only place that knows which of the two destructive shapes " +
        "this is (deletesWorkspace, :101). One undifferentiated line hands a solo " +
        "founder a file with none of their ledger in it and calls it their data."
    ).toBe(true);
    expect(statement).toContain("exportBeforeWorkspaceDeleteHint");
    expect(statement).toContain("exportBeforeAccountDeleteHint");
    expect(
      statement.indexOf("exportBeforeWorkspaceDeleteHint"),
      "the workspace-destroying hint belongs in the deletesWorkspace branch"
    ).toBeLessThan(statement.indexOf("exportBeforeAccountDeleteHint"));
  });

  it("warns, in the workspace branch, about exactly what scope=me leaves out", () => {
    const hint = en.settings.exportBeforeWorkspaceDeleteHint;
    expect(hint, "must name the transactions the personal file does not carry").toMatch(
      /transaction/i
    );
    expect(hint, "must name the budgets the personal file does not carry").toMatch(/budget/i);
    expect(hint, "must point at the WORKSPACE export, which is the file that has them").toMatch(
      /workspace/i
    );
  });

  it("does not tell a solo founder the personal file is enough", () => {
    expect(
      en.settings.exportBeforeWorkspaceDeleteHint,
      "'not included' is the whole point of this string — it must not read as a " +
        "plain recommendation to download the personal file"
    ).toMatch(/not include|does not include|doesn't include/i);
  });

  it("the workspace-delete dialog carries the same warning", () => {
    // deleteWorkspaceAction destroys the identical rows, so it owes the identical
    // sentence; admin-only, so the workspace export is always reachable from it.
    expect(workspaceModalSrc).toContain("exportBeforeWorkspaceDeleteHint");
  });

  it("only points at the workspace export when the reader can reach it", () => {
    // `deletesWorkspace` is computed from `otherUsers === 0` alone and does NOT
    // consult the role, so the modal asks whether this reader can actually see
    // the workspace export card rather than assuming the last live user is an
    // admin. Silence beats pointing at a card that is not on their screen.
    expect(constStatement(accountModalSrc, "exportHint")).toContain("canExportWorkspace");
    expect(
      settingsSrc,
      "settings-client.tsx owns the finance gate; the modal must be told, not guess"
    ).toMatch(/canExportWorkspace=\{canExport\}/);
  });
});

/* ───────── both hints send the reader to a label that is really there ────── */

/**
 * The two hints tell the customer to go and find something in Data & storage. A
 * verifier found they named different KINDS of thing:
 *
 *   exportBeforeAccountDeleteHint   → “Download my data”  — the button's own text
 *   exportBeforeWorkspaceDeleteHint → “Export workspace”  — the CARD HEADING; the
 *                                      button under it reads “Export JSON”
 *
 * So the second sent a person hunting for a button that does not exist under that
 * name, in the branch where the file they are being sent for is the only one that
 * contains their ledger. Both now quote the text printed on the button, and the
 * quoted words are read out of settings-client.tsx rather than typed here, so
 * renaming a button fails this test instead of silently invalidating the copy.
 */
describe("each delete hint names the button a customer can actually find", () => {
  const workspaceExpr = exportButtonLabelExpression(settingsSrc, "workspace");
  const personalExpr = exportButtonLabelExpression(settingsSrc, "me");

  it("finds both export buttons in Data & storage to compare against", () => {
    expect(
      workspaceExpr,
      "the workspace export button's label expression moved; re-point this extractor " +
        "before trusting the assertions below"
    ).not.toBe("");
    expect(personalExpr, "the personal export button's label expression moved").not.toBe("");
  });

  it("quotes the workspace export's BUTTON, not the card heading above it", () => {
    eachLocale((dict, code) => {
      const button = resolveLabel(workspaceExpr, dict);
      expect(button, `${code}: could not resolve the workspace button's label`).not.toBe("");
      expect(
        dict.settings.exportBeforeWorkspaceDeleteHint,
        `${code}: this hint must quote "${button}", the text on the button it sends the ` +
          "reader to press"
      ).toContain(button);
      expect(
        dict.settings.exportBeforeWorkspaceDeleteHint,
        `${code}: "${dict.settings.exportWorkspace}" is the card HEADING — nothing on the ` +
          "screen is a button with that label, so a reader scanning for it finds nothing"
      ).not.toContain(dict.settings.exportWorkspace);
    });
  });

  it("quotes the personal export's button in the account-delete hint", () => {
    eachLocale((dict, code) => {
      const button = resolveLabel(personalExpr, dict);
      expect(button, `${code}: could not resolve the personal button's label`).not.toBe("");
      expect(
        dict.settings.exportBeforeAccountDeleteHint,
        `${code}: this hint must quote "${button}" — the same kind of target as the ` +
          "workspace hint, so the two do not teach the reader two different habits"
      ).toContain(button);
    });
  });
});

/* ────────────────────────────── both locales ─────────────────────────────── */

describe("the new copy exists in Urdu, not English wearing an Urdu key", () => {
  const KEYS = [
    "dangerZoneExportHint",
    "exportBeforeAccountDeleteHint",
    "exportBeforeWorkspaceDeleteHint",
  ] as const;

  it("is written in Urdu script and differs from the English", () => {
    KEYS.forEach((key) => {
      expect(ur.settings[key], `ur.settings.${key}`).toMatch(URDU_SCRIPT);
      expect(ur.settings[key], `ur.settings.${key} is still the English string`).not.toBe(
        en.settings[key]
      );
    });
  });

  it("keeps the Urdu warning as specific as the English one", () => {
    // ٹرانزیکشنز = transactions, بجٹ = budgets — the two words the Urdu reader
    // needs for the same reason the English reader does. A softened translation
    // that drops them is the acct-011 failure again, one locale at a time.
    expect(ur.settings.exportBeforeWorkspaceDeleteHint).toContain("ٹرانزیکشنز");
    expect(ur.settings.exportBeforeWorkspaceDeleteHint).toContain("بجٹ");
  });
});
