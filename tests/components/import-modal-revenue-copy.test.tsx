/**
 * transactions-ledger-002 — the import dialog has to be about the money the
 * page it opened from is about.
 *
 * WHAT WAS WRONG. `ImportTransactionsModal` is rendered by all three ledger
 * clients, and `type` is one of three values — `"expense"`, `"income"`,
 * `"investment"` (expenses-client.tsx, revenue-client.tsx:569,
 * investments-client.tsx). Three of its strings were two-way
 * `type === "expense" ? … : …` ternaries with no income branch, so /revenue fell
 * to the INVESTMENT side of every one of them:
 *
 *   • the dialog title read "Import investments from CSV" on a page titled
 *     Revenue;
 *   • "Download template" handed over a CSV whose category column held
 *     "Seed Capital" and "Loan" — neither of them a REVENUE_CATEGORY, so every
 *     row of the page's OWN template previewed as `Unknown category "…"`, the
 *     valid count was 0 and the Import button stayed disabled;
 *   • the success toast said "Imported 3 investment(s)".
 *
 * Validation itself was already right (`categories` at the top of the component
 * picks REVENUE_CATEGORIES for `"income"`), which is what made this so bad: a
 * customer's own sales export WOULD have imported, but the only guidance the
 * page offered guaranteed failure, and the word on screen while it failed told
 * them their income had been booked as founder capital. Nothing in the product
 * contradicts that reading — a real sale mis-booked as investment inflates the
 * cap table, which is why `type: "income"` and REVENUE_CATEGORIES exist at all
 * (lib/types.ts).
 *
 * THE CONTRACT PINNED HERE, for each of the three types rather than for income
 * alone: the dialog names that type, and the template it offers is a file that
 * type can actually import. The round trip is the point of the template block —
 * asserting the category strings alone would still pass if the template named a
 * category of the right LIST but, say, a future date, and "the template the page
 * gave me doesn't import" is one customer-visible failure however it is reached.
 * So the template is fed back through the modal's own parser.
 *
 * `fireEvent` throughout, no `userEvent`: nothing here is about pointer
 * behaviour, and the real-timer click sequencing is what made an earlier test in
 * this directory flaky.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ImportTransactionsModal } from "@/components/transactions/import-transactions-modal";
import { EXPENSE_CATEGORIES, INVESTMENT_CATEGORIES, REVENUE_CATEGORIES } from "@/lib/types";

type TxnType = "expense" | "income" | "investment";

const bulkImportTransactionsAction = vi.fn();
vi.mock("@/lib/actions/transactions", () => ({
  bulkImportTransactionsAction: (input: unknown) => bulkImportTransactionsAction(input),
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("react-hot-toast", () => ({
  default: Object.assign(vi.fn(), {
    error: (m: string) => toastError(m),
    success: (m: string) => toastSuccess(m),
  }),
}));

// The real formatters, only the store faked — that is where currency and locale
// come from (`useMoney`, `useNumberFormat`).
vi.mock("@/lib/store", () => ({
  useStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ locale: "en", currentCompany: { id: "c1", currency: "PKR" } }),
  useStoreHasHydrated: () => true,
}));

const TYPES: TxnType[] = ["expense", "income", "investment"];

/** What the dialog must be called on each of the three ledger pages. "revenue"
 *  is the mass noun because "Import revenues from CSV" is not English. */
const EXPECTED_TITLE: Record<TxnType, string> = {
  expense: "Import expenses from CSV",
  income: "Import revenue from CSV",
  investment: "Import investments from CSV",
};

/** What lands in the customer's Downloads folder. `income` is the internal type
 *  code; the page is called Revenue and so is its template. */
const EXPECTED_FILENAME: Record<TxnType, string> = {
  expense: "founderflow-expense-template.csv",
  income: "founderflow-revenue-template.csv",
  investment: "founderflow-investment-template.csv",
};

/** The one category list each type accepts — the same choice the component's
 *  own `categories` makes, and therefore what its template must draw from. */
const CATEGORIES: Record<TxnType, string[]> = {
  expense: EXPENSE_CATEGORIES,
  income: REVENUE_CATEGORIES,
  investment: INVESTMENT_CATEGORIES,
};

function mount(type: TxnType) {
  render(
    <ImportTransactionsModal
      type={type}
      projects={[]}
      open
      onClose={vi.fn()}
      onImported={vi.fn()}
    />
  );
}

/** The CSV behind the "Download template" link, decoded from its data: URL. */
function templateCsv(): string {
  const href = screen.getByRole("link", { name: /download template/i }).getAttribute("href") ?? "";
  const comma = href.indexOf(",");
  return decodeURIComponent(href.slice(comma + 1));
}

/** The category cell of every data row of a template CSV. */
function categoryColumn(csv: string): string[] {
  return csv
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => line.split(",")[2]);
}

/**
 * Hand the hidden file input a CSV and wait for the preview table.
 * `fireEvent` rather than `userEvent.upload` because the input is
 * `display: none` — same reason as import-modal-project-tag.test.tsx.
 */
async function loadCsv(text: string): Promise<void> {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, {
    target: { files: [new File([text], "rows.csv", { type: "text/csv" })] },
  });
  await waitFor(() => expect(screen.getByRole("table")).toBeInTheDocument());
}

/** Every refusal reason the preview is showing, joined for substring checks. */
function previewErrors(): string {
  return screen
    .getAllByRole("row")
    .slice(1)
    .map((r) => r.querySelectorAll("td")[3]?.textContent ?? "")
    .join(" | ");
}

beforeEach(() => {
  bulkImportTransactionsAction.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
});

describe("ImportTransactionsModal — the dialog names the money it imports", () => {
  it.each(TYPES)("titles the %s dialog for that ledger", (type) => {
    mount(type);
    expect(
      screen.getByRole("heading", { name: EXPECTED_TITLE[type] }),
      `the dialog on this ledger must not be titled for another kind of money`
    ).toBeInTheDocument();
  });

  it("never says 'investment' on a revenue import", () => {
    mount("income");
    // The word is the whole of the IMPACT: on a page called Revenue it reads as
    // a statement that the customer's sales have been booked as founder capital.
    expect(document.body.textContent ?? "").not.toMatch(/investment/i);
  });

  it.each(TYPES)("names the %s template after that ledger", (type) => {
    mount(type);
    expect(screen.getByRole("link", { name: /download template/i })).toHaveAttribute(
      "download",
      EXPECTED_FILENAME[type]
    );
  });
});

describe("ImportTransactionsModal — the template the page offers is importable", () => {
  it.each(TYPES)("draws the %s template's categories from that type's own list", (type) => {
    mount(type);
    const cats = categoryColumn(templateCsv());
    expect(cats.length, "a template with no rows teaches nothing").toBeGreaterThan(0);
    for (const c of cats) {
      expect(
        CATEGORIES[type],
        `the template offers "${c}", which this ledger refuses — every row of it ` +
          `previews as an unknown category and the Import button stays disabled`
      ).toContain(c);
    }
  });

  it.each(TYPES)("imports its own %s template end to end", async (type) => {
    mount(type);
    const csv = templateCsv();
    const expectedRows = csv.trim().split("\n").length - 1;

    await loadCsv(csv);

    expect(
      previewErrors(),
      "the page's own template was refused by the page's own importer"
    ).not.toMatch(/unknown category/i);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: new RegExp(`^Import ${expectedRows}$`) })
      ).toBeEnabled()
    );
  });
});

describe("ImportTransactionsModal — the success toast counts the right noun", () => {
  /** Three valid rows of `type`, using that type's first category. */
  function threeRows(type: TxnType): string {
    const cat = CATEGORIES[type][0];
    return (
      "date,amount,category,description\n" +
      `2026-06-01,1000,${cat},One\n` +
      `2026-06-02,2000,${cat},Two\n` +
      `2026-06-03,3000,${cat},Three\n`
    );
  }

  async function importRows(
    type: TxnType,
    csv: string,
    imported: number,
    skipped = 0
  ): Promise<void> {
    bulkImportTransactionsAction.mockResolvedValue({
      success: true,
      data: { imported, skipped, duplicates: [] },
    });
    mount(type);
    await loadCsv(csv);
    const rows = csv.trim().split("\n").length - 1;
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`^Import ${rows}$`) }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
  }

  it("says 'revenue entries' after a revenue import", async () => {
    await importRows("income", threeRows("income"), 3);
    expect(toastSuccess).toHaveBeenCalledWith("Imported 3 revenue entries");
  });

  it("says 'revenue entry' for a single row", async () => {
    const csv = "date,amount,category,description\n2026-06-01,1000,Product Sales,One\n";
    await importRows("income", csv, 1);
    expect(toastSuccess).toHaveBeenCalledWith("Imported 1 revenue entry");
  });

  it("still says 'expenses' after an expense import", async () => {
    await importRows("expense", threeRows("expense"), 3);
    expect(toastSuccess).toHaveBeenCalledWith("Imported 3 expenses");
  });

  it("still says 'investments' after an investment import", async () => {
    await importRows("investment", threeRows("investment"), 3);
    expect(toastSuccess).toHaveBeenCalledWith("Imported 3 investments");
  });

  it("names the noun on the partial-import toast too", async () => {
    // The other branch of the same toast. It named no noun at all before, which
    // was not wrong — but leaving it bare while the clean branch says "revenue
    // entries" is the half-fix this audit keeps finding.
    await importRows("income", threeRows("income"), 2, 1);
    expect(toastSuccess).toHaveBeenCalledWith(
      "Imported 2 revenue entries — skipped 1 invalid row(s)"
    );
  });
});
