/**
 * money-014 — the headline percentage on a budget card may never claim a
 * threshold the badge beside it has not reached.
 *
 * THE BUG. `pctLabel` was `Math.round(pct * 100)` while `isOver` (`pct >= 1`)
 * and `isWarning` (`pct >= 0.8 && pct < 1`) read the unrounded ratio. A budget
 * at 99.6% of its cap therefore rendered the headline "100%" next to a
 * "Warning" badge and a non-danger bar, and a budget at 100.4% rendered the
 * same "100%" next to "Over" — one number, two meanings, on the one figure the
 * page exists to show. The same rounding crossed the 80% line the other way:
 * 79.9% printed "80%" beside "On track", the page's documented heads-up point.
 *
 * WHICH SIDE GIVES. The badge is right and the number is wrong. `isOver` /
 * `isWarning` are the same predicates the server's notification uses
 * (`ALERT_PCT` / `WARN_PCT` in lib/budgets/threshold.ts, both against the raw
 * ratio), so rounding the STATE up to "Over" at 99.6% would have made the card
 * contradict the alert instead of itself — the money-004 failure mode, where
 * the page screamed and the notification stayed silent.
 *
 * WHY THE LABEL IS STILL ROUNDED, AND ONLY CLAMPED. Flooring instead would fix
 * the boundary and break the middle: `0.29 * 100` is `28.999999999999996` in
 * IEEE-754, so `Math.floor` renders 2,900 spent of a 10,000 cap as "28%". The
 * case below pins that.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { BudgetsClient } from "@/app/(app)/budgets/budgets-client";
import type { BudgetWithSpend } from "@/lib/queries/budgets";

/* ───────────────────────────── module mocks ─────────────────────────────── */

vi.mock("@/lib/actions/budgets", () => ({
  createBudgetAction: vi.fn(async () => ({ success: true, data: { id: "b-new" } })),
  updateBudgetAction: vi.fn(async () => ({ success: true, data: undefined })),
  deleteBudgetAction: vi.fn(async () => ({ success: true, data: undefined })),
}));

vi.mock("react-hot-toast", () => ({
  default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));

vi.mock("@/components/ui/confirm-dialog", () => ({
  useConfirm: () => async () => true,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

// useMoney / useNumberFormat read the workspace currency and locale from the
// store. Pinned to en/PKR so the formatted percentage is "99%" and not some
// other locale's spelling of it.
vi.mock("@/lib/store", () => ({
  useStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ locale: "en", currentCompany: { id: "c-1", currency: "PKR" } }),
  useStoreHasHydrated: () => true,
}));

/* ────────────────────────────── fixtures ────────────────────────────────── */

const PROJECTS = [{ id: "p-alpha", name: "Alpha" }];

function budgetAt(percentUsed: number): BudgetWithSpend {
  const monthlyLimit = 50000;
  return {
    id: "b-1",
    companyId: "c-1",
    projectId: "p-alpha",
    projectName: "Alpha",
    category: "Marketing",
    monthlyLimit,
    createdBy: "u-1",
    createdByName: "Ayesha Raza",
    active: true,
    lastWarnedMonth: null,
    lastAlertedMonth: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    monthToDateSpend: monthlyLimit * percentUsed,
    percentUsed,
  };
}

type CardReading = { headline: string; badge: string; announced: string };

/**
 * The card as a reader — and a screen reader — actually receives it. One render
 * per call, so call it once per test: cleanup only runs between tests.
 */
function readCard(percentUsed: number): CardReading {
  render(<BudgetsClient budgets={[budgetAt(percentUsed)]} projects={PROJECTS} />);
  const card = screen.getByRole("article");
  const headline = within(card).getByText(/^[\d,]+%$/).textContent ?? "";
  const badge =
    ["Over", "Warning", "On track"].find((word) => within(card).queryByText(word) !== null) ?? "";
  return {
    headline,
    badge,
    announced: within(card).getByRole("progressbar").getAttribute("aria-label") ?? "",
  };
}

/* ─────────────────────────────── the tests ──────────────────────────────── */

describe("Budget card — the percentage and the badge tell the same story", () => {
  it("under the cap but within half a point of it reads 99%, not 100%", () => {
    const { headline, badge } = readCard(0.996);
    expect({ headline, badge }).toEqual({ headline: "99%", badge: "Warning" });
  });

  it("at the cap reads 100%, and only then", () => {
    expect(readCard(1)).toMatchObject({ headline: "100%", badge: "Over" });
  });

  it("tells a screen reader the same number it shows on screen", () => {
    const { headline, announced } = readCard(0.996);
    expect(headline).toBe("99%");
    // The label also names the owning project (R3-money-018-cards) — two
    // per-project caps on one category are otherwise announced identically.
    expect(announced).toMatch(/^Marketing budget in Alpha: 99% of /);
  });

  it("does not under-report a plain ratio to get there (2,900 of 10,000 is 29%)", () => {
    // 0.29 * 100 === 28.999999999999996, so a bare Math.floor would print 28%.
    expect(readCard(0.29).headline).toBe("29%");
  });

  // The whole contract in one place: the badge word names a band, and the
  // integer on the card has to fall inside the band it is sitting next to.
  it.each([
    [0, "0%", "On track"],
    [0.5, "50%", "On track"],
    [0.799, "79%", "On track"], // would round up to the warning line
    [0.8, "80%", "Warning"],
    [0.853, "85%", "Warning"],
    [0.996, "99%", "Warning"], // would round up to the cap
    [1, "100%", "Over"],
    [1.004, "100%", "Over"],
    [1.25, "125%", "Over"],
  ])("%f of the cap renders %s beside '%s'", (percentUsed, headline, badge) => {
    expect(readCard(percentUsed)).toMatchObject({ headline, badge });
  });
});
