/**
 * transactions-ledger-014 — the importer must not read money out of the wrong
 * column.
 *
 * WHAT WAS WRONG. `findColumn` was
 *
 *     headers.findIndex((h) => candidates.some((c) => h.includes(c)))
 *
 * — the FIRST header, in header order, that contains ANY candidate anywhere in
 * it. Substring, with no preference for a header that is actually named what we
 * are looking for:
 *
 *     ["date","subtotal","amount"]    amount candidates include "total"
 *                                     → "subtotal", because it comes first
 *     ["date","amount","allocation","category"]
 *                                     category candidates include "cat"
 *                                     → "allocation", because it comes first
 *
 * Both files have the right column, correctly named, sitting one place to the
 * right. The preview then showed the wrong column's values with no error
 * anywhere, and the numbers were plausible — a subtotal looks exactly like an
 * amount, and an allocation cell may well hold a real category name.
 *
 * THE CONTRACT PINNED HERE: a header that IS the name wins over a header that
 * merely contains it, and when two headers match equally well the loser is
 * reported (`rivals`) so the dialog can say so and let the customer re-point the
 * column. Nothing here guesses silently.
 *
 * The UI half of the same contract — the mapping is on screen and editable — is
 * pinned in tests/components/import-modal-column-mapping.test.tsx.
 */

import { describe, expect, it } from "vitest";
import { detectColumn, findColumn } from "@/lib/transactions/csv";

/** The real candidate lists from components/transactions/import-transactions-modal.tsx. */
const AMOUNT = ["amount", "value", "cost", "price", "total"];
const CATEGORY = ["category", "cat"];
const DESCRIPTION = ["description", "desc", "note", "memo", "detail"];

describe("detectColumn — an exact header name beats a substring hit", () => {
  it("picks 'amount' over an earlier 'subtotal'", () => {
    const headers = ["date", "subtotal", "amount", "category"];
    expect(
      detectColumn(headers, AMOUNT).index,
      "the subtotal column was imported as the transaction amount"
    ).toBe(2);
  });

  it("picks 'category' over an earlier 'allocation'", () => {
    const headers = ["date", "amount", "allocation", "category"];
    expect(
      detectColumn(headers, CATEGORY).index,
      "'allocation' contains 'cat', so it was read as the category column"
    ).toBe(3);
  });

  it("picks 'description' over an earlier 'notes to self'", () => {
    const headers = ["date", "amount", "category", "notes to self", "description"];
    expect(detectColumn(headers, DESCRIPTION).index).toBe(4);
  });

  it("reports the match quality it settled for", () => {
    expect(detectColumn(["amount"], AMOUNT).quality).toBe("exact");
    expect(detectColumn(["amount (pkr)"], AMOUNT).quality).toBe("prefix");
    expect(detectColumn(["subtotal"], AMOUNT).quality).toBe("substring");
    expect(detectColumn(["vendor"], AMOUNT).quality).toBe("none");
  });
});

describe("detectColumn — a prefix beats a hit buried mid-word", () => {
  it("picks 'amount paid' over an earlier 'subtotal'", () => {
    expect(detectColumn(["date", "subtotal", "amount paid"], AMOUNT).index).toBe(2);
  });
});

describe("detectColumn — equally good matches are ranked by candidate, then order", () => {
  it("prefers the more canonical candidate: 'amount' over an earlier 'cost'", () => {
    // Both are exact names of money columns, so neither is a misread. The
    // candidate list is written most-canonical-first and that is the tiebreak.
    const match = detectColumn(["date", "cost", "amount"], AMOUNT);
    expect(match.index).toBe(2);
    expect(match.rivals, "the column we did NOT pick has to be nameable").toEqual([1]);
  });

  it("falls back to header order when the candidate is the same", () => {
    const match = detectColumn(["date", "subtotal", "grand total"], AMOUNT);
    expect(match.index).toBe(1);
    expect(match.quality).toBe("substring");
    // Neither is named "amount". The importer cannot know which one is the row's
    // money, so the tie is surfaced rather than resolved in silence.
    expect(match.rivals).toEqual([2]);
  });

  it("reports no rival when the winner is decisive", () => {
    expect(detectColumn(["date", "subtotal", "amount", "category"], AMOUNT).rivals).toEqual([]);
    expect(detectColumn(["date", "amount", "category", "description"], AMOUNT).rivals).toEqual([]);
  });
});

describe("detectColumn — nothing matched", () => {
  it("returns -1 with no rivals", () => {
    expect(detectColumn(["date", "vendor", "merchant"], AMOUNT)).toEqual({
      index: -1,
      quality: "none",
      rivals: [],
    });
  });

  it("ignores an empty candidate rather than matching every header", () => {
    // "".includes("") is true for every header, so an empty candidate would
    // otherwise claim column 0 whatever the file holds.
    expect(detectColumn(["date", "vendor"], ["", "amount"]).index).toBe(-1);
  });
});

describe("findColumn — the index-only shorthand, ranked the same way", () => {
  it("picks the exactly-named column, not the first substring hit", () => {
    expect(
      findColumn(["date", "subtotal", "amount", "category"], AMOUNT),
      "findColumn still returns the subtotal column"
    ).toBe(2);
    expect(
      findColumn(["date", "amount", "allocation", "category"], CATEGORY),
      "findColumn still returns the allocation column"
    ).toBe(3);
  });

  it("returns -1 when nothing matches", () => {
    expect(findColumn(["date", "vendor", "merchant"], AMOUNT)).toBe(-1);
  });
});
