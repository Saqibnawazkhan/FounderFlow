/**
 * R3-money-018-cards — the state money-018 unlocked must be representable.
 *
 * money-018 made a second "Salaries" cap legal, as long as it lives in another
 * project (`createBudgetAction` scopes its uniqueness check to
 * `{ projectId, category, active: true, deletedAt: null }`). /budgets then
 * rendered both of them from `budget.category` alone, so the two cards were
 * byte-for-byte identical — and so was the destructive control on each:
 * `aria-label="Delete Salaries budget"` twice, and a confirm dialog reading
 * "Delete the Salaries budget?" with no idea which one it meant. The fix made
 * a delete ambiguous for exactly the customers it was built for.
 *
 * The contract, in three parts:
 *   1. A card names the project its cap belongs to, so two legitimate Salaries
 *      caps read differently — including to a screen reader, which gets the
 *      progress bar's label and nothing else.
 *   2. The delete control and the confirm dialog behind it both name the
 *      project, so "Delete" can never be aimed at the wrong tenant's cap.
 *   3. The New-budget form never swaps the user's chosen category without
 *      saying so, and never parks on a submit the server is guaranteed to
 *      refuse (every category already capped in the project just picked).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BudgetsClient } from "@/app/(app)/budgets/budgets-client";
import { EXPENSE_CATEGORIES } from "@/lib/types";
import type { BudgetWithSpend } from "@/lib/queries/budgets";
import type { ConfirmOptions } from "@/components/ui/confirm-dialog";

/* ───────────────────────────── module mocks ─────────────────────────────── */

const spies = vi.hoisted(() => ({
  createBudgetAction: vi.fn(),
  deleteBudgetAction: vi.fn(),
  // Records what the destructive control actually asked, and answers "no" so
  // nothing is deleted — the dialog's wording is the subject here.
  confirm: vi.fn(),
}));

vi.mock("@/lib/actions/budgets", () => ({
  createBudgetAction: (input: unknown) => spies.createBudgetAction(input),
  updateBudgetAction: vi.fn(async () => ({ success: true, data: undefined })),
  deleteBudgetAction: (id: string) => spies.deleteBudgetAction(id),
}));

vi.mock("react-hot-toast", () => ({
  default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));

vi.mock("@/components/ui/confirm-dialog", () => ({
  useConfirm: () => spies.confirm,
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
  budget({ id: "b-beta", projectId: "p-beta", projectName: "Beta", monthToDateSpend: 20000 }),
];

/** Opens the New budget modal and hands back the two selects. */
async function openForm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /New budget/i }));
  const project = (await screen.findByLabelText("Project")) as HTMLSelectElement;
  const category = screen.getByLabelText("Category") as HTMLSelectElement;
  return { project, category };
}

beforeEach(() => {
  spies.createBudgetAction.mockReset();
  spies.createBudgetAction.mockResolvedValue({ success: true, data: { id: "b-new" } });
  spies.deleteBudgetAction.mockReset();
  spies.deleteBudgetAction.mockResolvedValue({ success: true, data: undefined });
  spies.confirm.mockReset();
  spies.confirm.mockResolvedValue(false);
});

/* ─────────────────────────────── the tests ──────────────────────────────── */

describe("Budget cards — two per-project caps on the same category", () => {
  it("names the project on each card, so the two are not identical", () => {
    render(<BudgetsClient budgets={TWO_SALARIES_CAPS} projects={PROJECTS} />);

    const cards = screen.getAllByRole("article");
    expect(cards).toHaveLength(2);

    const alpha = cards.filter((c) => (c.textContent ?? "").includes("Alpha"));
    const beta = cards.filter((c) => (c.textContent ?? "").includes("Beta"));
    expect(alpha).toHaveLength(1);
    expect(beta).toHaveLength(1);

    // Both still say what they cap; the project is additional, not a swap.
    expect(within(alpha[0]).getByRole("heading").textContent).toContain("Salaries");
    expect(within(beta[0]).getByRole("heading").textContent).toContain("Salaries");
  });

  it("tells a screen reader which project the progress bar belongs to", () => {
    render(<BudgetsClient budgets={TWO_SALARIES_CAPS} projects={PROJECTS} />);

    // One bar per project, each findable by its own accessible name.
    expect(
      screen.getByRole("progressbar", { name: /Salaries.*Alpha|Alpha.*Salaries/ })
    ).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: /Salaries.*Beta|Beta.*Salaries/ })).toBeTruthy();
  });

  it("gives each delete button its own accessible name", () => {
    render(<BudgetsClient budgets={TWO_SALARIES_CAPS} projects={PROJECTS} />);

    const deletes = screen.getAllByRole("button", { name: /^Delete /i });
    expect(deletes).toHaveLength(2);
    const names = deletes.map((b) => b.getAttribute("aria-label") ?? "");
    // The defect: both read "Delete Salaries budget".
    expect(new Set(names).size).toBe(2);
    expect(names.filter((n) => /Alpha/.test(n))).toHaveLength(1);
    expect(names.filter((n) => /Beta/.test(n))).toHaveLength(1);
  });

  it("gives each pause button its own accessible name too", () => {
    // The pause control sits in the same row and mutates the same row; "Pause
    // budget" twice is the same ambiguity as "Delete Salaries budget" twice,
    // only less expensive to get wrong.
    render(<BudgetsClient budgets={TWO_SALARIES_CAPS} projects={PROJECTS} />);

    const pauses = screen.getAllByRole("button", { name: /^(Pause|Resume) /i });
    expect(pauses).toHaveLength(2);
    const names = pauses.map((b) => b.getAttribute("aria-label") ?? "");
    expect(new Set(names).size).toBe(2);
    expect(names.filter((n) => /Alpha/.test(n))).toHaveLength(1);
    expect(names.filter((n) => /Beta/.test(n))).toHaveLength(1);
  });

  it("names the project in the delete confirmation", async () => {
    const user = userEvent.setup();
    render(<BudgetsClient budgets={TWO_SALARIES_CAPS} projects={PROJECTS} />);

    const betaDelete = screen
      .getAllByRole("button", { name: /^Delete /i })
      .filter((b) => /Beta/.test(b.getAttribute("aria-label") ?? ""))[0];
    expect(betaDelete).toBeTruthy();

    await user.click(betaDelete);

    expect(spies.confirm).toHaveBeenCalledTimes(1);
    const opts = spies.confirm.mock.calls[0][0] as ConfirmOptions;
    expect(opts.title).toContain("Beta");
    expect(opts.title).toContain("Salaries");
    // Answered "no": nothing is deleted on a dialog the user cancels.
    expect(spies.deleteBudgetAction).not.toHaveBeenCalled();
  });
});

describe("New budget — a forced category change is never silent", () => {
  it("says so when switching project moves the chosen category", async () => {
    const user = userEvent.setup();
    render(
      <BudgetsClient
        budgets={[budget({ id: "b-beta", projectId: "p-beta", projectName: "Beta" })]}
        projects={PROJECTS}
      />
    );

    const { project, category } = await openForm(user);

    // Alpha caps nothing, so Salaries is pickable there.
    await user.selectOptions(project, "p-alpha");
    await user.selectOptions(category, "Salaries");
    expect(category.value).toBe("Salaries");

    // Beta already caps Salaries, so the form has to move off it. It must not
    // do that without a word: the user chose Salaries.
    await user.selectOptions(project, "p-beta");
    expect(category.value).not.toBe("Salaries");

    const note = screen.getByTestId("category-switch-note").textContent ?? "";
    expect(note).toContain("Salaries");
    expect(note).toContain("Beta");
    expect(note).toContain(category.value);
  });

  it("drops the note again once the user picks a category themselves", async () => {
    const user = userEvent.setup();
    render(
      <BudgetsClient
        budgets={[budget({ id: "b-beta", projectId: "p-beta", projectName: "Beta" })]}
        projects={PROJECTS}
      />
    );

    const { project, category } = await openForm(user);
    await user.selectOptions(project, "p-alpha");
    await user.selectOptions(category, "Salaries");
    await user.selectOptions(project, "p-beta");
    expect(screen.queryByTestId("category-switch-note")).not.toBeNull();

    await user.selectOptions(category, "Marketing");
    expect(screen.queryByTestId("category-switch-note")).toBeNull();
  });

  it("refuses to offer a submit the server is guaranteed to reject", async () => {
    const user = userEvent.setup();
    // Every category capped in Beta — `firstFreeCategory` used to fall back to
    // EXPENSE_CATEGORIES[0], i.e. park the form on a disabled option whose
    // submit `createBudgetAction` answers "already exists in this project".
    const allOfBeta = EXPENSE_CATEGORIES.map((category, i) =>
      budget({ id: `b-${i}`, projectId: "p-beta", projectName: "Beta", category })
    );
    render(<BudgetsClient budgets={allOfBeta} projects={PROJECTS} />);

    const { project } = await openForm(user);
    await user.selectOptions(project, "p-beta");

    expect(screen.getByTestId("no-category-left").textContent).toContain("Beta");
    expect(screen.getByRole("button", { name: /Create budget/i })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: /Create budget/i }));
    expect(spies.createBudgetAction).not.toHaveBeenCalled();
  });
});
