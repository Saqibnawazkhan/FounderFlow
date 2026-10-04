/**
 * transactions-ledger-004, second pass — the import modal's project tag must not
 * outlive the batch it was chosen for.
 *
 * WHAT THE SERVER-SIDE FILE ALREADY COVERS. `tests/lib/actions/import-project-tag.test.ts`
 * pins the half of the finding that is about the action: every row of the batch
 * carries the chosen project, the id is verified against the caller's company,
 * and the 80%/100% threshold is judged once per category. None of it mounts the
 * modal, so none of it can see WHICH project the next batch is about to carry.
 *
 * WHAT THIS FILE EXISTS FOR. The picker's value lives in
 * `ImportTransactionsModal`'s own `useState`, and all three ledger clients close
 * the modal by flipping their `importOpen` flag inside `onImported` — they never
 * call the component's `onClose`, and they render `<ImportTransactionsModal>`
 * unconditionally, so the component is never unmounted and nothing resets it.
 * The project tag was therefore cleared only in `handleClose`, a path a
 * successful import does not take: the picker stayed on project A for the rest
 * of the page visit, so the SECOND CSV silently landed on A's ledger. That moves
 * the wrong budget's month-to-date spend and can fire an 80%/100% alert that
 * `lib/budgets/check.ts` fans out as in-app + email + push against the wrong
 * project, and `EditTransactionSchema` refuses `projectId`, so the only remedy
 * is delete-and-reimport. The fix's own documented workflow is "import once per
 * project", which makes consecutive imports the normal flow rather than an
 * exotic one.
 *
 * So the harness below is deliberately shaped like the real callers — open state
 * in the parent, closed only through `onImported`, modal always mounted — because
 * a test that unmounted the modal between imports would pass against the bug.
 *
 * It also pins the counterpart invariant, which is easy to break while fixing
 * this one: "Choose another file" calls `reset()` and must KEEP the tag, or a
 * batch meant for a project lands untagged and crosses no budget at all.
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

const PROJECTS = [
  { id: "p1", name: "Apollo" },
  { id: "p2", name: "Borealis" },
];

/** One valid expense row, dated in the past so the future-date guard passes. */
const CSV_A = "date,amount,category,description\n2026-06-01,25000,Office Rent,June rent\n";
const CSV_B = "date,amount,category,description\n2026-06-02,4500,Marketing,Ad spend\n";

/**
 * The three ledger clients, reduced to the two things that matter here: the
 * modal is mounted for the whole page visit, and a successful import closes it
 * WITHOUT going through the modal's own close handler.
 * (expenses-client.tsx:712, revenue-client.tsx:533, investments-client.tsx:528)
 */
function Harness({ projects = PROJECTS }: { projects?: { id: string; name: string }[] }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Import CSV
      </button>
      <ImportTransactionsModal
        type="expense"
        projects={projects}
        open={open}
        onClose={() => setOpen(false)}
        onImported={() => setOpen(false)}
      />
    </>
  );
}

/** The batch's project picker. Only one `<select>` lives in this modal. */
function picker(): HTMLSelectElement {
  return screen.getByRole("combobox") as HTMLSelectElement;
}

/**
 * Hand the hidden file input a CSV and wait for the preview to settle.
 * `fireEvent` rather than `userEvent.upload`: the input is `display: none`
 * (it is driven by the drop-zone button), and pointer interaction with it is
 * not what is under test.
 */
async function loadCsv(text: string): Promise<void> {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, {
    target: { files: [new File([text], "rows.csv", { type: "text/csv" })] },
  });
  // FileReader is async; the enabled Import button is the signal that parsing
  // produced a valid row.
  await waitFor(() => expect(screen.getByRole("button", { name: /^Import 1$/ })).toBeEnabled());
}

/** The payload of the Nth call to the action. */
function payload(n: number): Record<string, unknown> {
  return bulkImportTransactionsAction.mock.calls[n][0] as Record<string, unknown>;
}

beforeEach(() => {
  bulkImportTransactionsAction.mockReset();
  // `duplicates` is part of the action's result (transactions-ledger-008) — the
  // rows it withheld as copies of entries already in the ledger. Nothing here
  // tests it, but the modal reads it on every success (and holds itself open
  // when it is non-empty), so a mock without it returns a shape the server
  // never returns.
  bulkImportTransactionsAction.mockResolvedValue({
    success: true,
    data: { imported: 1, skipped: 0, duplicates: [] },
  });
});

describe("ImportTransactionsModal — the project tag belongs to one batch", () => {
  it("sends the project the customer picked", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.selectOptions(picker(), "p1");
    await loadCsv(CSV_A);
    await user.click(screen.getByRole("button", { name: /^Import 1$/ }));

    await waitFor(() => expect(bulkImportTransactionsAction).toHaveBeenCalledTimes(1));
    expect(payload(0).projectId).toBe("p1");
  });

  it("forgets the project once the batch has landed, so the next CSV starts untagged", async () => {
    // WHAT BREAKS IN PRODUCTION: the customer with spend across several projects
    // imports Apollo's file, then Borealis's. If the picker is still on Apollo
    // when the second file goes in, Borealis's spend moves Apollo's budget and
    // can send an unrecallable email/push "80% of your budget" about a project
    // that never spent it. Nothing can retag the rows afterwards.
    const user = userEvent.setup();
    render(<Harness />);

    await user.selectOptions(picker(), "p1");
    await loadCsv(CSV_A);
    await user.click(screen.getByRole("button", { name: /^Import 1$/ }));
    await waitFor(() => expect(bulkImportTransactionsAction).toHaveBeenCalledTimes(1));

    // The client closed the modal by flipping `open`, exactly as onImported does.
    await waitFor(() => expect(screen.queryByRole("combobox")).toBeNull());
    await user.click(screen.getByRole("button", { name: "Import CSV" }));

    expect(
      picker().value,
      "the picker reopened on the previous batch's project — the next file lands on " +
        "the wrong budget and can fire a wrong-project over-budget alert"
    ).toBe("");

    // And the server is handed no project, which is what keeps the untagged
    // batch out of every budget's month-to-date spend.
    await loadCsv(CSV_B);
    await user.click(screen.getByRole("button", { name: /^Import 1$/ }));
    await waitFor(() => expect(bulkImportTransactionsAction).toHaveBeenCalledTimes(2));
    expect(payload(1).projectId, "the second batch inherited the first batch's project tag").toBe(
      ""
    );
  });

  it("keeps the tag when the customer swaps the file, not the project", async () => {
    // The counterpart invariant: `reset()` is also "Choose another file", and
    // silently dropping the tag there is how a batch meant for a project lands
    // untagged — which is the original finding all over again.
    const user = userEvent.setup();
    render(<Harness />);

    await user.selectOptions(picker(), "p2");
    await loadCsv(CSV_A);
    await user.click(screen.getByRole("button", { name: /choose another file/i }));

    expect(picker().value, "re-picking a file must not silently untag the batch").toBe("p2");
  });

  it("clears the tag when the modal is dismissed without importing", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.selectOptions(picker(), "p1");
    await user.click(screen.getByRole("button", { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByRole("combobox")).toBeNull());

    await user.click(screen.getByRole("button", { name: "Import CSV" }));
    expect(picker().value).toBe("");
  });
});

describe("ImportTransactionsModal — a workspace with no projects yet", () => {
  it("says why the imported expenses will cross no budget", async () => {
    // The finding's own IMPACT scenario is the customer who onboards BY
    // importing. They have no project yet, so there is no picker to render and
    // nothing to tag — and with no caption the "every budget reads 0 spent"
    // experience is exactly as silent as it was before the fix.
    render(<Harness projects={[]} />);

    expect(screen.queryByRole("combobox"), "nothing to pick from").toBeNull();
    expect(
      screen.getByText(/no projects yet/i),
      "the one state this fix cannot tag is the one it must explain"
    ).toBeInTheDocument();
  });

  it("says nothing of the sort on a revenue import", async () => {
    render(
      <ImportTransactionsModal
        type="income"
        projects={[]}
        open
        onClose={vi.fn()}
        onImported={vi.fn()}
      />
    );

    expect(
      screen.queryByText(/no projects yet/i),
      "money IN counts against no cap by design — there is no budget to miss"
    ).toBeNull();
  });
});
