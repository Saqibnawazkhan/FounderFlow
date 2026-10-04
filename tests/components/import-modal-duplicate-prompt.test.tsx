/**
 * transactions-ledger-008, the reachable half — the customer has to be TOLD
 * that rows were held back, and has to be able to overrule it.
 *
 * WHAT THE SERVER-SIDE FILE ALREADY COVERS.
 * `tests/lib/actions/import-duplicate-rows.test.ts` pins the action: a second
 * import of a file already in the ledger writes nothing, an overlapping
 * re-export imports only the new days, the withheld rows come back, and
 * `allowDuplicates` imports everything. None of it mounts the modal, so none of
 * it can see what the person who pressed Import ends up looking at.
 *
 * WHY THAT MATTERS HERE, AND NOT AS A COSMETIC. Without this half, the import
 * reads as a success that quietly did less than it said: "Imported 0" with no
 * explanation, which is indistinguishable from a broken importer and invites
 * exactly the retry the finding is about. And a guard with no override SILENTLY
 * DESTROYS a real transaction — two identical charges on one day, same memo,
 * are a thing that happens, and the second one would never reach the ledger.
 *
 * THE TRAP THIS FILE IS SHAPED AROUND. A partial import has already written the
 * new rows by the time the prompt appears. So "import anyway" must re-send ONLY
 * the rows the server withheld; re-sending the whole batch would double the
 * fresh half, which is the very defect being fixed, reintroduced by its own fix.
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

const bulkImportTransactionsAction = vi.fn();
vi.mock("@/lib/actions/transactions", () => ({
  bulkImportTransactionsAction: (input: unknown) => bulkImportTransactionsAction(input),
}));

// Fire-and-forget; stubbed so no toast portal renders into these queries.
vi.mock("react-hot-toast", () => ({
  default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));

// The real formatters, only the store faked — that is where currency and locale
// come from (`useMoney`, `useNumberFormat`).
vi.mock("@/lib/store", () => ({
  useStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ locale: "en", currentCompany: { id: "c1", currency: "PKR" } }),
  useStoreHasHydrated: () => true,
}));

type Row = { amount: number; category: string; description: string; date: string };

/** Two valid expense rows, dated in the past so the future-date guard passes. */
const CSV_TWO =
  "date,amount,category,description\n" +
  "2026-06-01,25000,Office Rent,June rent\n" +
  "2026-06-02,4500,Marketing,Ad spend\n";

const onImported = vi.fn();

function Harness() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Import CSV
      </button>
      <ImportTransactionsModal
        type="expense"
        projects={[{ id: "p1", name: "Apollo" }]}
        open={open}
        onClose={() => setOpen(false)}
        onImported={() => {
          onImported();
          setOpen(false);
        }}
      />
    </>
  );
}

/**
 * Hand the hidden file input a CSV and wait for the preview to settle.
 * `fireEvent` rather than `userEvent.upload`: the input is `display: none` (the
 * drop-zone button drives it) and pointer interaction with it is not under test.
 */
async function loadCsv(text: string, validRows: number): Promise<void> {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, {
    target: { files: [new File([text], "rows.csv", { type: "text/csv" })] },
  });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: new RegExp(`^Import ${validRows}$`) })).toBeEnabled()
  );
}

async function clickImport(validRows: number): Promise<void> {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: new RegExp(`^Import ${validRows}$`) }));
}

/** The payload of the Nth call to the action. */
function payload(n: number): { rows: Row[]; allowDuplicates?: boolean; projectId?: string } {
  return bulkImportTransactionsAction.mock.calls[n][0] as {
    rows: Row[];
    allowDuplicates?: boolean;
  };
}

/** A server whose ledger already holds every row it is sent. */
function everythingIsADuplicate(): void {
  bulkImportTransactionsAction.mockImplementation(async (input: unknown) => {
    const { rows, allowDuplicates } = input as { rows: Row[]; allowDuplicates?: boolean };
    return allowDuplicates
      ? { success: true, data: { imported: rows.length, skipped: 0, duplicates: [] } }
      : { success: true, data: { imported: 0, skipped: 0, duplicates: rows } };
  });
}

/** A server that already holds the LAST row of whatever it is sent. */
function theLastRowIsADuplicate(): void {
  bulkImportTransactionsAction.mockImplementation(async (input: unknown) => {
    const { rows, allowDuplicates } = input as { rows: Row[]; allowDuplicates?: boolean };
    if (allowDuplicates) {
      return { success: true, data: { imported: rows.length, skipped: 0, duplicates: [] } };
    }
    return {
      success: true,
      data: { imported: rows.length - 1, skipped: 0, duplicates: rows.slice(-1) },
    };
  });
}

/** The text of the last success toast, or `null` when none was shown. */
function successToast(): string | null {
  const calls = vi.mocked(toast.success).mock.calls;
  return calls.length === 0 ? null : String(calls[calls.length - 1][0]);
}

beforeEach(() => {
  onImported.mockReset();
  vi.mocked(toast.success).mockReset();
  vi.mocked(toast.error).mockReset();
  bulkImportTransactionsAction.mockReset();
  bulkImportTransactionsAction.mockResolvedValue({
    success: true,
    data: { imported: 2, skipped: 0, duplicates: [] },
  });
});

describe("ImportTransactionsModal — nothing was imported because it is all duplicates", () => {
  it("keeps the modal open and says how many rows the ledger already has", async () => {
    everythingIsADuplicate();
    render(<Harness />);
    await loadCsv(CSV_TWO, 2);
    await clickImport(2);

    await waitFor(() => expect(bulkImportTransactionsAction).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByText(/look like duplicates of entries you already have/i),
      "'Imported 0' with no explanation is indistinguishable from a broken importer, " +
        "and invites exactly the retry that doubles the ledger"
    ).toBeInTheDocument();
    expect(
      onImported,
      "closing the modal here throws away the only chance to ask the question"
    ).not.toHaveBeenCalled();
  });

  it("sends no override on the first attempt", async () => {
    everythingIsADuplicate();
    render(<Harness />);
    await loadCsv(CSV_TWO, 2);
    await clickImport(2);

    await waitFor(() => expect(bulkImportTransactionsAction).toHaveBeenCalledTimes(1));
    expect(
      payload(0).allowDuplicates,
      "the safe answer is the default — an import must never arrive pre-authorised to double"
    ).toBe(false);
  });

  it("re-sends the withheld rows, and only those, when told to import anyway", async () => {
    everythingIsADuplicate();
    const user = userEvent.setup();
    render(<Harness />);
    await loadCsv(CSV_TWO, 2);
    await clickImport(2);
    await waitFor(() => expect(bulkImportTransactionsAction).toHaveBeenCalledTimes(1));

    await user.click(await screen.findByRole("button", { name: /anyway/i }));

    await waitFor(() => expect(bulkImportTransactionsAction).toHaveBeenCalledTimes(2));
    expect(payload(1).allowDuplicates).toBe(true);
    expect(payload(1).rows.map((r) => r.description)).toEqual(["June rent", "Ad spend"]);
    // And the batch closes once the customer's answer has landed.
    await waitFor(() => expect(onImported).toHaveBeenCalledTimes(1));
  });

  it("lets the customer walk away, and still refreshes the ledger behind", async () => {
    everythingIsADuplicate();
    const user = userEvent.setup();
    render(<Harness />);
    await loadCsv(CSV_TWO, 2);
    await clickImport(2);

    await user.click(await screen.findByRole("button", { name: /^done$/i }));

    expect(bulkImportTransactionsAction).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onImported).toHaveBeenCalledTimes(1));
  });
});

describe("ImportTransactionsModal — a partial import", () => {
  it("re-sends ONLY the withheld row, so the rows that landed are not doubled", async () => {
    // The trap. By the time this prompt is on screen the fresh row is already
    // in the ledger; re-sending the whole batch would double it — the finding,
    // reintroduced by its own fix.
    theLastRowIsADuplicate();
    const user = userEvent.setup();
    render(<Harness />);
    await loadCsv(CSV_TWO, 2);
    await clickImport(2);
    await waitFor(() => expect(bulkImportTransactionsAction).toHaveBeenCalledTimes(1));

    await user.click(await screen.findByRole("button", { name: /anyway/i }));

    await waitFor(() => expect(bulkImportTransactionsAction).toHaveBeenCalledTimes(2));
    expect(
      payload(1).rows.map((r) => r.description),
      "the fresh row was re-sent, so the 'import anyway' doubles exactly what the guard saved"
    ).toEqual(["Ad spend"]);
    expect(payload(1).allowDuplicates).toBe(true);
  });

  it("refreshes the ledger behind when the prompt is dismissed with Cancel", async () => {
    // The hazard `finishBatch` already names, through the three exits that did
    // not get the same treatment. By the time this prompt is on screen the
    // fresh row IS in the ledger, and `onClose` is `() => setImportOpen(false)`
    // in all three clients (expenses-client.tsx:712, revenue-client.tsx:533,
    // investments-client.tsx:528) — only `onImported` calls `refresh()`. So
    // dismissing with Cancel left the page showing none of the rows that just
    // landed, which reads as "the import did nothing": the same stale screen
    // that invites the retry this whole finding is about.
    theLastRowIsADuplicate();
    const user = userEvent.setup();
    render(<Harness />);
    await loadCsv(CSV_TWO, 2);
    await clickImport(2);
    await waitFor(() => expect(bulkImportTransactionsAction).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole("button", { name: /^cancel$/i }));

    await waitFor(() =>
      expect(
        onImported,
        "a row was written before the prompt appeared — closing without a refresh shows " +
          "the customer a ledger that does not contain it"
      ).toHaveBeenCalledTimes(1)
    );
    expect(
      screen.queryByText(/look like duplicates of entries you already have/i),
      "Cancel still has to close the modal"
    ).toBeNull();
  });

  it("refreshes the ledger behind when the prompt is dismissed with Escape", async () => {
    // Same exit, through Radix's own Escape/outside-click wiring
    // (components/ui/modal.tsx: `onOpenChange` → `onClose`), which is the way a
    // customer who reads the prompt as an error actually leaves it.
    theLastRowIsADuplicate();
    const user = userEvent.setup();
    render(<Harness />);
    await loadCsv(CSV_TWO, 2);
    await clickImport(2);
    await waitFor(() => expect(bulkImportTransactionsAction).toHaveBeenCalledTimes(1));

    await user.keyboard("{Escape}");

    await waitFor(() => expect(onImported).toHaveBeenCalledTimes(1));
  });

  it("reports everything that landed, not just the override's own count", async () => {
    // Two rows, one fresh and one withheld, then the override. The toast is the
    // only on-screen total the customer gets, in the one flow where they are
    // already counting: "Imported 1" after importing 2 sends someone to the
    // ledger to count by hand — about doubling, which is this finding.
    theLastRowIsADuplicate();
    const user = userEvent.setup();
    render(<Harness />);
    await loadCsv(CSV_TWO, 2);
    await clickImport(2);
    await waitFor(() => expect(bulkImportTransactionsAction).toHaveBeenCalledTimes(1));

    await user.click(await screen.findByRole("button", { name: /anyway/i }));

    await waitFor(() => expect(onImported).toHaveBeenCalledTimes(1));
    expect(
      successToast(),
      "the override re-sends only the withheld rows, so its own count is not what landed"
    ).toMatch(/\b2\b/);
  });

  it("will not let the whole batch be fired again while the question is open", async () => {
    // The primary Import button still reads "Import 2" over the same preview.
    // Pressing it again is not harmful (the server would withhold everything
    // the second time) but it is a second write attempt the customer did not
    // mean, and it leaves the prompt unanswered.
    theLastRowIsADuplicate();
    render(<Harness />);
    await loadCsv(CSV_TWO, 2);
    await clickImport(2);
    await waitFor(() => expect(bulkImportTransactionsAction).toHaveBeenCalledTimes(1));

    expect(await screen.findByRole("button", { name: /anyway/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /^Import 2$/ })).toBeDisabled();
  });
});

describe("ImportTransactionsModal — a clean import is unchanged", () => {
  it("closes and refreshes when the server withheld nothing", async () => {
    render(<Harness />);
    await loadCsv(CSV_TWO, 2);
    await clickImport(2);

    await waitFor(() => expect(onImported).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/duplicate/i)).toBeNull();
  });
});
