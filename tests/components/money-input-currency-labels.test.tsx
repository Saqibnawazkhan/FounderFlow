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
 * WHERE THE CURRENCY COMES FROM. For the budget and the recurring-rule forms,
 * `useCurrency()` with no argument — the same source the sibling figures on those
 * two screens already use (`useMoney()` in BudgetCard and RuleCard). Reading the
 * same store is the point: a label that disagreed with the figure beside it would
 * be this bug again in a new place.
 *
 * TransactionForm is the one of the three that is handed the row instead
 * (transactions-ledger-006, the last two describes below). /expenses, /revenue
 * and /investments each fetch `Company.currency` in their Server Component and
 * pass it down, because the store's copy arrives over a two-hop async chain
 * (providers.tsx hydrates the session, THEN company-hydrator.tsx calls
 * `getMyCompanyAction`) and is simply ABSENT until both land — on the first load
 * after signup, on a new device, after clearing site data and after /settings'
 * "Reset local preferences". Store-only, this label therefore still read
 * "Amount (PKR)" in a USD workspace at exactly the moment described above: the
 * moment a founder types a number. The sibling figures on those three screens now
 * take the same server value, so the two still cannot disagree.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
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

/* ───── transactions-ledger-006: the label on the FIRST PAINT, not just later ───── */

describe("the expense/revenue/investment form before the store has hydrated", () => {
  // Every case here runs in the state the `beforeEach` above installs and the
  // rest of this file steps over: `currentCompany === null`. That is not an edge
  // case, it is the state of every browser that has just signed in — and it is
  // the state the filing's own headline sentence is about ("the expense form
  // still asks for 'Amount (PKR)'"). The window closes only when a server-action
  // round-trip returns, so it is wide enough to type a number in.

  it("names the currency the Server Component fetched, with the store still empty", () => {
    render(<TransactionForm type="expense" serverCurrency="USD" onClose={vi.fn()} />);

    expect(screen.getByLabelText("Amount (USD)")).toBeInTheDocument();
    // The affix is its own element whose entire text is the code.
    expect(screen.getByText("USD")).toBeInTheDocument();
    expect(
      document.body.textContent,
      "a USD workspace must never be shown a rupee label, least of all on the " +
        "first load after signup when the store knows nothing yet"
    ).not.toContain("PKR");
  });

  it("prefers the server row over a persisted store that disagrees with it", () => {
    // `currentCompany` lives in the persisted `founderflow-storage` slice, so a
    // browser can hold the currency of a workspace it signed out of. The prop was
    // fetched for THIS request; the store's copy was not. See lib/hooks/useMoney.ts.
    workspaceCurrency("PKR");
    render(<TransactionForm type="expense" serverCurrency="AED" onClose={vi.fn()} />);

    expect(screen.getByLabelText("Amount (AED)")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("PKR");
  });

  it("falls back to PKR only when NEITHER source knows the currency", () => {
    // The documented last resort (`stored ?? "PKR"`), pinned so a later change to
    // the hook cannot turn an unknown currency into "Amount ()" or
    // "Amount (undefined)" on the most-used form in the product.
    render(<TransactionForm type="expense" onClose={vi.fn()} />);

    expect(screen.getByLabelText("Amount (PKR)")).toBeInTheDocument();
  });
});

describe("no amount-entry surface is left reading the store alone (structural)", () => {
  // The three cases above prove the component honours the prop. This proves every
  // place that RENDERS it supplies one — the half that a component test cannot
  // see, and the half that was actually broken: money-011 replaced the hardcoded
  // "(PKR)" with `useCurrency()` and left all four call sites passing nothing.
  //
  // `serverCurrency` stays OPTIONAL on the component (lib/hooks/useMoney.ts is
  // explicitly precedence-with-fallback, so a surface with no company row still
  // works), which is exactly why this sweep exists rather than a required prop.
  // The page → client half IS a required prop: `currency: string` on
  // ExpensesClient / RevenueClient / InvestmentsClient, so `npm run typecheck`
  // fails if a finance page stops fetching the row.
  //
  // Scoped to the amount-ENTRY surfaces. The same first-paint window still
  // affects the read-only figures on /dashboard, /budgets, /recurring,
  // /projects/[id], /team and the CSV import preview, which remain store-only;
  // that is rep-011's open remainder (tests/app/reports/reports-currency-first-paint.test.tsx
  // is its pin for /reports, the one surface it has closed).

  const ROOT = process.cwd();

  function tsxFiles(dir: string): string[] {
    const found: string[] = [];
    const entries = readdirSync(dir);
    for (let i = 0; i < entries.length; i++) {
      const full = join(dir, entries[i]);
      if (statSync(full).isDirectory()) {
        const inner = tsxFiles(full);
        for (let j = 0; j < inner.length; j++) found.push(inner[j]);
      } else if (entries[i].endsWith(".tsx")) {
        found.push(full);
      }
    }
    return found;
  }

  /** Every `<TransactionForm … />` element in the app, as source text. */
  function renderSites(): { file: string; jsx: string }[] {
    const sites: { file: string; jsx: string }[] = [];
    const files = tsxFiles(join(ROOT, "app")).concat(tsxFiles(join(ROOT, "components")));
    for (let i = 0; i < files.length; i++) {
      const source = readFileSync(files[i], "utf8");
      let at = source.indexOf("<TransactionForm");
      while (at !== -1) {
        // Only an element that OPENS its line, so prose that happens to name the
        // tag is not counted — expenses-client.tsx:20 explains the edit modal in
        // a `//` comment that contains "<TransactionForm".
        const lineStart = source.lastIndexOf("\n", at) + 1;
        if (source.slice(lineStart, at).trim() === "") {
          // Every call site is self-closing, so the element's props end at the
          // first "/>" after the tag name.
          const end = source.indexOf("/>", at);
          sites.push({
            file: relative(ROOT, files[i]),
            jsx: source.slice(at, end === -1 ? source.length : end),
          });
        }
        at = source.indexOf("<TransactionForm", at + 1);
      }
    }
    return sites;
  }

  it("finds the call sites at all, or the assertion below proves nothing", () => {
    // Two per finance screen: the "add" modal and money-016's "edit" modal.
    expect(renderSites().length).toBe(6);
  });

  it("passes serverCurrency at every <TransactionForm /> site", () => {
    const sites = renderSites();
    for (let i = 0; i < sites.length; i++) {
      expect(
        sites[i].jsx,
        `${sites[i].file} renders <TransactionForm> without a serverCurrency prop, so ` +
          "that form asks for rupees until CompanyHydrator's round-trip lands. Pass the " +
          "currency the page's Server Component fetched (see app/(app)/expenses/page.tsx)."
      ).toContain("serverCurrency=");
    }
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
    // `projects` is the money-005 picker's option list; empty is a legal state
    // (a workspace with no projects renders no picker) and nothing here is about
    // the tag — tests/app/recurring/new-rule-project-tag.test.tsx owns that.
    render(
      <RecurringClient rules={[]} currentUserId="u-1" currentUserRole="admin" projects={[]} />
    );

    await user.click(screen.getByRole("button", { name: /^New rule$/i }));

    expect(await screen.findByLabelText("Amount (GBP)")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("PKR");
  });
});
