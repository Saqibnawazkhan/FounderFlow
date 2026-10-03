/**
 * money-018 — the New budget form must offer exactly what the server accepts.
 *
 * `createBudgetAction` scopes its uniqueness check to
 * `{ projectId, category, active: true, deletedAt: null }`
 * (lib/actions/budgets.ts:74) and says so in the error it returns: `A budget for
 * "X" already exists in this project.` Two projects may each cap Salaries — that
 * is the whole point of `Budget.projectId` being NOT NULL after add_projects.
 *
 * The form disagreed with it. `takenCategories` was built from EVERY active
 * budget in the company and the category `<option>` was rendered
 * `disabled={takenCategories.has(c)}` with " (already set)" appended, with no
 * regard for which project the form was targeting. One Salaries cap anywhere in
 * the workspace made Salaries unpickable for every other project forever, so
 * per-project budgeting was unusable beyond the first project for any of the
 * categories a startup actually shares — Salaries, Software, Office Rent.
 *
 * The contract below is therefore two-sided, because the cheap "fix" of deleting
 * the disabled flag would trade this bug for the duplicate-submit it was added
 * to prevent:
 *   1. a category capped in ANOTHER project stays pickable here;
 *   2. a category capped in THIS project stays disabled;
 *   3. switching project never leaves the form sitting on a disabled option —
 *      i.e. a submit the server is guaranteed to reject.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BudgetsClient } from "@/app/(app)/budgets/budgets-client";
import type { BudgetWithSpend } from "@/lib/queries/budgets";

/* ───────────────────────────── module mocks ─────────────────────────────── */

const spies = vi.hoisted(() => ({ createBudgetAction: vi.fn() }));
vi.mock("@/lib/actions/budgets", () => ({
  createBudgetAction: (input: unknown) => spies.createBudgetAction(input),
  updateBudgetAction: vi.fn(async () => ({ success: true, data: undefined })),
  deleteBudgetAction: vi.fn(async () => ({ success: true, data: undefined })),
}));

vi.mock("react-hot-toast", () => ({
  default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));

vi.mock("@/components/ui/confirm-dialog", () => ({
  useConfirm: () => async () => true,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

// useMoney / useNumberFormat read the workspace currency and locale from the
// store. Pinned so the cards render deterministically; nothing here asserts on
// them.
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

/** Opens the New budget modal and hands back the two selects. */
async function openForm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /New budget/i }));
  const project = (await screen.findByLabelText("Project")) as HTMLSelectElement;
  const category = screen.getByLabelText("Category") as HTMLSelectElement;
  return { project, category };
}

function option(select: HTMLSelectElement, value: string): HTMLOptionElement {
  const el = select.querySelector<HTMLOptionElement>(`option[value="${value}"]`);
  if (!el) throw new Error(`no <option value="${value}"> in the category select`);
  return el;
}

beforeEach(() => {
  spies.createBudgetAction.mockReset();
  spies.createBudgetAction.mockResolvedValue({ success: true, data: { id: "b-new" } });
});

/* ─────────────────────────────── the tests ──────────────────────────────── */

describe("New budget — category availability is per project", () => {
  it("offers a category that only ANOTHER project has capped, and files it", async () => {
    const user = userEvent.setup();
    render(
      <BudgetsClient budgets={[budget({ id: "b-1", projectId: "p-alpha" })]} projects={PROJECTS} />
    );

    const { project, category } = await openForm(user);

    // Beta has no budgets at all, so Salaries is free there.
    await user.selectOptions(project, "p-beta");

    const salaries = option(category, "Salaries");
    expect(salaries.disabled).toBe(false);
    expect(salaries.textContent).toBe("Salaries");

    await user.selectOptions(category, "Salaries");
    await user.type(screen.getByLabelText("Monthly cap (PKR)"), "50000");
    await user.click(screen.getByRole("button", { name: /Create budget/i }));

    await waitFor(() => expect(spies.createBudgetAction).toHaveBeenCalledTimes(1));
    expect(spies.createBudgetAction).toHaveBeenCalledWith({
      projectId: "p-beta",
      category: "Salaries",
      monthlyLimit: 50000,
    });
  });

  it("still disables a category THIS project has already capped", async () => {
    const user = userEvent.setup();
    render(
      <BudgetsClient budgets={[budget({ id: "b-1", projectId: "p-alpha" })]} projects={PROJECTS} />
    );

    const { project, category } = await openForm(user);
    await user.selectOptions(project, "p-alpha");

    const salaries = option(category, "Salaries");
    expect(salaries.disabled).toBe(true);
    expect(salaries.textContent).toBe("Salaries (already set in this project)");
  });

  it("a paused budget frees its category again, in its own project", async () => {
    const user = userEvent.setup();
    render(
      <BudgetsClient
        budgets={[budget({ id: "b-1", projectId: "p-alpha", active: false })]}
        projects={PROJECTS}
      />
    );

    const { project, category } = await openForm(user);
    await user.selectOptions(project, "p-alpha");
    expect(option(category, "Salaries").disabled).toBe(false);
  });

  it("never leaves the form on a disabled category after the project changes", async () => {
    const user = userEvent.setup();
    render(
      <BudgetsClient
        budgets={[
          budget({ id: "b-1", projectId: "p-alpha", category: "Office Rent" }),
          budget({ id: "b-2", projectId: "p-beta", category: "Salaries" }),
        ]}
        projects={PROJECTS}
      />
    );

    const { project, category } = await openForm(user);

    // Alpha caps Office Rent, so the form opens on something else.
    expect(option(category, category.value).disabled).toBe(false);

    await user.selectOptions(project, "p-beta");
    // Beta caps Salaries. Whatever the form now holds, it must be submittable.
    expect(option(category, category.value).disabled).toBe(false);
    expect(category.value).not.toBe("Salaries");

    await user.selectOptions(project, "p-alpha");
    expect(option(category, category.value).disabled).toBe(false);
    expect(category.value).not.toBe("Office Rent");
  });
});
