import { describe, it, expect, beforeEach } from "vitest";
import {
  DAILY_NOTIFICATION_EMAIL_BUDGET,
  __resetEmailBudget,
  claimEmailBudget,
  remainingEmailBudget,
} from "@/lib/email/quota";

const DAY_MS = 24 * 60 * 60 * 1000;
const T0 = 1_780_000_000_000;

beforeEach(() => {
  __resetEmailBudget();
});

describe("claimEmailBudget (the notification-email circuit breaker)", () => {
  it("grants the whole request while there is room", () => {
    expect(claimEmailBudget(5, T0)).toBe(5);
    expect(remainingEmailBudget(T0)).toBe(DAILY_NOTIFICATION_EMAIL_BUDGET - 5);
  });

  it("accumulates across separate claims", () => {
    claimEmailBudget(3, T0);
    claimEmailBudget(4, T0);
    expect(remainingEmailBudget(T0)).toBe(DAILY_NOTIFICATION_EMAIL_BUDGET - 7);
  });

  it("grants only what is left rather than refusing the whole batch", () => {
    // A budget alert going to five people when two sends remain should reach
    // two of them, not nobody. Everyone still gets the in-app row.
    claimEmailBudget(DAILY_NOTIFICATION_EMAIL_BUDGET - 2, T0);
    expect(claimEmailBudget(5, T0)).toBe(2);
    expect(remainingEmailBudget(T0)).toBe(0);
  });

  it("grants nothing once the day's budget is gone", () => {
    claimEmailBudget(DAILY_NOTIFICATION_EMAIL_BUDGET, T0);
    expect(claimEmailBudget(1, T0)).toBe(0);
    expect(claimEmailBudget(100, T0)).toBe(0);
  });

  it("never grants more than asked for", () => {
    expect(claimEmailBudget(2, T0)).toBe(2);
  });

  it("treats a zero or negative request as nothing to do", () => {
    expect(claimEmailBudget(0, T0)).toBe(0);
    expect(claimEmailBudget(-3, T0)).toBe(0);
    expect(remainingEmailBudget(T0)).toBe(DAILY_NOTIFICATION_EMAIL_BUDGET);
  });

  it("starts a fresh budget once the window rolls over", () => {
    claimEmailBudget(DAILY_NOTIFICATION_EMAIL_BUDGET, T0);
    expect(claimEmailBudget(1, T0)).toBe(0);
    expect(claimEmailBudget(1, T0 + DAY_MS)).toBe(1);
    expect(remainingEmailBudget(T0 + DAY_MS)).toBe(DAILY_NOTIFICATION_EMAIL_BUDGET - 1);
  });

  it("does not roll over a moment early", () => {
    claimEmailBudget(DAILY_NOTIFICATION_EMAIL_BUDGET, T0);
    expect(claimEmailBudget(1, T0 + DAY_MS - 1)).toBe(0);
  });
});

describe("DAILY_NOTIFICATION_EMAIL_BUDGET", () => {
  it("leaves headroom under Gmail's free-tier cap for transactional mail", () => {
    // Gmail free is ~500/day and rejects EVERYTHING once tripped — including
    // password resets and invites, which people cannot use the product without.
    // Notification email must never be able to consume the whole allowance.
    expect(DAILY_NOTIFICATION_EMAIL_BUDGET).toBeLessThan(500);
  });
});
