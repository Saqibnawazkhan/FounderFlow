/**
 * transactions-ledger-010, the reachable half — onboarding from a real
 * accounting export must not dead-end.
 *
 * WHAT WAS WRONG. `ImportTransactionsSchema` caps a call at 1,000 rows
 * (lib/schemas/transaction.ts) and `handleImport` sent `rows.filter(r => r.valid)`
 * unchunked. So 1,001 valid rows produced ONE zod failure — "Import at most 1000
 * rows at a time" — and zero inserts. The cap appeared nowhere: not in the
 * dialog, not on the template link, not in the file input's hint. The customer
 * learned it only after picking a file, waiting for a preview that rendered one
 * `<tr>` per row with no bound, and pressing Import. That is the one moment a new
 * paying customer decides whether this product can hold their history, and it
 * failed with an error that reads like a bug and offered no way forward.
 *
 * WHY THESE ASSERTIONS AND NOT A NUMBER IN A SCHEMA TEST. The pure half lives in
 * tests/lib/transactions/import-batches.test.ts, which pins the chunker and ties
 * its size to the real schema. None of it mounts the modal, so none of it can
 * see the four things the customer actually experiences: the limits BEFORE the
 * file picker, the batch plan before they commit, a file refused for its size or
 * row count without the tab locking up, and ONE duplicate question for the whole
 * file rather than one per batch.
 *
 * THE TRAP THIS FILE IS SHAPED AROUND. Chunking the override is where this fix
 * could reintroduce transactions-ledger-008: "import anyway" must re-send exactly
 * the rows the server withheld across every batch, once. Re-sending a whole
 * chunk, or asking the question twice, doubles the ledger — which is the defect
 * the duplicate guard exists to prevent, reintroduced by this finding's own fix.
 *
 * The stand-in server below enforces the REAL `ImportTransactionsSchema`, the
 * action's own first gate (lib/actions/transactions.ts:420), so an over-sized
 * batch is refused here with production's own message rather than waved through
 * by a mock.
 */

import { useState } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import toast from "react-hot-toast";
import { ImportTransactionsModal } from "@/components/transactions/import-transactions-modal";
import { ImportTransactionsSchema } from "@/lib/schemas/transaction";
import { IMPORT_MAX_TOTAL_ROWS, IMPORT_PREVIEW_ROWS } from "@/lib/transactions/import-batches";
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
// come from (`useMoney`, `useNumberFormat`), and the copy under test quotes
// grouped numbers ("1,200").
vi.mock("@/lib/store", () => ({
  useStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ locale: "en", currentCompany: { id: "c1", currency: "PKR" } }),
  useStoreHasHydrated: () => true,
}));

type Row = { amount: number; category: string; description: string; date: string };
type Payload = { rows: Row[]; allowDuplicates?: boolean; projectId?: string };

/**
 * A valid expense CSV with `count` data rows. Distinct amounts and
 * descriptions, so no row is a duplicate of another; one past date for all of
 * them, in ISO so the day/month order needs no inferring.
 */
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

function Harness() {
  const [open, setOpen] = useState(true);
  return (
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
  );
}

function fileInput(): HTMLInputElement {
  return document.querySelector('input[type="file"]') as HTMLInputElement;
}

/** Hand the hidden file input a CSV. `fireEvent` rather than `userEvent.upload`:
 *  the input is `display: none` (the drop-zone button drives it). */
function pick(text: string, name = "rows.csv", size?: number): void {
  const file = new File([text], name, { type: "text/csv" });
  if (size !== undefined) Object.defineProperty(file, "size", { value: size });
  fireEvent.change(fileInput(), { target: { files: [file] } });
}

/** Pick a CSV and wait for its preview to settle. `label` is the grouped row
 *  count as the Import button spells it. */
async function loadCsv(text: string, label: string): Promise<void> {
  pick(text);
  await waitFor(
    () =>
      expect(screen.getByRole("button", { name: new RegExp(`^Import ${label}$`) })).toBeEnabled(),
    { timeout: 8000 }
  );
}

async function clickImport(label: string): Promise<void> {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: new RegExp(`^Import ${label}$`) }));
}

/** The payload of the Nth call to the action. */
function payload(n: number): Payload {
  return bulkImportTransactionsAction.mock.calls[n][0] as Payload;
}

/** The row counts of every call, in order — the shape of the whole fix. */
function batchSizes(): number[] {
  return bulkImportTransactionsAction.mock.calls.map((c) => (c[0] as Payload).rows.length);
}

/**
 * A stand-in that enforces the REAL `ImportTransactionsSchema` before
 * answering, exactly as the action does, and otherwise takes everything it is
 * sent.
 */
function serverEnforcingTheRealSchema(): void {
  bulkImportTransactionsAction.mockImplementation(async (input: unknown) => {
    const parsed = ImportTransactionsSchema.safeParse(input);
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid import" };
    }
    return {
      success: true,
      data: { imported: parsed.data.rows.length, skipped: 0, duplicates: [] },
    };
  });
}

beforeEach(() => {
  bulkImportTransactionsAction.mockReset();
  onImported.mockClear();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
});

describe("a CSV larger than one batch (transactions-ledger-010)", () => {
  it("imports all 1,200 rows in two batches instead of refusing the file", async () => {
    serverEnforcingTheRealSchema();
    render(<Harness />);
    await loadCsv(csv(1200), "1,200");
    await clickImport("1,200");

    await waitFor(() => expect(bulkImportTransactionsAction).toHaveBeenCalled());
    await waitFor(() => expect(batchSizes()).toEqual([1000, 200]));

    // No row lost, none sent twice, file order preserved across the boundary.
    const sent = payload(0).rows.concat(payload(1).rows);
    expect(sent.map((r) => r.description)).toEqual(
      Array.from({ length: 1200 }, (_, i) => `Row ${i + 1}`)
    );

    await waitFor(() => expect(onImported).toHaveBeenCalled());
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
    expect(String(vi.mocked(toast.success).mock.calls[0][0])).toContain("1,200");
  });

  it("says how many batches it will take before you press Import", async () => {
    serverEnforcingTheRealSchema();
    render(<Harness />);
    await loadCsv(csv(1200), "1,200");

    expect(screen.getByText(/2 batches/)).toBeInTheDocument();
    expect(bulkImportTransactionsAction).not.toHaveBeenCalled();
  });

  it("states the row, size and batch limits before any file is chosen", () => {
    render(<Harness />);

    // Before the file picker, not after the preview: the whole complaint is
    // that the customer learned the limit from a rejection.
    expect(screen.getByText(/10,000 rows/)).toBeInTheDocument();
    expect(screen.getByText(/5 MB/)).toBeInTheDocument();
    expect(screen.getByText(/batches of 1,000/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("previews only the first rows of a large file, and says the rest were checked too", async () => {
    serverEnforcingTheRealSchema();
    render(<Harness />);
    await loadCsv(csv(1200), "1,200");

    // One <tr> per row with no bound is what locks the tab up on a real export.
    expect(screen.getAllByRole("row").slice(1)).toHaveLength(IMPORT_PREVIEW_ROWS);
    expect(
      screen.getByText(new RegExp(`first ${IMPORT_PREVIEW_ROWS} of 1,200`))
    ).toBeInTheDocument();
  });

  it("asks the duplicate question once for the whole file and re-sends only those rows", async () => {
    // Batch 1 is all fresh; batch 2's first three rows are already in the
    // ledger. One question, three rows, one override call.
    let call = 0;
    bulkImportTransactionsAction.mockImplementation(async (input: unknown) => {
      const { rows, allowDuplicates } = input as Payload;
      if (allowDuplicates) {
        return { success: true, data: { imported: rows.length, skipped: 0, duplicates: [] } };
      }
      call += 1;
      if (call === 2) {
        return {
          success: true,
          data: { imported: rows.length - 3, skipped: 0, duplicates: rows.slice(0, 3) },
        };
      }
      return { success: true, data: { imported: rows.length, skipped: 0, duplicates: [] } };
    });
    render(<Harness />);
    await loadCsv(csv(1200), "1,200");
    await clickImport("1,200");

    await waitFor(() =>
      expect(screen.getByText(/3 rows look like duplicates/)).toBeInTheDocument()
    );
    // The count is the whole file's, not the last batch's.
    expect(screen.getByText(/other 1,197 rows were imported/)).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Import 3 anyway$/ }));

    await waitFor(() => expect(batchSizes()).toEqual([1000, 200, 3]));
    expect(payload(2).allowDuplicates).toBe(true);
    expect(String(vi.mocked(toast.success).mock.calls[0][0])).toContain("1,200");
  });

  it("says how much landed when a batch fails part-way through the file", async () => {
    let call = 0;
    bulkImportTransactionsAction.mockImplementation(async (input: unknown) => {
      const { rows } = input as Payload;
      call += 1;
      if (call === 2) return { success: false, error: "Couldn't import right now. Try again." };
      return { success: true, data: { imported: rows.length, skipped: 0, duplicates: [] } };
    });
    render(<Harness />);
    await loadCsv(csv(1200), "1,200");
    await clickImport("1,200");

    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalled());
    const message = String(vi.mocked(toast.error).mock.calls[0][0]);
    expect(message).toContain("Couldn't import right now");
    expect(message).toMatch(/batch 2 of 2/);
    expect(message).toContain("1,000");
    // The modal stays open on the file, so the customer can see where they are.
    expect(screen.getByRole("table")).toBeInTheDocument();
  });
});

describe("a CSV the importer will not take at all", () => {
  it("refuses an oversized file before the FileReader touches it", async () => {
    const readAsText = vi.spyOn(FileReader.prototype, "readAsText");
    try {
      render(<Harness />);
      pick(csv(2), "huge.csv", 6 * 1024 * 1024);

      await waitFor(() => expect(screen.getByText(/That file is 6 MB/)).toBeInTheDocument());
      // Reading it is what locks the tab up while the customer waits to be told no.
      expect(readAsText).not.toHaveBeenCalled();
      expect(screen.queryByRole("table")).toBeNull();
    } finally {
      readAsText.mockRestore();
    }
  });

  it("refuses a file with more rows than it can take, naming the count and the cap", async () => {
    render(<Harness />);
    pick(csv(IMPORT_MAX_TOTAL_ROWS + 1));

    await waitFor(() => expect(screen.getByText(/That file has 10,001 rows/)).toBeInTheDocument(), {
      timeout: 8000,
    });
    expect(screen.getByText(/takes up to 10,000 at a time/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    expect(bulkImportTransactionsAction).not.toHaveBeenCalled();
  });
});
