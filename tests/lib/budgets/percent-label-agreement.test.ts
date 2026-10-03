// @vitest-environment node

/**
 * R5-money-014-bell — the bell and the budget card must quote the SAME
 * percentage for the same budget.
 *
 * WHERE THIS COMES FROM. money-014 was "one number, two meanings": the card's
 * headline was `Math.round(pct * 100)` while the badge beside it read the
 * unrounded ratio, so a budget at 99.6% of its cap printed "100%" next to
 * "Warning" and a budget at 100.4% printed "100%" next to "Over". The card was
 * fixed by clamping the rounded integer into the band its own badge names
 * (tests/app/budgets/budget-percent-label.test.tsx pins it: 0.996 → "99%").
 *
 * THE HALF THAT WAS LEFT. `lib/budgets/check.ts` writes the threshold
 * notification, and it had its own copy of the arithmetic —
 * `Math.round(decision.percentUsed * 100)` — straight into the title and the
 * message of a `warning` row. The warning band is `0.8 ≤ pct < 1` by
 * definition (`WARN_PCT`/`ALERT_PCT`), so at 99.6% the bell said "at 100% of the
 * cap" while the page said 99%: the same two meanings of "100%", now split
 * across two surfaces, with the reader unable to tell which one had crossed the
 * line. And a Notification row is written once and read forever — no later code
 * change repairs the history, which is the same argument the currency label in
 * that file already carries (money-006).
 *
 * SO THE CONTRACT IS CROSS-SURFACE, and the expected strings below are
 * hard-coded rather than derived from the helper: a test that asks the shipped
 * formatter what it thinks 99.6% is would pass against either number.
 *
 * No database — the Prisma client is a fake, and `captureServerError` is
 * captured too, because `checkBudgetThresholdAfterExpense` swallows every throw
 * by design. Without that assertion a broken fake looks exactly like "no
 * notification was sent".
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { budgetPercentLabel } from "@/lib/budgets/threshold";

/* ───────────────────────────── the doubles ──────────────────────────────── */

type Notified = { title: string; message: string; tone: string };

const H = vi.hoisted(() => ({
  /** Prisma.Decimal stand-in: only `toNumber()` is ever called on these. */
  monthlyLimit: 0,
  monthToDate: 0,
  sentinels: { lastWarnedMonth: null as string | null, lastAlertedMonth: null as string | null },
  notified: [] as Array<{ title: string; message: string; tone: string }>,
  errors: [] as unknown[],
}));

vi.mock("@/lib/db", () => {
  const dec = (n: number) => ({ toNumber: () => n });
  const client: Record<string, unknown> = {
    budget: {
      findFirst: async () => ({
        id: "b-marketing",
        companyId: "c-1",
        projectId: "p-alpha",
        category: "Marketing",
        active: true,
        monthlyLimit: dec(H.monthlyLimit),
        lastWarnedMonth: H.sentinels.lastWarnedMonth,
        lastAlertedMonth: H.sentinels.lastAlertedMonth,
      }),
      updateMany: async () => ({ count: 1 }),
    },
    transaction: {
      aggregate: async () => ({ _sum: { amount: dec(H.monthToDate) } }),
    },
    project: {
      findUnique: async () => ({ id: "p-alpha", name: "Alpha", supervisorId: "u-sup" }),
    },
    company: {
      findUnique: async () => ({ currency: "PKR" }),
    },
    task: {
      findMany: async () => [{ assignedTo: "u-sup" }],
    },
    user: {
      findMany: async () => [{ id: "u-sup", role: "admin" }],
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(client),
  };
  return { db: client };
});

vi.mock("@/lib/notify/fan-out", () => ({
  notifyUsers: async (input: { title: string; message: string; tone: string }) => {
    H.notified.push({ title: input.title, message: input.message, tone: input.tone });
    return { notified: 1, dispatched: 1 };
  },
}));

vi.mock("@/lib/sentry-server", () => ({
  captureServerError: (err: unknown) => {
    H.errors.push(err);
  },
}));

import { checkBudgetThresholdAfterExpense } from "@/lib/budgets/check";

/* ─────────────────────────────── helpers ────────────────────────────────── */

/**
 * Post an expense against a 50,000 cap that lands the month at `ratio` of it,
 * and return the single notification the bell receives.
 */
async function bellFor(ratio: number): Promise<Notified> {
  H.monthlyLimit = 50_000;
  H.monthToDate = 50_000 * ratio;
  await checkBudgetThresholdAfterExpense({
    companyId: "c-1",
    projectId: "p-alpha",
    category: "Marketing",
  });
  expect(H.errors, "checkBudgetThresholdAfterExpense threw and swallowed it").toEqual([]);
  expect(H.notified).toHaveLength(1);
  return H.notified[0];
}

beforeEach(() => {
  H.notified = [];
  H.errors = [];
  H.sentinels = { lastWarnedMonth: null, lastAlertedMonth: null };
});

/* ──────────────────────────────── the tests ─────────────────────────────── */

describe("the warning notification quotes the number the card shows", () => {
  it("does not tell the bell '100%' about a budget the page calls 99%", async () => {
    // 49,800 of 50,000. The card renders "99%" beside a "Warning" badge; the
    // notification is the SAME threshold crossing and must not round it onto
    // the cap the alert — and only the alert — is allowed to claim.
    const bell = await bellFor(0.996);
    expect(bell.tone).toBe("warning");
    expect(bell.title).toContain("99%");
    expect(bell.title).not.toContain("100%");
    expect(bell.message).toContain("at 99% of the PKR 50,000 monthly cap");
    expect(bell.message).not.toContain("100%");
  });

  it("still quotes an ordinary mid-band figure unchanged", async () => {
    const bell = await bellFor(0.853);
    expect(bell.title).toContain("85%");
    expect(bell.message).toContain("at 85% of the PKR 50,000 monthly cap");
  });

  it("says 80% at exactly the warning line, the documented heads-up point", async () => {
    const bell = await bellFor(0.8);
    expect(bell.title).toContain("80%");
  });
});

describe("budgetPercentLabel — one formatter for every surface", () => {
  // The same table the card test walks, so the two cannot drift: the integer
  // has to fall inside the band its own threshold names.
  it.each([
    [0, 0],
    [0.5, 50],
    [0.29, 29], // 0.29 * 100 is 28.999999999999996 — a floor would print 28
    [0.799, 79], // would round up onto the warning line
    [0.8, 80],
    [0.853, 85],
    [0.996, 99], // would round up onto the cap
    [1, 100],
    [1.004, 100],
    [1.25, 125], // over the cap is NOT clamped — the overrun is the news
  ])("%f of the cap labels as %i%%", (ratio, label) => {
    expect(budgetPercentLabel(ratio)).toBe(label);
  });
});

describe("both surfaces actually call it", () => {
  // A shared formatter adopted by one of its two callers is exactly the drift
  // it was written to prevent — the argument lib/finance/runway.ts makes about
  // the runway figures, and the reason money-014 came back as this finding.
  it.each([
    ["lib/budgets/check.ts", ["lib", "budgets", "check.ts"]],
    ["app/(app)/budgets/budgets-client.tsx", ["app", "(app)", "budgets", "budgets-client.tsx"]],
  ])("%s formats its percentage through budgetPercentLabel", (_label, segments) => {
    const src = readFileSync(join(process.cwd(), ...segments), "utf8");
    // Booleans, not `toContain` on the whole file: a string assertion here
    // prints the entire source as its diff and buries every other failure.
    expect(src.includes("budgetPercentLabel"), "does not call budgetPercentLabel").toBe(true);
    // No second copy of the arithmetic left behind beside it.
    expect(
      /Math\.round\([^)]*\*\s*100\)/.test(src),
      "still rounds a ratio into a percentage of its own"
    ).toBe(false);
  });
});
