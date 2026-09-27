import { describe, it, expect } from "vitest";
import {
  ImportTransactionRowSchema,
  ImportTransactionsSchema,
  NewTransactionSchema,
} from "@/lib/schemas/transaction";
import { EXPENSE_CATEGORIES, INVESTMENT_CATEGORIES } from "@/lib/types";

describe("NewTransactionSchema", () => {
  const valid = {
    type: "expense" as const,
    amount: 1000,
    category: EXPENSE_CATEGORIES[0],
    description: "Office rent for March",
    date: new Date().toISOString(),
  };

  it("accepts a valid expense", () => {
    expect(NewTransactionSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts a valid investment with an investment category", () => {
    const result = NewTransactionSchema.safeParse({
      ...valid,
      type: "investment",
      category: INVESTMENT_CATEGORIES[0],
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown transaction type", () => {
    expect(NewTransactionSchema.safeParse({ ...valid, type: "donation" }).success).toBe(false);
  });

  it("rejects unknown category", () => {
    expect(NewTransactionSchema.safeParse({ ...valid, category: "Crypto Yacht" }).success).toBe(
      false
    );
  });

  it("rejects zero or negative amount", () => {
    expect(NewTransactionSchema.safeParse({ ...valid, amount: 0 }).success).toBe(false);
    expect(NewTransactionSchema.safeParse({ ...valid, amount: -100 }).success).toBe(false);
  });

  it("rejects implausibly large amount (> 1B)", () => {
    expect(NewTransactionSchema.safeParse({ ...valid, amount: 2_000_000_000 }).success).toBe(false);
  });

  it("rejects non-numeric amount", () => {
    expect(
      NewTransactionSchema.safeParse({ ...valid, amount: "1000" as unknown as number }).success
    ).toBe(false);
  });

  it("rejects future-dated transactions", () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const result = NewTransactionSchema.safeParse({ ...valid, date: tomorrow.toISOString() });
    expect(result.success).toBe(false);
  });

  it("rejects invalid date string", () => {
    expect(NewTransactionSchema.safeParse({ ...valid, date: "not-a-date" }).success).toBe(false);
  });

  it("caps description at 500 characters", () => {
    const long = "x".repeat(501);
    expect(NewTransactionSchema.safeParse({ ...valid, description: long }).success).toBe(false);
  });

  it("accepts empty description (description.max only)", () => {
    expect(NewTransactionSchema.safeParse({ ...valid, description: "" }).success).toBe(true);
  });
});

/**
 * money-002: `amount` had no scale constraint, so an amount with more than two
 * decimal places passed the boundary and was silently rewritten by the
 * `Decimal(12,2)` column. 1234.567 landed as 1234.57; 0.004 — a value that
 * passes `.positive()` — landed as 0.00, producing a transaction that shows up
 * in "N transactions" and contributes nothing to any total.
 *
 * The rule is REJECT, not round: rounding is exactly what the column already
 * does, and the complaint is that it happens without telling anyone.
 */
describe("NewTransactionSchema — amount scale (money-002)", () => {
  const valid = {
    type: "expense" as const,
    amount: 1000,
    category: EXPENSE_CATEGORIES[0],
    description: "Office rent for March",
    date: new Date().toISOString(),
  };

  it("accepts a whole amount and a 1- or 2-place amount", () => {
    expect(NewTransactionSchema.safeParse({ ...valid, amount: 1000 }).success).toBe(true);
    expect(NewTransactionSchema.safeParse({ ...valid, amount: 1000.5 }).success).toBe(true);
    expect(NewTransactionSchema.safeParse({ ...valid, amount: 1234.56 }).success).toBe(true);
    // 0.01 is the smallest thing the column can hold; it must stay legal.
    expect(NewTransactionSchema.safeParse({ ...valid, amount: 0.01 }).success).toBe(true);
  });

  it("rejects three decimal places instead of letting Postgres round them", () => {
    const result = NewTransactionSchema.safeParse({ ...valid, amount: 1234.567 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/2 decimal places/);
    }
  });

  it("rejects an amount that would be stored as zero", () => {
    // The worst case in the finding: positive on input, 0.00 in the column.
    expect(NewTransactionSchema.safeParse({ ...valid, amount: 0.004 }).success).toBe(false);
    expect(NewTransactionSchema.safeParse({ ...valid, amount: 1e-7 }).success).toBe(false);
  });

  it("still accepts a 2-place amount at the top of the allowed range", () => {
    // Guards the `v * 100` rounding test the audit suggested, which loses
    // precision at this magnitude and would refuse a legitimate amount.
    expect(NewTransactionSchema.safeParse({ ...valid, amount: 999999999.99 }).success).toBe(true);
  });
});

describe("ImportTransactionRowSchema — amount scale (money-002)", () => {
  const validRow = {
    amount: 1234.56,
    category: EXPENSE_CATEGORIES[0],
    description: "Imported row",
    date: new Date().toISOString(),
  };

  it("accepts a 2-place imported amount", () => {
    expect(ImportTransactionRowSchema.safeParse(validRow).success).toBe(true);
  });

  it("rejects a 3-place imported amount", () => {
    // The importer refuses these itself with the offending cell echoed, but a
    // hand-built POST goes straight to the server action, and the server is the
    // trust boundary — a bank CSV full of 3-place FX amounts must not be
    // quietly rounded into the ledger.
    expect(ImportTransactionRowSchema.safeParse({ ...validRow, amount: 1234.567 }).success).toBe(
      false
    );
    expect(ImportTransactionRowSchema.safeParse({ ...validRow, amount: 0.004 }).success).toBe(
      false
    );
  });

  it("rejects the whole import if one row's amount is unstorable", () => {
    const result = ImportTransactionsSchema.safeParse({
      type: "expense",
      rows: [validRow, { ...validRow, amount: 0.004 }],
    });
    expect(result.success).toBe(false);
  });
});
