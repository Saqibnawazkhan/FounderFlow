/**
 * The runway documentation describes the arithmetic this product RUNS (R6-docs).
 *
 * money-017 moved burn and runway into `lib/finance/runway.ts` and changed both
 * of them on the way: the divisor stopped being a constant 3 and became
 * `burnMonthsCovered()` — the months of ledger the window actually covers — and
 * the no-burn case stopped being `Infinity` and became `null` on BOTH surfaces
 * (`runwayMonths()`, used by `/dashboard` and by the chat card alike).
 *
 * `RunwayPayloadSchema`'s header, one file away, still printed the formula that
 * was deleted — "monthlyBurn = the last 3 months of expenses ÷ 3" — and still
 * pointed a reader at `app/(app)/dashboard/dashboard-client.tsx` as the
 * definition of a figure that file now imports. The header is the document
 * somebody reads before writing the NEXT caller of this payload, so a stale
 * formula there is how a corrected formula gets reintroduced. This repo weights a
 * false comment as a defect equal to wrong code; CLAUDE.md records three
 * incidents caused by exactly that, and `tests/lib/db/restore-runbook.test.ts` is
 * the precedent for pinning a documentation claim with a test rather than
 * remembering it.
 *
 * WHAT IS CHECKED IS DERIVED, NOT TRANSCRIBED. The divisor the header names has
 * to be a symbol `lib/finance/runway.ts` actually exports, and the file it names
 * as the definition has to be the file that defines it — so re-pointing either at
 * a module that does not hold the arithmetic fails here, whatever the prose
 * around it says.
 */

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runwayMonths } from "@/lib/finance/runway";

const ROOT = process.cwd();

function source(relPath: string): string {
  return readFileSync(join(ROOT, relPath), "utf8");
}

/** A doc comment as one line: comment markers gone, whitespace collapsed. */
function prose(text: string): string {
  return text.replace(/^[\t ]*(?:\/\*+|\*\/|\*|\/\/)[\t ]?/gm, " ").replace(/\s+/g, " ");
}

const RUNWAY_MODULE = "lib/finance/runway.ts";

/** The names `lib/finance/runway.ts` exports — the vocabulary a doc may use. */
function exportedFunctions(): string[] {
  const names: string[] = [];
  const re = /export function (\w+)/g;
  const text = source(RUNWAY_MODULE);
  let m: RegExpExecArray | null = re.exec(text);
  while (m !== null) {
    names.push(m[1]);
    m = re.exec(text);
  }
  return names;
}

/** The `RunwayPayloadSchema` doc comment, from its first line to the schema. */
function payloadHeader(): string {
  const text = source("lib/schemas/chat.ts");
  const start = text.indexOf("The stored payload of a Runway card");
  const end = text.indexOf("export const RunwayPayloadSchema");
  expect(start, "lib/schemas/chat.ts no longer documents the stored payload").toBeGreaterThan(-1);
  expect(end, "RunwayPayloadSchema is gone from lib/schemas/chat.ts").toBeGreaterThan(start);
  return text.slice(start, end);
}

describe("the stored Runway payload's header", () => {
  it("does not divide the burn window by a constant", () => {
    const header = prose(payloadHeader());
    const formula = /monthlyBurn\s*=\s*([^;]*?)(?:runwayMonths|$)/.exec(header);
    expect(formula, "the header no longer states what monthlyBurn is").not.toBeNull();
    const stated = formula ? formula[1] : "";
    expect(
      /(?:÷|\/)\s*\d/.test(stated),
      `the header still divides by a literal: "${stated.trim()}" — the divisor is burnMonthsCovered(), the months of ledger the window covers (money-017)`
    ).toBe(false);
  });

  it("names the divisor this product actually uses", () => {
    const header = prose(payloadHeader());
    const exported = exportedFunctions();
    let named = "";
    for (let i = 0; i < exported.length; i++) {
      if (header.indexOf(exported[i]) > -1) named = exported[i];
    }
    expect(
      named,
      `the header names no function from ${RUNWAY_MODULE}, so the formula it prints is not the one that runs`
    ).not.toBe("");
  });

  it("points a reader at the module that defines the arithmetic", () => {
    const header = payloadHeader();
    const re = /(?:[\w().[\]-]+\/)+[\w.()[\]-]+\.tsx?/g;
    const referenced: string[] = [];
    let m: RegExpExecArray | null = re.exec(header);
    while (m !== null) {
      // A path written in prose is usually parenthesised — "(lib/finance/
      // runway.ts)" — and `app/(app)/…` has its own brackets, so only an
      // unbalanced opener at the front is decoration.
      referenced.push(m[0].replace(/^\(+/, ""));
      m = re.exec(header);
    }

    let definer = "";
    for (let i = 0; i < referenced.length; i++) {
      const path = referenced[i];
      expect(
        existsSync(join(ROOT, path)),
        `the header points at ${path}, which does not exist`
      ).toBe(true);
      if (source(path).indexOf("export function averageMonthlyBurn") > -1) definer = path;
    }

    expect(
      definer,
      `the header references ${referenced.join(", ") || "no file"} — none of which defines the burn arithmetic. The field set mirrors ${RUNWAY_MODULE}; say so, or the next reader goes looking in the wrong file`
    ).not.toBe("");
  });
});

/**
 * The no-burn case, and every copy of its documentation.
 *
 * The files below are the copies that explain what `runwayMonths: null` MEANS —
 * the schema, the query DTO, the component, the action, the module itself, the
 * dashboard, and the two test files that assert the behaviour. Five of them
 * called null "the JSON spelling of the dashboard's `Infinity`", which was true
 * while the dashboard ran its own division and let it go to infinity. It no
 * longer does: `runwayMonths()` returns null for both surfaces, so there is no
 * `Infinity` anywhere for null to be the spelling OF, and a reader who believes
 * there is will go looking for a conversion that does not exist — or add one.
 */
const NO_BURN_DOCS = [
  "lib/schemas/chat.ts",
  "lib/queries/chat.ts",
  "lib/actions/chat.ts",
  "lib/finance/runway.ts",
  "components/chat/runway-card.tsx",
  "app/(app)/dashboard/dashboard-client.tsx",
  "tests/lib/schemas/chat.test.ts",
  "tests/components/runway-card.test.tsx",
];

describe("no runway doc credits a live surface with an Infinity", () => {
  it("is null, not Infinity, when there is no burn to divide by", () => {
    // The premise, executed rather than asserted in prose: the one function both
    // surfaces call never produces the value the docs below attributed to them.
    expect(runwayMonths(500_000, 0)).toBeNull();
    expect(runwayMonths(0, 0)).toBeNull();
    expect(runwayMonths(500_000, 125_000)).toBe(4);
  });

  it("says so nowhere in the files that document the payload", () => {
    for (let i = 0; i < NO_BURN_DOCS.length; i++) {
      const text = prose(source(NO_BURN_DOCS[i]));
      // Narrow on purpose: it is the ATTRIBUTION that is false — null as "the
      // spelling of the dashboard's `Infinity`", or "the version of it is
      // `Infinity`" — and not the word itself, which several of these files use
      // truthfully ("null, not Infinity", "JSON cannot carry Infinity",
      // "`.finite()` rejects ±Infinity"). A test that banned the word would make
      // the honest sentences unwritable, which is how a doc guard starts being
      // worked around instead of obeyed.
      const hit = /(?:spelling|version|form) of [^.]{0,40}`?Infinity/.exec(text);
      expect(
        hit === null,
        `${NO_BURN_DOCS[i]} still calls null the wire spelling of a live Infinity: "…${hit ? hit[0] : ""}…" — runwayMonths() returns null on every surface`
      ).toBe(true);
    }
  });
});
