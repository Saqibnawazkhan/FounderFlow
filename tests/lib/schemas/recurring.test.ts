import { describe, it, expect } from "vitest";
import { NewRecurringRuleSchema, ToggleRecurringRuleSchema } from "@/lib/schemas/recurring";
import { EXPENSE_CATEGORIES, INVESTMENT_CATEGORIES } from "@/lib/types";

describe("NewRecurringRuleSchema — monthly", () => {
  const valid = {
    type: "expense" as const,
    amount: 50_000,
    category: EXPENSE_CATEGORIES[0],
    description: "Office rent",
    frequency: "monthly" as const,
    dayOfMonth: 1,
  };

  it("accepts a valid monthly rule", () => {
    expect(NewRecurringRuleSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects monthly without dayOfMonth", () => {
    const result = NewRecurringRuleSchema.safeParse({
      ...valid,
      dayOfMonth: undefined as unknown as number,
    });
    expect(result.success).toBe(false);
  });

  it("rejects dayOfMonth = 0 or > 31", () => {
    expect(NewRecurringRuleSchema.safeParse({ ...valid, dayOfMonth: 0 }).success).toBe(false);
    expect(NewRecurringRuleSchema.safeParse({ ...valid, dayOfMonth: 32 }).success).toBe(false);
  });

  it("accepts dayOfMonth at the boundaries (1 and 31)", () => {
    expect(NewRecurringRuleSchema.safeParse({ ...valid, dayOfMonth: 1 }).success).toBe(true);
    expect(NewRecurringRuleSchema.safeParse({ ...valid, dayOfMonth: 31 }).success).toBe(true);
  });

  it("rejects non-integer dayOfMonth", () => {
    expect(NewRecurringRuleSchema.safeParse({ ...valid, dayOfMonth: 15.5 }).success).toBe(false);
  });
});

describe("NewRecurringRuleSchema — weekly", () => {
  const valid = {
    type: "investment" as const,
    amount: 1_000,
    category: INVESTMENT_CATEGORIES[0],
    description: "Weekly top-up",
    frequency: "weekly" as const,
    dayOfWeek: 1, // Monday
  };

  it("accepts a valid weekly rule", () => {
    expect(NewRecurringRuleSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects weekly without dayOfWeek", () => {
    expect(
      NewRecurringRuleSchema.safeParse({
        ...valid,
        dayOfWeek: undefined as unknown as number,
      }).success
    ).toBe(false);
  });

  it("rejects dayOfWeek out of 0-6 range", () => {
    expect(NewRecurringRuleSchema.safeParse({ ...valid, dayOfWeek: -1 }).success).toBe(false);
    expect(NewRecurringRuleSchema.safeParse({ ...valid, dayOfWeek: 7 }).success).toBe(false);
  });

  it("accepts boundaries (0=Sun, 6=Sat)", () => {
    expect(NewRecurringRuleSchema.safeParse({ ...valid, dayOfWeek: 0 }).success).toBe(true);
    expect(NewRecurringRuleSchema.safeParse({ ...valid, dayOfWeek: 6 }).success).toBe(true);
  });
});

describe("NewRecurringRuleSchema — shared field gates", () => {
  const monthly = {
    type: "expense" as const,
    amount: 100,
    category: EXPENSE_CATEGORIES[0],
    description: "x",
    frequency: "monthly" as const,
    dayOfMonth: 1,
  };

  it("rejects unknown category", () => {
    expect(NewRecurringRuleSchema.safeParse({ ...monthly, category: "Yacht" }).success).toBe(false);
  });

  it("rejects amount <= 0", () => {
    expect(NewRecurringRuleSchema.safeParse({ ...monthly, amount: 0 }).success).toBe(false);
    expect(NewRecurringRuleSchema.safeParse({ ...monthly, amount: -10 }).success).toBe(false);
  });

  it("rejects unknown frequency via discriminated union", () => {
    expect(
      NewRecurringRuleSchema.safeParse({
        ...monthly,
        frequency: "yearly" as never,
      }).success
    ).toBe(false);
  });

  it("rejects unknown type", () => {
    expect(
      NewRecurringRuleSchema.safeParse({
        ...monthly,
        type: "transfer" as never,
      }).success
    ).toBe(false);
  });
});

describe("ToggleRecurringRuleSchema", () => {
  it("accepts a valid toggle", () => {
    expect(ToggleRecurringRuleSchema.safeParse({ ruleId: "r1", active: true }).success).toBe(true);
    expect(ToggleRecurringRuleSchema.safeParse({ ruleId: "r1", active: false }).success).toBe(true);
  });

  it("rejects empty ruleId", () => {
    expect(ToggleRecurringRuleSchema.safeParse({ ruleId: "", active: true }).success).toBe(false);
  });

  it("rejects non-boolean active", () => {
    expect(
      ToggleRecurringRuleSchema.safeParse({
        ruleId: "r1",
        active: "yes" as unknown as boolean,
      }).success
    ).toBe(false);
  });
});
