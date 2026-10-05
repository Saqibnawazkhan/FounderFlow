/**
 * finance-planning-006 — a monthly cap has to be editable in place.
 *
 * The cap is the number a founder changes most often (a raise, a new quarter, a
 * renegotiated rent) and it had no control anywhere in the UI.
 * `UpdateBudgetSchema` has declared `monthlyLimit` and `updateBudgetAction` has
 * applied it since they were written (lib/schemas/budget.ts,
 * lib/actions/budgets.ts), while budgets-client.tsx's only call sent
 * `{ budgetId, active }` — a capability shipped, tested and unreachable. The
 * one route to a different cap was delete-and-recreate, which (even now that
 * delete writes a tombstone rather than hard-deleting) restarts the card's
 * createdAt/createdByName, drops the month's alert sentinels and re-fires the
 * alert against the new cap. The product already told people to do the thing it
 * did not offer: createBudgetAction refuses a duplicate with "A budget for
 * \"X\" already exists in this project. Edit or pause it instead."
 *
 * The contract:
 *   1. Every card offers an edit control for its OWN cap, named by (category,
 *      project) exactly like the pause and delete controls beside it — two
 *      legitimate Salaries caps must not show the same button twice
 *      (R3-money-018-cards).
 *   2. It opens on that row's CURRENT cap and posts `{ budgetId, monthlyLimit }`
 *      for that row.
 *   3. It validates through the same shared field the create form uses, so a
 *      correction cannot be the looser path: 1234.567 is refused in the form
 *      rather than rounded to 1234.57 by the `Decimal(12, 2)` column (money-002).
 *   4. A refusal from the server leaves the dialog open with the typed number
 *      still in it, so the edit is not lost to a toast.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BudgetsClient } from "@/app/(app)/budgets/budgets-client";
import type { BudgetWithSpend } from "@/lib/queries/budgets";

/* ───────────────────────────── module mocks ─────────────────────────────── */

const spies = vi.hoisted(() => ({
  updateBudgetAction: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/lib/actions/budgets", () => ({
  createBudgetAction: vi.fn(async () => ({ success: true, data: { id: "b-new" } })),
  updateBudgetAction: (input: unknown) => spies.updateBudgetAction(input),
  deleteBudgetAction: vi.fn(async () => ({ success: true, data: undefined })),
}));

vi.mock("react-hot-toast", () => ({
  default: Object.assign(vi.fn(), { error: spies.toastError, success: spies.toastSuccess }),
}));

vi.mock("@/components/ui/confirm-dialog", () => ({
  useConfirm: () => vi.fn(async () => false),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@/lib/store", () => ({
  useStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ locale: "en", currentCompany: { id: "c-1", currency: "PKR" } }),
  useStoreHasHydrated: () => true,
}));

/* ────────────────────────────── fixtures ────────────────────────────────── */

const PROJECTS = [
  { id: "p-alpha", name: "Alpha" },
  { id: "p-beta", name: "Beta" },
];

function budget(over: Partial<BudgetWithSpend> & { id: string }): BudgetWithSpend {
  return {
    companyId: "c-1",
    projectId: "p-alpha",
    projectName: "Alpha",
    category: "Salaries",
    monthlyLimit: 100000,
    createdBy: "u-1",
    createdByName: "Ayesha Raza",
    active: true,
    lastWarnedMonth: null,
    lastAlertedMonth: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    monthToDateSpend: 10000,
    percentUsed: 0.1,
    ...over,
  };
}

/** The two Salaries caps money-018 made legal: same category, different project. */
const TWO_SALARIES_CAPS = [
  budget({ id: "b-alpha", projectId: "p-alpha", projectName: "Alpha" }),
  budget({
    id: "b-beta",
    projectId: "p-beta",
    projectName: "Beta",
    monthlyLimit: 100000,
    monthToDateSpend: 20000,
  }),
];

function editControls(): HTMLElement[] {
  return screen.getAllByRole("button", { name: /^Edit /i });
}

/** Opens the cap editor on the card belonging to `projectName`. */
async function openEditor(user: ReturnType<typeof userEvent.setup>, projectName: string) {
  const control = editControls().find((b) =>
    (b.getAttribute("aria-label") ?? "").includes(projectName)
  );
  expect(control).toBeTruthy();
  await user.click(control as HTMLElement);
  return (await screen.findByRole("spinbutton", { name: /monthly cap/i })) as HTMLInputElement;
}

function saveButton(): HTMLElement {
  return screen.getByRole("button", { name: /save cap/i });
}

beforeEach(() => {
  spies.updateBudgetAction.mockReset();
  spies.updateBudgetAction.mockResolvedValue({ success: true, data: undefined });
  spies.toastError.mockReset();
  spies.toastSuccess.mockReset();
});

/* ─────────────────────────────── the tests ──────────────────────────────── */

describe("finance-planning-006 — editing a budget's monthly cap", () => {
  it("gives every card its own edit control, named like pause and delete are", () => {
    render(<BudgetsClient budgets={TWO_SALARIES_CAPS} projects={PROJECTS} />);

    const edits = editControls();
    expect(edits).toHaveLength(2);

    const names = edits.map((b) => b.getAttribute("aria-label") ?? "");
    expect(new Set(names).size).toBe(2);
    expect(names.filter((n) => /Alpha/.test(n))).toHaveLength(1);
    expect(names.filter((n) => /Beta/.test(n))).toHaveLength(1);
    for (const name of names) expect(name).toMatch(/Salaries/);
  });

  it("opens on the row's current cap and posts the new one for that row", async () => {
    const user = userEvent.setup();
    render(<BudgetsClient budgets={TWO_SALARIES_CAPS} projects={PROJECTS} />);

    const field = await openEditor(user, "Beta");
    // Seeded, not blank: this is an edit, not a retype from memory.
    expect(field.value).toBe("100000");

    await user.clear(field);
    await user.type(field, "250000");
    await user.click(saveButton());

    await waitFor(() => expect(spies.updateBudgetAction).toHaveBeenCalledTimes(1));
    // The Beta cap, not Alpha's — the two cards are otherwise identical.
    expect(spies.updateBudgetAction.mock.calls[0][0]).toEqual({
      budgetId: "b-beta",
      monthlyLimit: 250000,
    });
  });

  it("refuses a cap the money column would silently round", async () => {
    const user = userEvent.setup();
    render(<BudgetsClient budgets={TWO_SALARIES_CAPS} projects={PROJECTS} />);

    const field = await openEditor(user, "Alpha");
    await user.clear(field);
    await user.type(field, "1234.567");
    // Asserted so this test cannot pass while actually submitting some other
    // number the number input happened to keep.
    expect(field.value).toBe("1234.567");

    await user.click(saveButton());

    expect(await screen.findByText(/at most 2 decimal places/i)).toBeTruthy();
    expect(spies.updateBudgetAction).not.toHaveBeenCalled();
  });

  it("keeps the dialog and the typed number when the server refuses", async () => {
    spies.updateBudgetAction.mockResolvedValue({ success: false, error: "Not authorized" });
    const user = userEvent.setup();
    render(<BudgetsClient budgets={TWO_SALARIES_CAPS} projects={PROJECTS} />);

    const field = await openEditor(user, "Alpha");
    await user.clear(field);
    await user.type(field, "7500");
    await user.click(saveButton());

    await waitFor(() => expect(spies.toastError).toHaveBeenCalledWith("Not authorized"));
    const stillOpen = screen.getByRole("spinbutton", { name: /monthly cap/i }) as HTMLInputElement;
    expect(stillOpen.value).toBe("7500");
    expect(spies.toastSuccess).not.toHaveBeenCalled();
  });
});
