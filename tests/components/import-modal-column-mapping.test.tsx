/**
 * transactions-ledger-014 — the importer must not read money out of the wrong
 * column, and must say which columns it read.
 *
 * WHAT WAS WRONG. Column detection was a substring scan in header order
 * (`findColumn`, lib/transactions/csv.ts), with no preference for a header that
 * is actually named what we are looking for and no report of what it chose:
 *
 *     date,subtotal,amount,category,description
 *                              ↑ the amount candidates include "total", and
 *                                "subtotal" comes first → the SUBTOTAL imported
 *
 *     date,amount,allocation,category
 *                    ↑ the category candidates include "cat", and "allocation"
 *                      comes first → the ALLOCATION cell imported as the
 *                      category, and an allocation cell often holds a real
 *                      category name, so the row validated
 *
 * Both files have the right column, correctly named, one place to the right. The
 * preview rendered the wrong column's values with no error of any kind, and
 * nothing anywhere named the columns it had picked — so the only way to catch it
 * was to know the subtotal by heart.
 *
 * THE CONTRACT PINNED HERE is the finding's own, in both halves:
 *   1. a header that IS the name beats a header that merely contains it, in the
 *      preview AND in what is sent to the server;
 *   2. the mapping is on screen, says which column it chose, and the customer
 *      can re-point it before committing — including the genuinely ambiguous
 *      file where no header is named "amount" at all.
 *
 * WHY A COMPONENT TEST and not only tests/lib/transactions/column-detection.test.ts:
 * that file pins the ranking, which cannot see the preview, the payload, or
 * whether the chosen mapping is reachable. "Shipped, tested, unreachable" is
 * this repo's most documented recurrent defect, and a detector nobody can
 * correct is exactly that shape.
 */

import { useState } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ImportTransactionsModal } from "@/components/transactions/import-transactions-modal";

const bulkImportTransactionsAction = vi.fn();
vi.mock("@/lib/actions/transactions", () => ({
  bulkImportTransactionsAction: (input: unknown) => bulkImportTransactionsAction(input),
}));

vi.mock("react-hot-toast", () => ({
  default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));

vi.mock("@/lib/store", () => ({
  useStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ locale: "en", currentCompany: { id: "c1", currency: "PKR" } }),
  useStoreHasHydrated: () => true,
}));

function Harness() {
  const [open, setOpen] = useState(true);
  return (
    <ImportTransactionsModal
      type="expense"
      projects={[]}
      open={open}
      onClose={() => setOpen(false)}
      onImported={() => setOpen(false)}
    />
  );
}

/** Hand the hidden file input a CSV — `fireEvent` because it is `display: none`,
 *  the same reason import-modal-date-locale.test.tsx does it this way. */
async function loadCsv(text: string): Promise<void> {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, {
    target: { files: [new File([text], "rows.csv", { type: "text/csv" })] },
  });
  await waitFor(() => expect(screen.getByRole("table")).toBeInTheDocument());
}

function previewCells(column: number): string[] {
  return screen
    .getAllByRole("row")
    .slice(1) // drop the header row
    .map((r) => r.querySelectorAll("td")[column]?.textContent ?? "");
}

const previewAmounts = () => previewCells(1);
const previewCategories = () => previewCells(2);

function columnSelect(field: RegExp): HTMLSelectElement {
  return screen.getByLabelText(field) as HTMLSelectElement;
}

/** The header the importer says it is reading for `field`. */
function chosenColumn(field: RegExp): string {
  const select = columnSelect(field);
  return select.options[select.selectedIndex]?.textContent?.trim() ?? "";
}

async function chooseColumn(
  user: ReturnType<typeof userEvent.setup>,
  field: RegExp,
  headerLabel: string
): Promise<void> {
  const select = columnSelect(field);
  const option = Array.from(select.options).find((o) => o.textContent?.trim() === headerLabel);
  if (!option) {
    throw new Error(
      `no "${headerLabel}" option among [${Array.from(select.options)
        .map((o) => o.textContent)
        .join(", ")}]`
    );
  }
  await user.selectOptions(select, option.value);
}

function importButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /^Import( \d+)?$/ }) as HTMLButtonElement;
}

function sentRows(): { amount: number; category: string }[] {
  const call = bulkImportTransactionsAction.mock.calls[0][0] as {
    rows: { amount: number; category: string }[];
  };
  return call.rows;
}

beforeEach(() => {
  bulkImportTransactionsAction.mockReset();
  bulkImportTransactionsAction.mockResolvedValue({
    success: true,
    data: { imported: 1, skipped: 0, duplicates: [] },
  });
});

describe("CSV import — a file with both a Subtotal and an Amount column", () => {
  const CSV =
    "Date,Subtotal,Amount,Category,Description\n" + "2026-06-01,900,25000,Office Rent,June rent\n";

  it("imports the Amount column, not the subtotal", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await loadCsv(CSV);

    expect(previewAmounts()[0], "the preview is showing the subtotal as the amount").toMatch(
      /25,000/
    );
    expect(previewAmounts()[0]).not.toMatch(/\b900\b/);

    await user.click(importButton());
    await waitFor(() => expect(bulkImportTransactionsAction).toHaveBeenCalledTimes(1));
    expect(sentRows()[0].amount, "the subtotal was written to the ledger").toBe(25000);
  });

  it("names the column it is reading, and lets the customer re-point it", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await loadCsv(CSV);

    expect(chosenColumn(/amount column/i)).toBe("Amount");
    expect(chosenColumn(/date column/i)).toBe("Date");
    expect(chosenColumn(/category column/i)).toBe("Category");

    // The correction has to actually re-read the file: a mapping control that
    // only reports is the same silent import with a label on it.
    await chooseColumn(user, /amount column/i, "Subtotal");
    await waitFor(() => expect(previewAmounts()[0]).toMatch(/\b900\b/));

    await user.click(importButton());
    await waitFor(() => expect(bulkImportTransactionsAction).toHaveBeenCalledTimes(1));
    expect(sentRows()[0].amount).toBe(900);
  });
});

describe("CSV import — a file with both an Allocation and a Category column", () => {
  it("imports the Category column, not the allocation", async () => {
    // The nastiest form of this bug: "Marketing" IS a valid expense category, so
    // the row passed validation and the preview looked entirely correct.
    const user = userEvent.setup();
    render(<Harness />);
    await loadCsv("Date,Amount,Allocation,Category\n2026-06-01,25000,Marketing,Office Rent\n");

    expect(previewCategories(), "the allocation column was read as the category").toEqual([
      "Office Rent",
    ]);
    expect(chosenColumn(/category column/i)).toBe("Category");

    await user.click(importButton());
    await waitFor(() => expect(bulkImportTransactionsAction).toHaveBeenCalledTimes(1));
    expect(sentRows()[0].category).toBe("Office Rent");
  });
});

describe("CSV import — a file where no header is named 'amount' at all", () => {
  it("says a choice was made between the two columns that could be it", async () => {
    render(<Harness />);
    await loadCsv("Date,Subtotal,Grand Total,Category\n2026-06-01,900,25000,Office Rent\n");

    // Neither column is named "amount"; both only matched on "total". There is
    // no right answer to pick silently, so the rejected column is named — and
    // the picker is the way out.
    const note = screen.getByText(/also matched/i);
    expect(note.textContent, "a 50/50 guess between two money columns was made in silence").toMatch(
      /grand total/i
    );
    expect(chosenColumn(/amount column/i)).toBe("Subtotal");
  });
});
