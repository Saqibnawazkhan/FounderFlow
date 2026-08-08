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
