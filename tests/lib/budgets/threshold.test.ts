import { describe, it, expect } from "vitest";
import {
  ALERT_PCT,
  WARN_PCT,
  decideThreshold,
  monthKey,
  type BudgetForCheck,
} from "@/lib/budgets/threshold";

function budget(overrides: Partial<BudgetForCheck> = {}): BudgetForCheck {
  return {
    id: "b1",
    monthlyLimit: 1000,
    lastWarnedMonth: null,
    lastAlertedMonth: null,
    ...overrides,
  };
}

describe("monthKey", () => {
  it("returns YYYY-MM padded", () => {
    expect(monthKey(new Date(Date.UTC(2026, 0, 5)))).toBe("2026-01");
    expect(monthKey(new Date(Date.UTC(2026, 10, 30)))).toBe("2026-11");
    expect(monthKey(new Date(Date.UTC(2026, 11, 31, 23, 59)))).toBe("2026-12");
  });
});

describe("decideThreshold — warning band (80% ≤ pct < 100%)", () => {
  const now = new Date(Date.UTC(2026, 4, 15)); // 2026-05-15

  it("fires at exactly 80%", () => {
    const d = decideThreshold(budget(), 800, now);
    expect(d?.kind).toBe("warning");
  });

  it("fires at 90%", () => {
    expect(decideThreshold(budget(), 900, now)?.kind).toBe("warning");
  });

  it("does not fire below 80%", () => {
    expect(decideThreshold(budget(), 799, now)).toBeNull();
  });

  it("does not fire if warning already fired this month", () => {
    expect(decideThreshold(budget({ lastWarnedMonth: "2026-05" }), 800, now)).toBeNull();
  });

  it("does fire if warning fired a different month", () => {
    expect(decideThreshold(budget({ lastWarnedMonth: "2026-04" }), 800, now)?.kind).toBe("warning");
  });

  it("WARN_PCT constant exposes the threshold", () => {
    expect(WARN_PCT).toBe(0.8);
  });
});

describe("decideThreshold — alert band (pct ≥ 100%)", () => {
  const now = new Date(Date.UTC(2026, 4, 15));

  it("fires at exactly 100%", () => {
    expect(decideThreshold(budget(), 1000, now)?.kind).toBe("alert");
  });

  it("fires above 100%", () => {
    expect(decideThreshold(budget(), 1500, now)?.kind).toBe("alert");
  });

  it("alert wins over warning at 100% even if warning hasn't fired", () => {
    const d = decideThreshold(budget({ lastWarnedMonth: null }), 1000, now);
    expect(d?.kind).toBe("alert");
  });

  it("does not double-fire alert in the same month", () => {
    expect(decideThreshold(budget({ lastAlertedMonth: "2026-05" }), 1000, now)).toBeNull();
  });

  it("does fire alert if last fired a previous month", () => {
    expect(decideThreshold(budget({ lastAlertedMonth: "2026-03" }), 1500, now)?.kind).toBe("alert");
  });

  it("ALERT_PCT constant exposes the threshold", () => {
    expect(ALERT_PCT).toBe(1.0);
  });
});

describe("decideThreshold — edge cases", () => {
  const now = new Date(Date.UTC(2026, 4, 15));

  it("zero limit never fires", () => {
    expect(decideThreshold(budget({ monthlyLimit: 0 }), 1000, now)).toBeNull();
  });

  it("negative limit never fires", () => {
    expect(decideThreshold(budget({ monthlyLimit: -100 }), 1000, now)).toBeNull();
  });

  it("zero spend never fires", () => {
    expect(decideThreshold(budget(), 0, now)).toBeNull();
  });

  it("returns the budget id so callers can update the right row", () => {
    const d = decideThreshold(budget({ id: "specific-id" }), 1500, now);
    expect(d?.budgetId).toBe("specific-id");
  });

  it("returns percentUsed so the message can include it", () => {
    const d = decideThreshold(budget({ monthlyLimit: 1000 }), 850, now);
    expect(d?.percentUsed).toBeCloseTo(0.85);
  });
});
