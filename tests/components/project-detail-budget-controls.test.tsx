/**
 * finance-planning-010 — the supervisor escape hatch covers budgets, so there
 * has to be somewhere to use it.
 *
 * All three budget endpoints gate on `canManageProject`
 * (lib/actions/budgets.ts: createBudgetAction, updateBudgetAction,
 * deleteBudgetAction), which returns true for a MEMBER who is this project's
 * supervisor (lib/auth/project-permissions.ts) — and that module's own header
 * documents the hatch as "manage their own project (tasks, budgets, status)".
 *
 * WHAT WAS WRONG. The Budgets section of /projects/[id] was a read-only list of
 * bars. Its single affordance was the company-wide "All company budgets →"
 * link, which projects-003 correctly hid from members because /budgets is in
 * MEMBER_BLOCKED_ROUTES — leaving the one role the hatch exists for with
 * nothing at all in that section. `grep -rn createBudgetAction app components
 * lib` returned exactly one caller, on the page that role cannot open. So two
 * thirds of the documented hatch (tasks, status) had a control and the budget
 * third did not: a member-supervisor could watch their caps fill up and had to
 * ask an admin to change one.
 *
 * THE CONTRACT, in the shape the Tasks section one block above already has
 * (projects-007):
 *
 *   1. "New budget" is drawn for whoever `createBudgetAction` accepts —
 *      `canManageProject` — and for nobody else. Not for a member who merely
 *      holds a task here, and not on an archived project, which that action
 *      refuses outright ("Can't add budgets to an archived project").
 *   2. The form it opens is locked to THIS project, like the New-task modal's
 *      `forcedProjectId`, and posts this project's id.
 *   3. It offers every category this project has not already capped, and only
 *      the ones it has are disabled — a cap on the same category in another
 *      project is none of this form's business (money-018).
 *   4. Each cap can be corrected, paused/resumed and deleted in place, because
 *      `updateBudgetAction` and `deleteBudgetAction` accept exactly the same
 *      caller. Create alone would be a trap: the create form disables a
 *      category this project has already capped, so a supervisor who typed the
 *      wrong number once could never reach the right one.
 *
 * The negative cases render a member who does NOT supervise this project WITH
 * `canSeeBudgets` true. app/(app)/projects/[id]/page.tsx cannot produce that
 * combination today (`canSeeProjectFinances` is the supervisor hatch itself),
 * and that is the point: it pins the controls to the MANAGE predicate rather
 * than to the section's visibility, so widening the read gate for a future
 * finance-capable role cannot hand that role write controls by accident.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";
import type { ProjectOverview } from "@/lib/queries/projects";
import type { BudgetWithSpend } from "@/lib/queries/budgets";
import type { Role } from "@/lib/auth/role-gates";
import type { User } from "@/lib/types";
import { ProjectDetailClient } from "@/app/(app)/projects/[id]/project-detail-client";

/* ───────────────────────────── module mocks ─────────────────────────────── */

const spies = vi.hoisted(() => ({
  createBudgetAction: vi.fn(),
  updateBudgetAction: vi.fn(),
  deleteBudgetAction: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/lib/actions/budgets", () => ({
  createBudgetAction: (input: unknown) => spies.createBudgetAction(input),
  updateBudgetAction: (input: unknown) => spies.updateBudgetAction(input),
  deleteBudgetAction: (id: string) => spies.deleteBudgetAction(id),
}));
vi.mock("@/lib/actions/projects", () => ({
  updateProjectAction: vi.fn(),
  deleteProjectAction: vi.fn(),
}));
vi.mock("@/lib/actions/tasks", () => ({
  updateTaskStatusAction: vi.fn(),
  deleteTaskAction: vi.fn(),
  addTaskAction: vi.fn(),
}));
// The task detail modal pulls in lib/actions/comments, which imports lib/auth —
// next-auth's server entry does not resolve under vitest. Never opened here.
vi.mock("@/lib/actions/comments", () => ({
  listCommentsAction: vi.fn(async () => ({ success: true, data: [] })),
  addCommentAction: vi.fn(),
  deleteCommentAction: vi.fn(),
}));
vi.mock("react-hot-toast", () => ({
  default: Object.assign(vi.fn(), { error: spies.toastError, success: spies.toastSuccess }),
}));
// Delete asks for confirmation; the tests here are about what happens once the
// user has said yes.
vi.mock("@/components/ui/confirm-dialog", () => ({
  useConfirm: () => async () => true,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: { href: string; children: React.ReactNode } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
// The real dictionary; only the store is faked, because useT/useMoney/useCurrency
// read the locale and currency from it.
vi.mock("@/lib/store", () => ({
  useStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ locale: "en", currentCompany: { id: "c-1", currency: "PKR" } }),
  useStoreHasHydrated: () => true,
}));

/* ────────────────────────────── fixtures ────────────────────────────────── */

const PROJECT: ProjectOverview = {
  id: "p-1",
  companyId: "c-1",
  name: "Nimbus",
  description: "a description",
  supervisorId: "u-sup",
  supervisorName: "Bilal",
  status: "active",
  color: "emerald",
  targetEndDate: null,
  createdBy: "u-admin",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-09-29T08:00:00.000Z",
  openTaskCount: 1,
  totalTaskCount: 3,
  monthToDateSpendPkr: 0,
  financeVisible: true,
  trackedMs: 0,
  memberCount: 2,
};

const USERS: User[] = [];

function budget(over: Partial<BudgetWithSpend> & { id: string }): BudgetWithSpend {
  return {
    companyId: "c-1",
    projectId: "p-1",
    projectName: "Nimbus",
    category: "Salaries",
    monthlyLimit: 100000,
    createdBy: "u-admin",
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

const SALARIES_CAP = [budget({ id: "b-1" })];

/** The member who supervises this project: the whole point of the hatch. */
const SUPERVISOR = { role: "member" as Role, userId: "u-sup", canSeeBudgets: true };
/** A member who merely holds a task here — see the header for why canSeeBudgets. */
const PLAIN_MEMBER = { role: "member" as Role, userId: "u-member", canSeeBudgets: true };

function renderPage(
  opts: {
    project?: Partial<ProjectOverview>;
    budgets?: BudgetWithSpend[];
    role?: Role;
    userId?: string;
    canSeeBudgets?: boolean;
  } = {}
) {
  return render(
    <ProjectDetailClient
      project={{ ...PROJECT, ...opts.project }}
      tasks={[]}
      budgets={opts.budgets ?? []}
      users={USERS}
      canSeeBudgets={opts.canSeeBudgets ?? true}
      currentUserId={opts.userId ?? "u-admin"}
      currentUserRole={opts.role ?? "admin"}
    />
  );
}

beforeEach(() => {
  spies.createBudgetAction.mockReset();
  spies.createBudgetAction.mockResolvedValue({ success: true, data: { id: "b-new" } });
  spies.updateBudgetAction.mockReset();
  spies.updateBudgetAction.mockResolvedValue({ success: true, data: undefined });
  spies.deleteBudgetAction.mockReset();
  spies.deleteBudgetAction.mockResolvedValue({ success: true, data: undefined });
  spies.toastError.mockReset();
  spies.toastSuccess.mockReset();
});

/* ─────────────────────── 1. who is offered the control ──────────────────── */

describe("finance-planning-010 — New budget is offered to whoever createBudgetAction accepts", () => {
  it("is there for a member who IS this project's supervisor", () => {
    renderPage(SUPERVISOR);

    expect(
      screen.queryByRole("button", { name: /new budget/i }),
      "the member-supervisor is authorised by createBudgetAction and has no way to call it: " +
        "the Budgets section of their own project offers them nothing at all"
    ).not.toBeNull();
  });

  it("is there for an admin", () => {
    renderPage({ role: "admin" });

    expect(screen.queryByRole("button", { name: /new budget/i })).not.toBeNull();
  });

  it("is absent for a member who does not supervise this project", () => {
    renderPage(PLAIN_MEMBER);

    expect(
      screen.queryByRole("button", { name: /new budget/i }),
      "a plain member would fill in the form and be refused with 'Only the supervisor or a " +
        "founder can add budgets here'"
    ).toBeNull();
  });

  it("is absent on an archived project even for an admin", () => {
    // createBudgetAction refuses outright: "Can't add budgets to an archived
    // project". Same rule the New-task button already follows.
    renderPage({ role: "admin", project: { status: "archived" } });

    expect(screen.queryByRole("button", { name: /new budget/i })).toBeNull();
  });
});

/* ──────────────────────── 2. the form it opens ──────────────────────────── */

describe("finance-planning-010 — the project-scoped create form", () => {
  it("is locked to this project and posts its id", async () => {
    const user = userEvent.setup();
    renderPage(SUPERVISOR);

    await user.click(screen.getByRole("button", { name: /new budget/i }));

    const picker = (await screen.findByRole("combobox", { name: /project/i })) as HTMLSelectElement;
    expect(picker.value).toBe("p-1");
    expect(
      picker.disabled,
      "the project field is editable inside one project's page, so a cap can be filed " +
        "against a project this form was not opened from"
    ).toBe(true);

    const cap = screen.getByRole("spinbutton", { name: /monthly cap/i });
    await user.type(cap, "50000");
    await user.click(screen.getByRole("button", { name: /create budget/i }));

    await waitFor(() => expect(spies.createBudgetAction).toHaveBeenCalledTimes(1));
    expect(spies.createBudgetAction.mock.calls[0][0]).toEqual({
      projectId: "p-1",
      category: "Office Rent",
      monthlyLimit: 50000,
    });
  });

  it("disables only the categories already capped in THIS project", async () => {
    const user = userEvent.setup();
    renderPage({ ...SUPERVISOR, budgets: SALARIES_CAP });

    await user.click(screen.getByRole("button", { name: /new budget/i }));
    await screen.findByRole("combobox", { name: /category/i });

    const salaries = screen.getByRole("option", { name: /^Salaries/ }) as HTMLOptionElement;
    const marketing = screen.getByRole("option", { name: /^Marketing/ }) as HTMLOptionElement;
    expect(salaries.disabled, "this project already caps Salaries").toBe(true);
    expect(
      marketing.disabled,
      "Marketing is uncapped in this project, so the form must offer it"
    ).toBe(false);
  });
});

/* ───────────────── 3. correcting, pausing and deleting a cap ────────────── */

describe("finance-planning-010 — a cap can be corrected, paused and deleted in place", () => {
  it("posts the new cap for that row", async () => {
    const user = userEvent.setup();
    renderPage({ ...SUPERVISOR, budgets: SALARIES_CAP });

    await user.click(screen.getByRole("button", { name: /^Edit Salaries budget cap/i }));

    const field = (await screen.findByRole("spinbutton", {
      name: /monthly cap/i,
    })) as HTMLInputElement;
    // Seeded, not blank: this is an edit, not a retype from memory.
    expect(field.value).toBe("100000");
    await user.clear(field);
    await user.type(field, "250000");
    await user.click(screen.getByRole("button", { name: /save cap/i }));

    await waitFor(() => expect(spies.updateBudgetAction).toHaveBeenCalledTimes(1));
    expect(spies.updateBudgetAction.mock.calls[0][0]).toEqual({
      budgetId: "b-1",
      monthlyLimit: 250000,
    });
  });

  it("pauses an active cap", async () => {
    const user = userEvent.setup();
    renderPage({ ...SUPERVISOR, budgets: SALARIES_CAP });

    await user.click(screen.getByRole("button", { name: /^Pause Salaries budget/i }));

    await waitFor(() => expect(spies.updateBudgetAction).toHaveBeenCalledTimes(1));
    expect(spies.updateBudgetAction.mock.calls[0][0]).toEqual({
      budgetId: "b-1",
      active: false,
    });
  });

  it("resumes a paused cap, and says it is paused", async () => {
    const user = userEvent.setup();
    renderPage({ ...SUPERVISOR, budgets: [budget({ id: "b-1", active: false })] });

    // A paused cap rendered identically to an active one, so "Resume" would be
    // the only thing on screen saying the alerts are off.
    expect(screen.getByText(/paused/i)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /^Resume Salaries budget/i }));

    await waitFor(() => expect(spies.updateBudgetAction).toHaveBeenCalledTimes(1));
    expect(spies.updateBudgetAction.mock.calls[0][0]).toEqual({
      budgetId: "b-1",
      active: true,
    });
  });

  it("deletes a cap once the confirm is accepted", async () => {
    const user = userEvent.setup();
    renderPage({ ...SUPERVISOR, budgets: SALARIES_CAP });

    await user.click(screen.getByRole("button", { name: /^Delete Salaries budget/i }));

    await waitFor(() => expect(spies.deleteBudgetAction).toHaveBeenCalledTimes(1));
    expect(spies.deleteBudgetAction.mock.calls[0][0]).toBe("b-1");
  });

  it("offers none of the three to a member who does not supervise this project", () => {
    renderPage({ ...PLAIN_MEMBER, budgets: SALARIES_CAP });

    expect(screen.queryByRole("button", { name: /^Edit Salaries budget cap/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Pause Salaries budget/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Delete Salaries budget/i })).toBeNull();
  });
});
