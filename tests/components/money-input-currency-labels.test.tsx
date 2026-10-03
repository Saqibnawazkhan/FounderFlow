// @vitest-environment jsdom
/**
 * money-011 — a money INPUT must ask for the currency the workspace keeps its
 * books in.
 *
 * WHAT WENT WRONG. Three amount fields carried the currency as a literal:
 * `components/transactions/transaction-form.tsx` ("Amount (PKR)" plus a "PKR"
 * affix rendered inside the input), `app/(app)/budgets/budgets-client.tsx`
 * ("Monthly cap (PKR)") and `app/(app)/recurring/recurring-client.tsx`
 * ("Amount (PKR)"). `Company.currency` has six legal values
 * (lib/schemas/company.ts), and every figure those same screens RENDER goes
 * through `useMoney()` — so a USD workspace asked for rupees in the input and
 * answered in dollars one row below it, on the most-used form in the product.
 *
 * Nothing converts: the number typed is the number stored. So the only failure
 * mode is the expensive one — a founder who believes the label and converts in
 * their head before typing, putting an amount into the ledger that is wrong by
 * the exchange rate (~280x between the default and USD).
 *
 * THE CONTRACT, both ways round. The label must follow the workspace currency,
 * which means a PKR workspace must still read "PKR": replacing one hardcoded
 * code with another would pass a USD-only test and ship the same defect to
 * every other workspace.
 *
 * WHERE THE CURRENCY COMES FROM. `useCurrency()` with no argument, which is the
 * same source the sibling figures on each of these three screens already use
 * (`useMoney()` in BudgetCard, RuleCard and the expense/revenue/investment
 * tables). Reading the same store is the point — a label that disagreed with the
 * figure beside it would be this bug again in a new place. None of the three
 * forms is handed a server-fetched `company` row to prefer over it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useStore } from "@/lib/store";

/* ───────────────────────────── module mocks ─────────────────────────────── */
// Nothing here submits anything; the actions are stubbed only so the client
// components can be imported without reaching a server module.

vi.mock("react-hot-toast", () => ({
  default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/components/ui/confirm-dialog", () => ({
  useConfirm: () => async () => true,
}));

vi.mock("@/lib/actions/transactions", () => ({
  addTransactionAction: vi.fn(async () => ({ success: true })),
  updateTransactionAction: vi.fn(async () => ({ success: true })),
}));

vi.mock("@/lib/actions/budgets", () => ({
  createBudgetAction: vi.fn(async () => ({ success: true, data: { id: "b-new" } })),
  updateBudgetAction: vi.fn(async () => ({ success: true, data: undefined })),
  deleteBudgetAction: vi.fn(async () => ({ success: true, data: undefined })),
}));

vi.mock("@/lib/actions/recurring", () => ({
  createRecurringRuleAction: vi.fn(async () => ({ success: true, data: { id: "r-new" } })),
  deleteRecurringRuleAction: vi.fn(async () => ({ success: true, data: undefined })),
  toggleRecurringRuleAction: vi.fn(async () => ({ success: true, data: undefined })),
}));

import { TransactionForm } from "@/components/transactions/transaction-form";
import { BudgetsClient } from "@/app/(app)/budgets/budgets-client";
import { RecurringClient } from "@/app/(app)/recurring/recurring-client";

/* ───────────────────────────── store fixture ────────────────────────────── */

function workspaceCurrency(currency: string) {
  useStore.setState({ currentCompany: { name: "Nimbus Labs", industry: "SaaS", currency } });
}

beforeEach(() => {
  useStore.setState({ currentCompany: null });
});

afterEach(() => {
  useStore.setState({ currentCompany: null });
});

/* ──────────────────────────────── the tests ─────────────────────────────── */

describe("the expense/revenue/investment form (components/transactions/transaction-form.tsx)", () => {
  it("asks for the workspace currency in both the label and the in-input affix", () => {
    workspaceCurrency("USD");
    render(<TransactionForm type="expense" onClose={vi.fn()} />);

    expect(screen.getByLabelText("Amount (USD)")).toBeInTheDocument();
    // The affix is its own element whose entire text is the code, so an exact
    // match here cannot be satisfied by the label above.
    expect(screen.getByText("USD")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("PKR");
  });

  it("still reads PKR in a PKR workspace", () => {
    workspaceCurrency("PKR");
    render(<TransactionForm type="expense" onClose={vi.fn()} />);

    expect(screen.getByLabelText("Amount (PKR)")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("USD");
  });

  it("follows the currency on the correction path too", () => {
    // money-016's edit mode shares this field; a label that only tracked the
    // currency when creating would mislabel every correction.
    workspaceCurrency("AED");
    render(
      <TransactionForm
        type="expense"
        editing={{
          id: "t-1",
          companyId: "c-1",
          type: "expense",
          amount: 1234.5,
          category: "Salaries",
          description: "September payroll",
          date: "2026-09-15T00:00:00.000Z",
          addedBy: "u-1",
          addedByName: "Ayesha Raza",
          createdAt: "2026-09-15T00:00:00.000Z",
        }}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByLabelText("Amount (AED)")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("PKR");
  });
});

describe("the New budget form (app/(app)/budgets/budgets-client.tsx)", () => {
  it("asks for the monthly cap in the workspace currency", async () => {
    workspaceCurrency("EUR");
    const user = userEvent.setup();
    render(<BudgetsClient budgets={[]} projects={[{ id: "p-alpha", name: "Alpha" }]} />);

    // With no budgets yet the header and the empty state both offer the button.
    await user.click(screen.getAllByRole("button", { name: /New budget/i })[0]);

    expect(await screen.findByLabelText("Monthly cap (EUR)")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("PKR");
  });
});

describe("the New recurring rule form (app/(app)/recurring/recurring-client.tsx)", () => {
  it("asks for the amount in the workspace currency", async () => {
    workspaceCurrency("GBP");
    const user = userEvent.setup();
    render(<RecurringClient rules={[]} currentUserId="u-1" currentUserRole="admin" />);

    await user.click(screen.getByRole("button", { name: /^New rule$/i }));

    expect(await screen.findByLabelText("Amount (GBP)")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("PKR");
  });
});
