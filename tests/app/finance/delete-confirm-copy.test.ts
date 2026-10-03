// @vitest-environment node

/**
 * R4-money-016-trail, point 3 — the three finance pages told the customer the
 * delete was permanent, and it has not been since data-integrity-001.
 *
 * WHAT THE CODE DOES. `deleteTransactionAction` (lib/actions/transactions.ts)
 * stamps `deletedAt` and leaves the row — it used to call
 * `tx.transaction.delete`, and data-integrity-001 replaced that precisely so a
 * founder who mis-clicks the trash icon on a 2,500,000 expense has not destroyed
 * a ledger line. Recovery is one `UPDATE "Transaction" SET "deletedAt" = NULL
 * WHERE id = …`, run by an operator. There is no purge stage for an individually
 * tombstoned Transaction (the cron's two scopes are overdue whole workspaces and
 * empty projects), so the row keeps existing.
 *
 * WHAT THE PAGES SAID. "This action cannot be undone." — on /expenses, /revenue
 * and /investments, in the danger colour, at the one moment the customer is
 * deciding whether to risk it. This is the acct-011 defect verbatim, in the three
 * places acct-011 did not reach: the person who most needs to know there is a
 * remedy is the one told there is nothing to ask for, and support cannot restore
 * for someone who never writes in.
 *
 * WHAT THE NEW COPY MAY PROMISE, and nothing more:
 *   • "leaves your ledger, reports and exports immediately" is TRUE — every
 *     read filters `deletedAt: null`, including GET /api/export (route.ts:380,
 *     :483), so the row and its money leave the product on the click.
 *   • "nothing is erased" is TRUE for this scope, more strongly than it is in
 *     Settings: no cron stage hard-deletes an individually tombstoned
 *     Transaction at all.
 *   • it points at SUPPORT, not at a restore button — there is no restore UI and
 *     this test must never be satisfiable by promising one.
 *   • it names NO window. The 90 days in the Settings copy is the number
 *     `RETENTION_DAYS` enforces for whole-workspace erasure; quoting it here
 *     would invite a customer to believe a deadline that governs nothing on this
 *     path, and a wrong deadline is the acct-011 failure mode pointing the other
 *     way.
 *
 * WHY SOURCE ASSERTIONS. Same argument as
 * tests/app/settings/danger-zone-export-pointer.test.ts: mounting
 * ExpensesClient to read one sentence means standing up the store, the router,
 * the confirm host, the charts behind `next/dynamic` and five server actions,
 * and the property under test is legible in the source. The string is not a
 * computed value that might render nowhere — it is the `description` argument of
 * the `confirm()` call whose promise gates the delete, and
 * `ConfirmDialogHost` renders `pending.opts.description` as its only body
 * (components/ui/confirm-dialog.tsx), a path other suites already mount.
 *
 * WHY THE DETECTOR IS ITSELF TESTED. A test that encodes the bug is this repo's
 * signature defect, so the extractor and the honesty check are first pointed at
 * a synthetic copy of the WRONG shape and must come back positive there.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PAGES = [
  {
    label: "expenses",
    file: join(process.cwd(), "app", "(app)", "expenses", "expenses-client.tsx"),
  },
  { label: "revenue", file: join(process.cwd(), "app", "(app)", "revenue", "revenue-client.tsx") },
  {
    label: "investments",
    file: join(process.cwd(), "app", "(app)", "investments", "investments-client.tsx"),
  },
];

const TRANSACTIONS_ACTION = join(process.cwd(), "lib", "actions", "transactions.ts");

/** Every claim of permanence this copy may not make, in any of the three pages. */
const IRREVERSIBLE =
  /cannot be undone|can'?t be undone|permanent|irreversible|no undo|not reversible|gone for good/i;

/**
 * The `description` the delete confirmation passes to `confirm()`.
 *
 * Reads the FIRST `confirm({ … })` after `handleDelete`, and joins a
 * prettier-wrapped `"a" + "b"` concatenation back into one sentence so the
 * assertions below see what the customer sees. An `exec` loop rather than
 * `matchAll`: tsconfig has no `target`, so it defaults to ES5 and `matchAll` is
 * a typecheck error vitest would not reproduce.
 */
function deleteConfirmDescription(source: string): string {
  const handler = source.indexOf("async function handleDelete(");
  if (handler === -1) return "";
  const options = /await confirm\(\{([\s\S]*?)\}\)/.exec(source.slice(handler));
  if (!options) return "";
  const block = options[1];

  const key = block.indexOf("description:");
  if (key === -1) return "";
  const rest = block.slice(key + "description:".length);
  const nextKey = rest.search(/\n\s*[A-Za-z]+:/);
  const segment = nextKey === -1 ? rest : rest.slice(0, nextKey);

  const parts: string[] = [];
  const literal = /"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = literal.exec(segment)) !== null) parts.push(m[1]);
  return parts.join("");
}

describe("the extractor and the detector work (no silent green)", () => {
  const WRONG = [
    "  async function handleDelete(id: string) {",
    "    const ok = await confirm({",
    '      title: "Delete this expense?",',
    '      description: "This action cannot be undone.",',
    '      confirmLabel: "Delete",',
    '      tone: "danger",',
    "    });",
    "  }",
  ].join("\n");

  it("pulls the description out of the shape this file is about", () => {
    expect(deleteConfirmDescription(WRONG)).toBe("This action cannot be undone.");
  });

  it("joins a wrapped concatenation into one sentence", () => {
    const wrapped = WRONG.replace(
      '"This action cannot be undone.",',
      '"This action cannot " +\n        "be undone.",'
    );
    expect(deleteConfirmDescription(wrapped)).toBe("This action cannot be undone.");
  });

  it("flags the sentence that was there", () => {
    expect(deleteConfirmDescription(WRONG)).toMatch(IRREVERSIBLE);
  });

  it("reports nothing rather than passing when it cannot find the block", () => {
    expect(deleteConfirmDescription("export function Nope() {}")).toBe("");
  });
});

describe("delete is soft, so the copy may not call it permanent", () => {
  const action = readFileSync(TRANSACTIONS_ACTION, "utf8");
  const deletePath = action.slice(action.indexOf("export async function deleteTransactionAction"));

  it("deleteTransactionAction still only stamps a tombstone", () => {
    // The premise of every assertion below. If this ever goes back to a hard
    // delete, the copy has to change in the same commit — not this test.
    expect(deletePath).toMatch(/transaction\.update\(\{[\s\S]*?deletedAt: new Date\(\)/);
    expect(
      /tx\.transaction\.delete\(/.test(deletePath),
      "a hard delete here would make 'cannot be undone' true again"
    ).toBe(false);
  });

  PAGES.forEach(({ label, file }) => {
    const description = deleteConfirmDescription(readFileSync(file, "utf8"));

    it(`/${label} tells the truth about what delete does`, () => {
      expect(description, `no confirm({ description }) found in ${label}-client.tsx`).not.toBe("");
      expect(
        description,
        `/${label} says the delete is permanent; deleteTransactionAction writes deletedAt`
      ).not.toMatch(IRREVERSIBLE);
    });

    it(`/${label} says what IS immediate`, () => {
      // The fix must not overcorrect into "nothing really happens": the row
      // leaves every ledger, roll-up and export on the click.
      expect(description, `/${label} must still say the row goes immediately`).toMatch(/immediat/i);
    });

    it(`/${label} points at support rather than a restore button`, () => {
      // Recovery is an operator running one UPDATE. A self-service control does
      // not exist, so the copy must not imply one.
      expect(description, `/${label} must name the remedy`).toMatch(/support/i);
      expect(description, `/${label} must not promise a UI that does not exist`).not.toMatch(
        /undo button|restore button|trash|recycle bin|restore it yourself/i
      );
    });
  });

  it("says the same thing on all three pages", () => {
    const descriptions = PAGES.map(({ file }) =>
      deleteConfirmDescription(readFileSync(file, "utf8"))
    );
    expect(
      descriptions.every((d) => d === descriptions[0]),
      `three copies of one promise drifted: ${descriptions.join(" | ")}`
    ).toBe(true);
  });
});
