// @vitest-environment node

/**
 * finance-planning-005 — once a budget alert fired, that budget went SILENT for
 * the rest of the calendar month. Including after you deleted the mis-typed
 * expense that tripped it.
 *
 * `lastWarnedMonth` / `lastAlertedMonth` are per-month sentinels, claimed before
 * the fan-out so two concurrent expenses cannot both email (that part is right and
 * is not touched here). Nothing ever cleared them: a grep across `lib/` found
 * writes only in `lib/budgets/check.ts`, and only ever setting them. So:
 *
 *   • A founder fat-fingers 5,000,000 instead of 5,000. The 100% alert emails and
 *     pushes to everyone who can see the project's money. They delete the typo.
 *     The budget is now at 4% — and it will not warn or alert again until the 1st
 *     of next month, however much the project really spends.
 *   • The sentinel recorded "we notified THIS MONTH" when the thing worth
 *     recording is "we notified about THIS STATE". The finding says exactly that,
 *     and it is the right frame.
 *
 * THE RE-ARM IS PER THRESHOLD, not one flag for both. Each sentinel clears when
 * its OWN threshold is no longer crossed:
 *
 *   • below 80% → both clear (neither threshold is crossed);
 *   • between 80% and 100% → the alert sentinel clears, the warning one does not.
 *     They have already been told they are at 85%; telling them again is noise.
 *     But if they then genuinely cross 100%, that is news, and under the old
 *     behaviour it was silence.
 *
 * WHAT IS DELIBERATELY NOT DONE: re-arming from a budget-limit edit. There is no
 * action that changes `monthlyLimit` yet — that is finance-planning-006, a
 * separate open finding — so there is no call site to hook. When it lands, the
 * re-arm below runs on the next expense anyway, because it is driven by the
 * PERCENTAGE rather than by the event.
 *
 * `decideRearm` is pure, so these walk the whole state space without a database.
 * The wiring half — that a transaction DELETE reaches this at all, which is the
 * case the finding is actually about — is asserted at the bottom.
 */

import { describe, it, expect } from "vitest";
import { decideRearm, decideThreshold, monthKey } from "@/lib/budgets/threshold";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const NOW = new Date("2026-09-30T12:00:00Z");
const THIS_MONTH = monthKey(NOW);
const LAST_MONTH = "2026-08";

function budget(over: Partial<Parameters<typeof decideRearm>[0]> = {}) {
  return {
    id: "b_marketing",
    monthlyLimit: 10_000,
    lastWarnedMonth: null as string | null,
    lastAlertedMonth: null as string | null,
    ...over,
  };
}

describe("finance-planning-005 — correcting the mistake re-arms the alert", () => {
  it("clears both sentinels once spend falls back under 80%", () => {
    // The fat-finger case: 5,000,000 posted, alert fired, typo deleted.
    const b = budget({ lastWarnedMonth: THIS_MONTH, lastAlertedMonth: THIS_MONTH });
    expect(decideRearm(b, 400, NOW)).toEqual({
      lastWarnedMonth: null,
      lastAlertedMonth: null,
    });
  });

  it("re-arms the ALERT but not the warning between 80% and 100%", () => {
    // They know they are at 85%. Saying it again is noise. But crossing 100%
    // later is news, and that is what was silent.
    const b = budget({ lastWarnedMonth: THIS_MONTH, lastAlertedMonth: THIS_MONTH });
    expect(decideRearm(b, 8_500, NOW)).toEqual({ lastAlertedMonth: null });
  });

  it("does nothing while the budget is still over its cap", () => {
    const b = budget({ lastWarnedMonth: THIS_MONTH, lastAlertedMonth: THIS_MONTH });
    expect(decideRearm(b, 12_000, NOW)).toBeNull();
  });

  it("does nothing when there is no sentinel to clear", () => {
    // Must not write on every single expense. The re-arm is a correction, not a
    // heartbeat, and each one is a row lock on a budget two expenses may share.
    expect(decideRearm(budget(), 400, NOW)).toBeNull();
    expect(decideRearm(budget(), 8_500, NOW)).toBeNull();
  });

  it("ignores a sentinel from a previous month", () => {
    // A stale month key already means "not this month" to decideThreshold, so
    // clearing it would be a write with no effect on any decision.
    const b = budget({ lastWarnedMonth: LAST_MONTH, lastAlertedMonth: LAST_MONTH });
    expect(decideRearm(b, 400, NOW)).toBeNull();
  });

  it("does nothing for a zero or negative cap, like decideThreshold", () => {
    // 0/0 is NaN and every comparison against it is false — the two functions
    // have to agree about the degenerate row or one of them writes on it.
    const b = budget({ monthlyLimit: 0, lastAlertedMonth: THIS_MONTH });
    expect(decideRearm(b, 400, NOW)).toBeNull();
  });
});

describe("finance-planning-005 — and the alert really does fire again afterwards", () => {
  /** Apply a re-arm the way `check.ts` does, then ask for the decision. */
  function afterRearm(
    b: ReturnType<typeof budget>,
    monthToDate: number
  ): ReturnType<typeof decideThreshold> {
    const rearm = decideRearm(b, monthToDate, NOW);
    const next = { ...b, ...(rearm ?? {}) };
    return decideThreshold(next, monthToDate, NOW);
  }

  it("alerts again after the typo is deleted and the cap is genuinely blown", () => {
    const fired = budget({ lastWarnedMonth: THIS_MONTH, lastAlertedMonth: THIS_MONTH });
    // Step 1: typo deleted, spend drops to 4%. Sentinels clear, nothing to say.
    const cleared = { ...fired, ...(decideRearm(fired, 400, NOW) ?? {}) };
    expect(decideThreshold(cleared, 400, NOW)).toBeNull();
    // Step 2: the month goes on and the cap is really exceeded.
    const decision = decideThreshold(cleared, 11_000, NOW);
    expect(decision?.kind).toBe("alert");
  });

  it("alerts on a genuine 100% after an earlier over-cap was corrected to 85%", () => {
    const fired = budget({ lastWarnedMonth: THIS_MONTH, lastAlertedMonth: THIS_MONTH });
    const decision = afterRearm(fired, 8_500);
    // Nothing at 85% — they were told.
    expect(decision).toBeNull();
    const rearmed = { ...fired, ...(decideRearm(fired, 8_500, NOW) ?? {}) };
    expect(decideThreshold(rearmed, 10_500, NOW)?.kind).toBe("alert");
  });

  it("still sends exactly one warning per crossing, which is the rule it must not break", () => {
    // The re-arm must not become a way to email twice for one state. At 85% with
    // the warning sentinel set, nothing fires and nothing is cleared.
    const warned = budget({ lastWarnedMonth: THIS_MONTH });
    expect(decideRearm(warned, 8_500, NOW)).toBeNull();
    expect(decideThreshold(warned, 8_500, NOW)).toBeNull();
  });
});

describe("finance-planning-005 — a delete has to reach the check", () => {
  it("deleteTransactionAction re-runs the budget threshold hook", () => {
    // THE WIRING, and the half the finding is actually about: "even after you
    // delete the mistaken expense". A pure re-arm nothing calls on a delete
    // closes nothing — the sentinel would still be sitting there. Asserted on the
    // source because driving the whole action needs a Prisma double and this one
    // fact is what was missing.
    const src = readFileSync(join(process.cwd(), "lib", "actions", "transactions.ts"), "utf8");
    const start = src.indexOf("export async function deleteTransactionAction");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\n}", start));
    expect(
      body,
      "deleteTransactionAction does not call checkBudgetThresholdAfterExpense, so " +
        "deleting the expense that tripped an alert leaves the month's sentinel set " +
        "and the budget silent until the 1st."
    ).toContain("checkBudgetThresholdAfterExpense");
  });

  it("check.ts applies the re-arm before deciding whether to notify", () => {
    const src = readFileSync(join(process.cwd(), "lib", "budgets", "check.ts"), "utf8");
    expect(src).toContain("decideRearm");
    // Before, not after: a re-arm applied afterwards would be judged against the
    // state it was supposed to correct.
    expect(src.indexOf("decideRearm")).toBeLessThan(src.indexOf("decideThreshold("));
  });
});
