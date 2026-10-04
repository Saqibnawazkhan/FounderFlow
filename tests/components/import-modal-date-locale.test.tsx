/**
 * transactions-ledger-003 — the CSV importer must not read a date it cannot
 * read unambiguously.
 *
 * WHAT WAS WRONG. `parseText` handed the raw date cell to `new Date(rawDate)`,
 * whose fallback parser guesses month-first. Verified in V8 under this suite's
 * TZ pin (America/Bogota, UTC-5):
 *
 *     "02/06/2026"          → 2026-02-06T05:00:00Z   6 February, not 2 June
 *     "25/06/2026"          → Invalid Date           skipped as "Unreadable date"
 *     "01.06.2026"          → 2026-01-06T05:00:00Z   6 January, not 1 June
 *     "2026-06-01 00:00:00" → 2026-06-01T05:00:00Z   not UTC midnight
 *
 * The first two together are the worst of it. A DD/MM/YYYY export — which is
 * what Excel produces for this product's home market — has roughly 61% of its
 * rows land on a day of 12 or less, and those are exactly the rows that import,
 * month and day transposed, flagged as valid. The 39% with a day above 12 are
 * refused. So the customer is shown "61 valid, 39 skipped", fixes 39 cells, and
 * keeps the 61 corrupted ones.
 *
 * The fourth line is money-007 on the import path: `Transaction.date` is a
 * date-only value stored at UTC midnight and every reader buckets in UTC, but a
 * cell carrying a clock time parses as LOCAL, so the stored instant is the
 * browser's offset rather than midnight. Under this TZ pin that keeps the
 * calendar day, which is why the assertion below is on the value SENT and not
 * on the preview. It does not keep the day everywhere: re-run the same cell at
 * TZ=Asia/Karachi (UTC+5, this product's primary market) and it becomes
 * 2026-05-31T19:00:00Z — a row dated the 1st booked into the month before, and
 * every other non-ISO cell a day early too.
 *
 * THE CONTRACT PINNED HERE is the finding's own: a date either imports as the
 * day the customer wrote, or is refused by name. Never a third thing that looks
 * right in the preview.
 *
 * WHY A COMPONENT TEST and not only `tests/lib/transactions/ledger-date.test.ts`:
 * the day/month order is decided across the whole COLUMN, and the preview and
 * the action payload are the two places a customer and the database see the
 * result. A unit test of the parser cannot see either, and cannot see that the
 * preview agrees with what was sent.
 *
 * The amount half of the same finding ("1.234,56", "(500.00)") was ALREADY
 * CLOSED by money-009 — `parseMoneyInput` in lib/format.ts, pinned by
 * tests/lib/format/money-input.test.ts. The last block below re-checks the two
 * cells this finding names end-to-end through the modal, because that file tests
 * the parser and not the importer's use of it.
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

/**
 * Hand the hidden file input a CSV. `fireEvent` rather than `userEvent.upload`
 * because the input is `display: none` — the same reason
 * import-modal-project-tag.test.tsx does it this way.
 *
 * Waits on the preview TABLE rather than on an enabled Import button, because
 * half of these cases must end with every row refused and that button disabled.
 */
async function loadCsv(text: string): Promise<void> {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, {
    target: { files: [new File([text], "rows.csv", { type: "text/csv" })] },
  });
  await waitFor(() => expect(screen.getByRole("table")).toBeInTheDocument());
}

/** The date cell of each preview row, in order — first column of each body row. */
function previewDates(): string[] {
  const rows = screen.getAllByRole("row").slice(1); // drop the header row
  return rows.map((r) => r.querySelectorAll("td")[0].textContent ?? "");
}

/** Every refusal reason the preview is showing, joined for substring checks. */
function previewErrors(): string {
  return screen
    .getAllByRole("row")
    .slice(1)
    .map((r) => r.querySelectorAll("td")[3].textContent ?? "")
    .join(" | ");
}

function importButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /^Import( \d+)?$/ }) as HTMLButtonElement;
}

function sentDates(): string[] {
  const call = bulkImportTransactionsAction.mock.calls[0][0] as {
    rows: { date: string }[];
  };
  return call.rows.map((r) => r.date);
}

const HEAD = "date,amount,category,description\n";

beforeEach(() => {
  bulkImportTransactionsAction.mockReset();
  // `duplicates` is part of the action's result (transactions-ledger-008) — the
  // rows it withheld as copies of entries already in the ledger. Nothing here
  // tests it, but the modal reads it on every success, so a mock without it
  // returns a shape the server never returns.
  bulkImportTransactionsAction.mockResolvedValue({
    success: true,
    data: { imported: 2, skipped: 0, duplicates: [] },
  });
});

describe("CSV import — a day-first (DD/MM/YYYY) export", () => {
  it("reads every row day-first once the column proves the order, and says so", async () => {
    // "25/06/2026" can only be 25 June: there is no month 25. That one cell
    // settles the order for the whole column, so "02/06/2026" in the same file
    // is 2 June — not the 6 February that `new Date` returned for it.
    const user = userEvent.setup();
    render(<Harness />);
    await loadCsv(HEAD + "25/06/2026,25000,Office Rent,June rent\n02/06/2026,4500,Marketing,Ads\n");

    expect(
      previewDates(),
      "a day-first column was either refused or transposed into another month"
    ).toEqual(["2026-06-25", "2026-06-02"]);

    expect(
      screen.getByText(/read day first/i),
      "the importer guessed an order and never told the customer which one"
    ).toBeInTheDocument();

    await user.click(importButton());
    await waitFor(() => expect(bulkImportTransactionsAction).toHaveBeenCalledTimes(1));
    // UTC midnight, because `Transaction.date` is date-only and every reader
    // buckets in UTC (money-007).
    expect(sentDates()).toEqual(["2026-06-25T00:00:00.000Z", "2026-06-02T00:00:00.000Z"]);
  });

  it("reads a dot-separated day-first column the same way", async () => {
    // "01.06.2026" is 1 June across most of Europe and `new Date` read it as
    // 6 January — a different month AND a different year's quarter.
    render(<Harness />);
    await loadCsv(HEAD + "25.06.2026,25000,Office Rent,a\n01.06.2026,4500,Marketing,b\n");

    expect(previewDates()).toEqual(["2026-06-25", "2026-06-01"]);
  });
});

describe("CSV import — a column that never says which order it is in", () => {
  it("refuses every ambiguous cell instead of picking US order", async () => {
    // Every day in this file is 12 or less, so nothing in the column rules out
    // either reading. Guessing is what produced the finding; the only honest
    // answer is to refuse and name both candidates.
    render(<Harness />);
    await loadCsv(HEAD + "02/06/2026,4500,Marketing,a\n03/07/2026,1200,Marketing,b\n");

    expect(previewDates(), "an unresolvable date was shown as if it were understood").toEqual([
      "—",
      "—",
    ]);
    expect(previewErrors()).toMatch(/2026-06-02/);
    expect(previewErrors()).toMatch(/2026-02-06/);
    expect(importButton(), "an unreadable ledger must not be importable").toBeDisabled();
    expect(bulkImportTransactionsAction).not.toHaveBeenCalled();
  });
});

describe("CSV import — an ISO date carrying a clock time", () => {
  it("keeps the calendar day the cell names, at UTC midnight", async () => {
    // `new Date("2026-06-01 00:00:00")` is LOCAL midnight, so the stored instant
    // carries the browser's offset. At UTC+5 — Karachi — that is
    // 2026-05-31T19:00:00Z and the row books into May.
    const user = userEvent.setup();
    bulkImportTransactionsAction.mockResolvedValue({
      success: true,
      data: { imported: 1, skipped: 0, duplicates: [] },
    });
    render(<Harness />);
    await loadCsv(HEAD + "2026-06-01 00:00:00,25000,Office Rent,June rent\n");

    expect(previewDates(), "a row dated the 1st slid into the previous month").toEqual([
      "2026-06-01",
    ]);

    await user.click(importButton());
    await waitFor(() => expect(bulkImportTransactionsAction).toHaveBeenCalledTimes(1));
    expect(sentDates()).toEqual(["2026-06-01T00:00:00.000Z"]);
  });
});

describe("CSV import — the amount half of this finding (money-009, already closed)", () => {
  it("still refuses a European decimal comma and an accounting negative", async () => {
    render(<Harness />);
    // The European cell is CSV-quoted, or its decimal comma would split the row.
    await loadCsv(HEAD + '2026-06-01,"1.234,56",Marketing,a\n2026-06-02,(500.00),Marketing,b\n');

    const errors = previewErrors();
    expect(errors, 'an amount of "1.234,56" would be stored as 1.23').toMatch(/1\.234,56/);
    expect(errors, 'an outflow of "(500.00)" would be booked as a +500 inflow').toMatch(
      /is negative/
    );
    expect(importButton()).toBeDisabled();
  });
});
