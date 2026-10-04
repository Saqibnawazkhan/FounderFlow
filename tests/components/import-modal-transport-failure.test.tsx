/**
 * transactions-ledger-007 — the import dialog has to survive a call that never
 * comes back.
 *
 * WHAT WAS WRONG. `submit` awaited `bulkImportTransactionsAction` bare. The
 * action's own try/catch (lib/actions/transactions.ts) cannot help with any of
 * this: a dropped network, a Next.js action-boundary error or a dev-server
 * recompile makes the CALL reject, so the action never ran to catch anything.
 * The rejection unwound past `setBusy(false)`, which left `busy` true forever:
 * the confirm button stayed disabled reading "Importing…", no toast fired, and
 * the only way out was reloading the page.
 *
 * WHY THAT IS NOT MERELY UNTIDY. The customer cannot tell whether their 800-row
 * import landed. Reloading and re-importing is the obvious move — and it is
 * exactly the retry transactions-ledger-008 exists to stop doubling a ledger
 * over. So the recovery has to be on screen: a toast that says what is and is
 * not known, a live Import button, and the parsed preview still there to retry
 * with.
 *
 * THE TRAP THIS FILE IS SHAPED AROUND, and the one real difference from the
 * server-failure path already covered elsewhere: a returned
 * `{ success: false }` PROVES that batch did not commit. A rejection proves
 * nothing either way — the request may have been received, committed, and had
 * its response lost. So the outstanding duplicate question must never be
 * re-offered over the rows of the batch that was in flight: "import anyway"
 * skips the duplicate check by definition, and pressing it over a row that did
 * land is the doubling the guard exists to prevent. The plain re-import, which
 * DOES re-check, is the safe recovery and is what the toast points at.
 *
 * The harness is the three ledger clients reduced to what matters: the modal is
 * mounted for the whole page visit and a successful import closes it through
 * `onImported` (expenses-client.tsx:712, revenue-client.tsx:533,
 * investments-client.tsx:528), never through the modal's own `onClose`.
 */

import { useState } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import toast from "react-hot-toast";
import { ImportTransactionsModal } from "@/components/transactions/import-transactions-modal";
import { EXPENSE_CATEGORIES } from "@/lib/types";

const bulkImportTransactionsAction = vi.fn();
vi.mock("@/lib/actions/transactions", () => ({
  bulkImportTransactionsAction: (input: unknown) => bulkImportTransactionsAction(input),
}));

// Fire-and-forget; stubbed so no toast portal renders into these queries.
vi.mock("react-hot-toast", () => ({
  default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));

// The real formatters, only the store faked — that is where currency and locale
// come from (`useMoney`, `useNumberFormat`), and the copy under test quotes a
// grouped row count ("1,000").
vi.mock("@/lib/store", () => ({
  useStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ locale: "en", currentCompany: { id: "c1", currency: "PKR" } }),
  useStoreHasHydrated: () => true,
}));

type Row = { amount: number; category: string; description: string; date: string };
type Payload = { rows: Row[]; allowDuplicates?: boolean; projectId?: string };

/** Two valid expense rows, dated in the past so the future-date guard passes. */
const CSV_TWO =
  "date,amount,category,description\n" +
  "2026-06-01,25000,Office Rent,June rent\n" +
  "2026-06-02,4500,Marketing,Ad spend\n";

/** A valid expense CSV with `count` data rows — distinct amounts and memos, so
 *  no row is a duplicate of another. */
function csv(count: number): string {
  const lines = ["date,amount,category,description"];
  for (let i = 0; i < count; i++) {
    lines.push(
      `2026-06-01,${100 + i},${EXPENSE_CATEGORIES[i % EXPENSE_CATEGORIES.length]},Row ${i + 1}`
    );
  }
  return `${lines.join("\n")}\n`;
}

const onImported = vi.fn();
const onClose = vi.fn();

function Harness() {
  const [open, setOpen] = useState(true);
  return (
    <ImportTransactionsModal
      type="expense"
      projects={[{ id: "p1", name: "Apollo" }]}
      open={open}
      onClose={() => {
        onClose();
        setOpen(false);
      }}
      onImported={() => {
        onImported();
        setOpen(false);
      }}
    />
  );
}

/** Hand the hidden file input a CSV and wait for the preview to settle.
 *  `fireEvent` rather than `userEvent.upload`: the input is `display: none`
 *  (the drop-zone button drives it) and pointer interaction with it is not
 *  under test. */
async function loadCsv(text: string, label: string): Promise<void> {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, {
    target: { files: [new File([text], "rows.csv", { type: "text/csv" })] },
  });
  await waitFor(
    () =>
      expect(screen.getByRole("button", { name: new RegExp(`^Import ${label}$`) })).toBeEnabled(),
    { timeout: 8000 }
  );
}

function importButton(label: string): HTMLElement {
  return screen.getByRole("button", { name: new RegExp(`^Import ${label}$`) });
}

async function clickImport(label: string): Promise<void> {
  const user = userEvent.setup();
  await user.click(importButton(label));
}

/** The payload of the Nth call to the action. */
function payload(n: number): Payload {
  return bulkImportTransactionsAction.mock.calls[n][0] as Payload;
}

/** The text of the last error toast, or `null` when none was shown. */
function errorToast(): string | null {
  const calls = vi.mocked(toast.error).mock.calls;
  return calls.length === 0 ? null : String(calls[calls.length - 1][0]);
}

/** The call never comes back: the transport failed, so the action never ran. */
function unreachableServer(): void {
  bulkImportTransactionsAction.mockRejectedValue(new Error("Failed to fetch"));
}

beforeEach(() => {
  onImported.mockReset();
  onClose.mockReset();
  vi.mocked(toast.success).mockReset();
  vi.mocked(toast.error).mockReset();
  bulkImportTransactionsAction.mockReset();
});

describe("ImportTransactionsModal — the import call never comes back", () => {
  it("tells the customer, instead of sitting on 'Importing…' forever", async () => {
    unreachableServer();
    render(<Harness />);
    await loadCsv(CSV_TWO, "2");
    await clickImport("2");

    await waitFor(() => expect(bulkImportTransactionsAction).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        errorToast(),
        "a failed import with no toast is indistinguishable from a hung one, and " +
          "reloading to find out is the retry that doubles a ledger"
      ).toBeTruthy()
    );
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
  });

  it("re-enables the Import button so the retry does not need a page reload", async () => {
    unreachableServer();
    render(<Harness />);
    await loadCsv(CSV_TWO, "2");
    await clickImport("2");

    await waitFor(() => expect(bulkImportTransactionsAction).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        importButton("2"),
        "`busy` was never cleared, so the only way out of this dialog was reloading"
      ).toBeEnabled()
    );
    expect(screen.queryByText(/Importing…/)).toBeNull();
  });

  it("leaves the parsed preview in place, and retrying re-sends the same rows", async () => {
    unreachableServer();
    render(<Harness />);
    await loadCsv(CSV_TWO, "2");
    await clickImport("2");
    await waitFor(() => expect(bulkImportTransactionsAction).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(importButton("2")).toBeEnabled());

    // The file the customer chose is still on screen — re-picking it is not
    // part of recovering from a network blip.
    expect(screen.getByText("rows.csv")).toBeInTheDocument();
    expect(screen.getByText("2 valid")).toBeInTheDocument();

    await clickImport("2");
    await waitFor(() => expect(bulkImportTransactionsAction).toHaveBeenCalledTimes(2));
    expect(payload(1).rows.map((r) => r.description)).toEqual(["June rent", "Ad spend"]);
    expect(
      payload(1).allowDuplicates,
      "the safe answer is still the default — a retry must never arrive pre-authorised to double"
    ).toBe(false);
  });

  it("keeps the modal open rather than reporting a success that did not happen", async () => {
    unreachableServer();
    render(<Harness />);
    await loadCsv(CSV_TWO, "2");
    await clickImport("2");

    await waitFor(() => expect(bulkImportTransactionsAction).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(importButton("2")).toBeEnabled());
    expect(onImported).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("ImportTransactionsModal — the call drops part-way through a multi-batch file", () => {
  it("says which batch it stopped at and how many rows had already landed", async () => {
    // 1,200 valid rows: batch 1 of 1,000 lands, batch 2 never comes back.
    bulkImportTransactionsAction
      .mockResolvedValueOnce({
        success: true,
        data: { imported: 1000, skipped: 0, duplicates: [] },
      })
      .mockRejectedValueOnce(new Error("Failed to fetch"));
    render(<Harness />);
    await loadCsv(csv(1200), "1,200");
    await clickImport("1,200");

    await waitFor(() => expect(bulkImportTransactionsAction).toHaveBeenCalledTimes(2), {
      timeout: 8000,
    });
    await waitFor(() => expect(errorToast()).toBeTruthy());
    expect(
      errorToast(),
      "half this file is in the ledger; a bare failure message makes that invisible"
    ).toMatch(/2 of 2/);
    expect(errorToast()).toMatch(/1,000/);
    await waitFor(() => expect(importButton("1,200")).toBeEnabled());
  });

  it("refreshes the ledger behind on the way out, because rows did land", async () => {
    bulkImportTransactionsAction
      .mockResolvedValueOnce({
        success: true,
        data: { imported: 1000, skipped: 0, duplicates: [] },
      })
      .mockRejectedValueOnce(new Error("Failed to fetch"));
    const user = userEvent.setup();
    render(<Harness />);
    await loadCsv(csv(1200), "1,200");
    await clickImport("1,200");
    await waitFor(() => expect(bulkImportTransactionsAction).toHaveBeenCalledTimes(2), {
      timeout: 8000,
    });
    await waitFor(() => expect(importButton("1,200")).toBeEnabled());

    await user.click(screen.getByRole("button", { name: /^cancel$/i }));

    await waitFor(() =>
      expect(
        onImported,
        "1,000 rows were written before the call dropped — closing without a refresh shows " +
          "the customer a ledger that does not contain them, which reads as 'the import did " +
          "nothing' and invites the retry"
      ).toHaveBeenCalledTimes(1)
    );
  });
});

describe("ImportTransactionsModal — the 'import anyway' call never comes back", () => {
  it("re-enables the dialog and withdraws the override offer over rows that may have landed", async () => {
    // First attempt: the server withholds both rows as duplicates, so the
    // prompt goes up. The override is then lost in transit — which proves
    // nothing about whether those two rows are now in the ledger.
    bulkImportTransactionsAction
      .mockResolvedValueOnce({
        success: true,
        data: {
          imported: 0,
          skipped: 0,
          duplicates: [
            {
              amount: 25000,
              category: "Office Rent",
              description: "June rent",
              date: "2026-06-01",
            },
            { amount: 4500, category: "Marketing", description: "Ad spend", date: "2026-06-02" },
          ],
        },
      })
      .mockRejectedValueOnce(new Error("Failed to fetch"));
    const user = userEvent.setup();
    render(<Harness />);
    await loadCsv(CSV_TWO, "2");
    await clickImport("2");
    await waitFor(() => expect(bulkImportTransactionsAction).toHaveBeenCalledTimes(1));

    await user.click(await screen.findByRole("button", { name: /anyway/i }));

    await waitFor(() => expect(bulkImportTransactionsAction).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(errorToast()).toBeTruthy());
    // The offer must not survive: "import anyway" skips the duplicate check by
    // definition, so pressing it again over rows that DID land is the doubling
    // the guard exists to prevent. The plain re-import re-checks, and is what
    // the customer is left holding.
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /anyway/i }),
        "this offer is no longer safe"
      ).toBeNull()
    );
    expect(importButton("2")).toBeEnabled();
  });
});
