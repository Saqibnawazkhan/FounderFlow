// @vitest-environment jsdom
/**
 * finance-planning-013, at the surface: /recurring must say that a charge has
 * stopped, and offer the off switch to someone who can use it.
 *
 * The nightly materializer now SUSPENDS a rule whose author has been
 * deactivated (tests/lib/cron/materialize-route.test.ts). Two things have to be
 * true on the card for that to be an improvement rather than a new silence:
 *
 *   1. It must SAY SO. A rule that posts nothing while rendering exactly like
 *      one that posts every month moves the surprise into the customer's books,
 *      which is the only other place the change shows up.
 *   2. The controls must be THERE. `canManage` mirrored the server's
 *      creator-or-admin rule, and after `removeUserAction` the creator can never
 *      sign in again — so a co-founder saw a standing charge with no Pause and
 *      no Delete. Both layers now ask `canManageRecurringRule`.
 *
 * NO TIMERS AND NO CLICKS. These are static renders: nothing here submits, so
 * there is no chunk load to race (the flake the previous tranche spent 22
 * seconds on). The server actions are stubbed only so the client component can
 * be imported without reaching a server module.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("react-hot-toast", () => ({
  default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/components/ui/confirm-dialog", () => ({
  useConfirm: () => async () => true,
}));

vi.mock("@/lib/actions/recurring", () => ({
  createRecurringRuleAction: vi.fn(async () => ({ success: true, data: { ruleId: "r-new" } })),
  deleteRecurringRuleAction: vi.fn(async () => ({ success: true, data: undefined })),
  toggleRecurringRuleAction: vi.fn(async () => ({ success: true, data: undefined })),
}));

import { RecurringClient } from "@/app/(app)/recurring/recurring-client";
import type { RecurringRuleClient } from "@/lib/queries/recurring";

/** A monthly salary rule set up by a teammate who has since been removed. */
function salaryRule(over: Partial<RecurringRuleClient> = {}): RecurringRuleClient {
  return {
    id: "r1",
    companyId: "c1",
    type: "expense",
    amount: 250000,
    category: "Salaries",
    description: "Ops lead salary",
    addedBy: "u-gone",
    addedByName: "Hira Siddiqui",
    frequency: "monthly",
    dayOfMonth: 1,
    dayOfWeek: null,
    active: true,
    startDate: "2026-01-01T00:00:00.000Z",
    lastMaterializedAt: "2026-09-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    materializedCount: 9,
    authorRemoved: true,
    ...over,
  };
}

/**
 * 3 October 2026. A fixed instant rather than `Date.now()` because the card now
 * renders a next-due date off this clock (finance-planning-020), and a test
 * whose "today" moves is a test that reads differently every day it runs. The
 * cases below do not assert on that line — tests/components/recurring-next-due
 * .test.tsx owns it — they only need it to be deterministic.
 */
const OCT_3 = Date.UTC(2026, 9, 3, 14, 30);

function renderAsCofounder(rule: RecurringRuleClient) {
  return render(
    <RecurringClient
      rules={[rule]}
      currentUserId="u-cofounder"
      currentUserRole="cofounder"
      projects={[]}
      serverNowMs={OCT_3}
    />
  );
}

describe("a rule whose author was deactivated", () => {
  it("says on the card that it has stopped posting", () => {
    renderAsCofounder(salaryRule());

    expect(screen.getByText(/author removed/i)).toBeInTheDocument();
    // Not just a label: the consequence has to be legible, because "removed"
    // alone does not tell a founder whether the money is still going out.
    expect(document.body.textContent).toMatch(/stopped posting/i);
  });

  it("offers Pause and Delete to a co-founder who did not create it", () => {
    renderAsCofounder(salaryRule());

    expect(screen.getByRole("button", { name: /pause/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /delete rule for Salaries/i })).toBeInTheDocument();
  });
});

describe("a rule whose author is still at the company", () => {
  it("shows no suspension notice", () => {
    renderAsCofounder(salaryRule({ authorRemoved: false }));

    expect(screen.queryByText(/author removed/i)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/stopped posting/i);
  });

  it("still hides Pause and Delete from a co-founder who did not create it", () => {
    // The unchanged contract, and the half a careless widening would lose.
    renderAsCofounder(salaryRule({ authorRemoved: false }));

    expect(screen.queryByRole("button", { name: /pause/i })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /delete rule for Salaries/i })
    ).not.toBeInTheDocument();
  });

  it("still shows them to the person who created it", () => {
    render(
      <RecurringClient
        rules={[salaryRule({ authorRemoved: false, addedBy: "u-cofounder" })]}
        currentUserId="u-cofounder"
        currentUserRole="cofounder"
        projects={[]}
        serverNowMs={OCT_3}
      />
    );

    expect(screen.getByRole("button", { name: /pause/i })).toBeInTheDocument();
  });
});
