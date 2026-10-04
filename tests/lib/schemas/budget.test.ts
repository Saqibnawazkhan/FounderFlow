import { describe, it, expect } from "vitest";
import { NewBudgetSchema, UpdateBudgetSchema } from "@/lib/schemas/budget";
import { EXPENSE_CATEGORIES } from "@/lib/types";

describe("NewBudgetSchema", () => {
  const valid = {
    projectId: "proj_123",
    category: EXPENSE_CATEGORIES[0],
    monthlyLimit: 50_000,
  };

  it("accepts a valid budget", () => {
    expect(NewBudgetSchema.safeParse(valid).success).toBe(true);
  });

  it("requires a projectId (budgets live inside a project)", () => {
    expect(NewBudgetSchema.safeParse({ ...valid, projectId: "" }).success).toBe(false);
  });

  it("rejects a category outside the expense list", () => {
    expect(NewBudgetSchema.safeParse({ ...valid, category: "Crypto Yacht" }).success).toBe(false);
  });

  it("rejects zero or negative limits", () => {
    expect(NewBudgetSchema.safeParse({ ...valid, monthlyLimit: 0 }).success).toBe(false);
    expect(NewBudgetSchema.safeParse({ ...valid, monthlyLimit: -1 }).success).toBe(false);
  });

  it("rejects an implausibly large limit (> 1B)", () => {
    expect(NewBudgetSchema.safeParse({ ...valid, monthlyLimit: 2_000_000_000 }).success).toBe(
      false
    );
  });

  it("rejects a non-numeric limit", () => {
    expect(
      NewBudgetSchema.safeParse({ ...valid, monthlyLimit: "50000" as unknown as number }).success
    ).toBe(false);
  });
});

/**
 * money-002, the BUDGET half.
 *
 * `Budget.monthlyLimit` is a `Decimal(12, 2)` column and the field carried only
 * `.positive().max(1e9)`, so the SCALE was left to Postgres — and a numeric
 * column rounds to scale without erroring. A cap typed as 1234.567 was stored
 * as 1234.57, and a sub-half-cent cap (0.004) was stored as 0.00: a budget whose
 * limit is zero, which is therefore over budget on the first rupee spent and
 * fires an 80%/100% alert nobody can explain — with nothing on screen saying the
 * number had been changed.
 *
 * Same decision as `lib/schemas/transaction.ts`: REJECT rather than round.
 * Rounding is precisely what the column already does; the defect is that it is
 * silent. Both paths share one rule, because a correction must not be the one
 * way a 3-place cap gets in.
 */
describe("budget limits — storable scale (money-002)", () => {
  const valid = {
    projectId: "proj_123",
    category: EXPENSE_CATEGORIES[0],
    monthlyLimit: 50_000,
  };

  it("accepts whole, 1-place and 2-place caps", () => {
    for (const monthlyLimit of [50_000, 1_000.5, 1_234.56, 0.01]) {
      expect(
        NewBudgetSchema.safeParse({ ...valid, monthlyLimit }).success,
        `${monthlyLimit} is storable and must stay legal`
      ).toBe(true);
    }
  });

  it("rejects a 3-place cap instead of letting Postgres round it", () => {
    const result = NewBudgetSchema.safeParse({ ...valid, monthlyLimit: 1234.567 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/2 decimal places/);
    }
  });

  it("rejects a cap that would be stored as zero", () => {
    // The worst case in the finding: positive on input, 0.00 in the column, so
    // the project is instantly and permanently over its cap.
    expect(NewBudgetSchema.safeParse({ ...valid, monthlyLimit: 0.004 }).success).toBe(false);
    expect(NewBudgetSchema.safeParse({ ...valid, monthlyLimit: 1e-7 }).success).toBe(false);
  });

  it("still accepts a 2-place cap at the top of the allowed range", () => {
    // Guards against the `v * 100` integer check the audit originally suggested:
    // it loses precision at this magnitude and would refuse a legitimate cap. It
    // was declined on the transaction path for exactly this reason.
    expect(NewBudgetSchema.safeParse({ ...valid, monthlyLimit: 999999999.99 }).success).toBe(true);
  });

  it("holds the update path to the same rule", () => {
    expect(UpdateBudgetSchema.safeParse({ budgetId: "b1", monthlyLimit: 1234.567 }).success).toBe(
      false
    );
    expect(UpdateBudgetSchema.safeParse({ budgetId: "b1", monthlyLimit: 0.004 }).success).toBe(
      false
    );
    expect(UpdateBudgetSchema.safeParse({ budgetId: "b1", monthlyLimit: 1234.56 }).success).toBe(
      true
    );
  });
});

describe("UpdateBudgetSchema", () => {
  it("accepts a budgetId with an updated limit", () => {
    expect(UpdateBudgetSchema.safeParse({ budgetId: "b1", monthlyLimit: 10_000 }).success).toBe(
      true
    );
  });

  it("accepts toggling active without a limit", () => {
    expect(UpdateBudgetSchema.safeParse({ budgetId: "b1", active: false }).success).toBe(true);
  });

  it("accepts just a budgetId (both optional)", () => {
    expect(UpdateBudgetSchema.safeParse({ budgetId: "b1" }).success).toBe(true);
  });

  it("requires a budgetId", () => {
    expect(UpdateBudgetSchema.safeParse({ budgetId: "", monthlyLimit: 10 }).success).toBe(false);
  });

  it("still enforces the positive-limit rule when a limit is given", () => {
    expect(UpdateBudgetSchema.safeParse({ budgetId: "b1", monthlyLimit: -5 }).success).toBe(false);
  });
});
