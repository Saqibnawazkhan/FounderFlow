/**
 * projects-010, the wiring half: the three header buttons that set a status
 * must SEND only a status.
 *
 * `updateProjectAction` was taught to leave a column alone when the payload does
 * not mention it. That is a capability, not a fix — and this repo's most
 * productive defect is precisely a capability with no caller
 * (tests/lib/architecture/decision-reachability.test.ts). The three callers live
 * here, and all three still sent a full client-side snapshot of name,
 * description, colour and target date, read from the props this page was MOUNTED
 * with. So the narrow-write work changed nothing a customer could feel:
 *
 *   Ada renames "Nimbus" to "Nimbus — Q4 launch".
 *   Bilal, whose tab has been open since this morning, picks "Completed".
 *   The project is called "Nimbus" again. No error, no toast.
 *
 * These tests assert the PAYLOAD, because the payload is the whole contract
 * between this component and the action. An assertion that the request
 * "succeeded" would pass just as well while carrying the four stale fields.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";
import type { ProjectOverview } from "@/lib/queries/projects";
import type { User } from "@/lib/types";
import { ProjectDetailClient } from "@/app/(app)/projects/[id]/project-detail-client";

const spies = vi.hoisted(() => ({
  updateProjectAction: vi.fn(),
  deleteProjectAction: vi.fn(),
}));
vi.mock("@/lib/actions/projects", () => ({
  updateProjectAction: (input: unknown) => spies.updateProjectAction(input),
  deleteProjectAction: (id: string) => spies.deleteProjectAction(id),
}));
vi.mock("@/lib/actions/tasks", () => ({
  updateTaskStatusAction: vi.fn(),
  deleteTaskAction: vi.fn(),
}));

// Same reason as the comments stub below: the Budgets section's controls call
// lib/actions/budgets (finance-planning-010), which imports lib/auth. Nothing
// here clicks one.
vi.mock("@/lib/actions/budgets", () => ({
  createBudgetAction: vi.fn(),
  updateBudgetAction: vi.fn(),
  deleteBudgetAction: vi.fn(),
}));

// The task detail modal pulls in lib/actions/comments, which imports
// lib/auth — next-auth's server entry point does not resolve under vitest.
// The modal is never opened here, so a stub is enough.
vi.mock("@/lib/actions/comments", () => ({
  listCommentsAction: vi.fn(async () => ({ success: true, data: [] })),
  addCommentAction: vi.fn(),
  deleteCommentAction: vi.fn(),
}));

vi.mock("react-hot-toast", () => ({
  default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));

// Archive asks for confirmation; these tests are about what is sent once the
// user has said yes, so the dialog always answers yes.
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

// The real dictionary; only the store is faked, because useT/useMoney read the
// locale and currency from it.
vi.mock("@/lib/store", () => ({
  useStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ locale: "en", currentCompany: { id: "c-1", currency: "PKR" } }),
  useStoreHasHydrated: () => true,
}));

const PROJECT: ProjectOverview = {
  id: "p-1",
  companyId: "c-1",
  name: "Nimbus",
  description: "the description this tab was rendered with",
  supervisorId: "u-2",
  supervisorName: "Bilal",
  status: "active",
  color: "emerald",
  targetEndDate: "2026-12-31T00:00:00.000Z",
  createdBy: "u-1",
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

function renderPage(project: ProjectOverview = PROJECT) {
  return render(
    <ProjectDetailClient
      project={project}
      tasks={[]}
      budgets={[]}
      users={USERS}
      canSeeBudgets
      currentUserId="u-1"
      // admin, so the header's manage controls are all on screen.
      currentUserRole="admin"
    />
  );
}

/** The single argument the component handed the server action. */
function payload(): Record<string, unknown> {
  return spies.updateProjectAction.mock.calls[0][0] as Record<string, unknown>;
}

/** Every project column a status click has no business restating. */
const NOT_ITS_BUSINESS = ["name", "description", "color", "targetEndDate"];

beforeEach(() => {
  spies.updateProjectAction.mockReset();
  spies.updateProjectAction.mockResolvedValue({ success: true, data: undefined });
  spies.deleteProjectAction.mockReset();
});

describe("the header's status controls send a status and nothing else", () => {
  it('picking "Completed" writes only the status', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: /^status/i }));
    await user.click(await screen.findByRole("menuitem", { name: /completed/i }));

    await waitFor(() => expect(spies.updateProjectAction).toHaveBeenCalledTimes(1));
    expect(payload().status).toBe("completed");
    for (const field of NOT_ITS_BUSINESS) {
      expect(
        Object.prototype.hasOwnProperty.call(payload(), field),
        `marking a project Completed also sends ${field}, taken from the props this tab was mounted with — so a colleague's edit to ${field} is silently reverted`
      ).toBe(false);
    }
  });

  it("Archive writes only the status", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: "Archive" }));

    await waitFor(() => expect(spies.updateProjectAction).toHaveBeenCalledTimes(1));
    expect(payload().status).toBe("archived");
    for (const field of NOT_ITS_BUSINESS) {
      expect(
        Object.prototype.hasOwnProperty.call(payload(), field),
        `archiving also sends ${field} from a stale snapshot`
      ).toBe(false);
    }
  });

  it("Restore writes only the status", async () => {
    const user = userEvent.setup();
    renderPage({ ...PROJECT, status: "archived" });

    await user.click(screen.getByRole("button", { name: "Restore" }));

    await waitFor(() => expect(spies.updateProjectAction).toHaveBeenCalledTimes(1));
    expect(payload().status).toBe("active");
    for (const field of NOT_ITS_BUSINESS) {
      expect(
        Object.prototype.hasOwnProperty.call(payload(), field),
        `restoring also sends ${field} from a stale snapshot`
      ).toBe(false);
    }
  });

  it("identifies the project it is changing", async () => {
    // The narrowing must not go so far that the action cannot find the row.
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: "Archive" }));

    await waitFor(() => expect(spies.updateProjectAction).toHaveBeenCalledTimes(1));
    expect(payload().projectId).toBe("p-1");
  });
});
