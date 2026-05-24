import { describe, it, expect } from "vitest";
import { NewTransactionSchema } from "@/lib/schemas/transaction";
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
