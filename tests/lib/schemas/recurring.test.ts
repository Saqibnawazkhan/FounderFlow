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

/**
 * money-002, the RECURRING half.
 *
 * `RecurringRule.amount` is a `Decimal(12, 2)` column and the field carried only
 * `.positive().max(1e9)`, so the SCALE was left to Postgres, which rounds to
 * scale without erroring. A rule typed as 0.004 created a rule AND a seed
 * expense that both stored 0.00 — and then went on re-posting 0.00 every month
 * for as long as the rule lived, each posting counting in "N txns" and
 * contributing nothing to any total.
 *
 * REJECT rather than round, exactly as `lib/schemas/transaction.ts` does. The
 * two union members share ONE field so the weekly path cannot be the looser one.
 */
describe("NewRecurringRuleSchema — amount scale (money-002)", () => {
  const monthly = {
    type: "expense" as const,
    amount: 50_000,
    category: EXPENSE_CATEGORIES[0],
    description: "Office rent",
    frequency: "monthly" as const,
    dayOfMonth: 1,
  };
  const weekly = {
    type: "expense" as const,
    amount: 50_000,
    category: EXPENSE_CATEGORIES[0],
    description: "Cleaning",
    frequency: "weekly" as const,
    dayOfWeek: 1,
  };

  it("accepts whole, 1-place and 2-place amounts", () => {
    for (const amount of [50_000, 1_000.5, 1_234.56, 0.01]) {
      expect(
        NewRecurringRuleSchema.safeParse({ ...monthly, amount }).success,
        `${amount} is storable and must stay legal`
      ).toBe(true);
    }
  });

  it("rejects three decimal places instead of letting Postgres round them", () => {
    const result = NewRecurringRuleSchema.safeParse({ ...monthly, amount: 1234.567 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/2 decimal places/);
    }
  });

  it("rejects an amount that would be stored as zero, on BOTH frequencies", () => {
    // A recurring 0.00 is the worst shape of this finding: it re-posts a
    // meaningless row on every cron run, for ever.
    expect(NewRecurringRuleSchema.safeParse({ ...monthly, amount: 0.004 }).success).toBe(false);
    expect(NewRecurringRuleSchema.safeParse({ ...weekly, amount: 0.004 }).success).toBe(false);
    expect(NewRecurringRuleSchema.safeParse({ ...weekly, amount: 1234.567 }).success).toBe(false);
  });

  it("still accepts a 2-place amount at the top of the allowed range", () => {
    // The `v * 100` integer check the audit originally suggested loses precision
    // here and would refuse a legitimate amount; declined on the transaction
    // path for this reason and declined here for the same one.
    expect(NewRecurringRuleSchema.safeParse({ ...monthly, amount: 999999999.99 }).success).toBe(
      true
    );
  });
});

/**
 * money-005, the schema half.
 *
 * Every Budget in this product belongs to a Project, and
 * `checkBudgetThresholdAfterExpense` returns early the instant `projectId` is
 * null — so an untagged rule can never trip an 80%/100% alert. The column, the
 * action, the materializer and the activity row all carried the tag already;
 * this union did not declare it, and a plain `z.object` STRIPS what it does not
 * declare. `createRecurringRuleAction` therefore had to re-parse the raw input
 * for the tag on its own (lib/actions/recurring.ts:53) and said so in a comment:
 * the union is the tag's proper home.
 *
 * OPTIONAL, and it must stay optional: `RecurringRule.projectId` is
 * `String?` and an untagged rule is the legal, pre-projects, company-global
 * spend path.
 */
describe("NewRecurringRuleSchema — optional project tag (money-005)", () => {
  const monthly = {
    type: "expense" as const,
    amount: 50_000,
    category: EXPENSE_CATEGORIES[0],
    description: "Office rent",
    frequency: "monthly" as const,
    dayOfMonth: 1,
  };

  it("carries the tag through, rather than stripping it", () => {
    const result = NewRecurringRuleSchema.safeParse({ ...monthly, projectId: "p1" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(
        result.data.projectId,
        "the union dropped the tag, so the budget alert for this project can never fire"
      ).toBe("p1");
    }
  });

  it("carries it on the weekly member too", () => {
    const result = NewRecurringRuleSchema.safeParse({
      type: "expense",
      amount: 500,
      category: EXPENSE_CATEGORIES[0],
      description: "Cleaning",
      frequency: "weekly",
      dayOfWeek: 1,
      projectId: "p2",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.projectId).toBe("p2");
  });

  it("accepts a rule with no tag at all", () => {
    const result = NewRecurringRuleSchema.safeParse(monthly);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.projectId).toBeUndefined();
  });

  it("treats an empty or null tag as no tag", () => {
    // A "no project" <select> option sends one of these. Both have to mean a SQL
    // NULL, not a project id of "".
    for (const projectId of ["", null]) {
      const result = NewRecurringRuleSchema.safeParse({ ...monthly, projectId });
      expect(result.success, `projectId: ${JSON.stringify(projectId)}`).toBe(true);
      if (result.success) expect(result.data.projectId).toBeUndefined();
    }
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
