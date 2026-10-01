/**
 * sec-016, the half that needs no product decision: /projects/[id] must not
 * offer a task control the server will refuse.
 *
 * tasks-and-comments-009 centralised "who may move or destroy a task" into
 * lib/tasks/task-permissions.ts and taught app/(app)/tasks/tasks-client.tsx to
 * render from it, so a cofounder sees a disabled select rather than a red toast.
 * The SECOND surface that renders the same <TaskDetailModal> —
 * app/(app)/projects/[id]/project-detail-client.tsx — was left behind: it
 * passed `canDelete` (hand-rolled, a third copy of `canDeleteTask`) and no
 * `canEdit` at all, and the prop defaulted to `true`. So on the one page a
 * founder tidying a project is actually on, the status <select> rendered
 * enabled with no title, and `updateTaskStatusAction` answered
 * `{ error: "Not authorized" }` → a bare toast.
 *
 * This is a NARROWING, not the widening sec-016 also raises: whether a
 * cofounder *should* be allowed to close anyone's task is the owner's call and
 * lives in tests/app/tasks/task-permissions.test.ts. This file only asserts
 * CLAUDE.md's standing rule — "Permission gates exist in two layers … Both must
 * agree" — on the surface where they did not.
 *
 * The assertions deliberately read the predicate rather than hard-coding
 * true/false per role, so that if the owner DOES widen `canEditTask`, this file
 * follows instead of blocking the change with a stale copy of the rule.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";
import type { ProjectOverview } from "@/lib/queries/projects";
import type { TaskWithCount } from "@/lib/queries/tasks";
import type { Role } from "@/lib/auth/role-gates";
import type { User } from "@/lib/types";
import { canDeleteTask, canEditTask } from "@/lib/tasks/task-permissions";
import { ProjectDetailClient } from "@/app/(app)/projects/[id]/project-detail-client";

const spies = vi.hoisted(() => ({
  updateTaskStatusAction: vi.fn(),
  deleteTaskAction: vi.fn(),
}));
vi.mock("@/lib/actions/projects", () => ({
  updateProjectAction: vi.fn(async () => ({ success: true, data: undefined })),
  deleteProjectAction: vi.fn(),
}));
vi.mock("@/lib/actions/tasks", () => ({
  updateTaskStatusAction: (input: unknown) => spies.updateTaskStatusAction(input),
  deleteTaskAction: (id: string) => spies.deleteTaskAction(id),
  addTaskAction: vi.fn(),
}));
// The modal IS opened here, so the comment fetch has to answer. lib/actions/
// comments imports lib/auth, whose next-auth server entry does not resolve
// under vitest.
vi.mock("@/lib/actions/comments", () => ({
  listCommentsAction: vi.fn(async () => ({ success: true, data: [] })),
  addCommentAction: vi.fn(),
  deleteCommentAction: vi.fn(),
}));
vi.mock("react-hot-toast", () => ({
  default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));
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
vi.mock("@/lib/store", () => ({
  useStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ locale: "en", currentCompany: { id: "c-1", currency: "PKR" } }),
  useStoreHasHydrated: () => true,
}));

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

/** Assigned to Ayesha, filed by Ayesha: neither column names the viewer. */
const SOMEONE_ELSES: TaskWithCount = {
  id: "t-1",
  companyId: "c-1",
  projectId: "p-1",
  projectName: "Nimbus",
  title: "Ayesha's migration",
  description: "the body",
  status: "pending",
  priority: "high",
  assignedTo: "u-ayesha",
  assignedToName: "Ayesha",
  assignedBy: "u-ayesha",
  assignedByName: "Ayesha",
  deadline: "2026-12-01T00:00:00.000Z",
  createdAt: "2026-09-01T00:00:00.000Z",
  order: 0,
  commentCount: 0,
};

const MINE: TaskWithCount = {
  ...SOMEONE_ELSES,
  id: "t-2",
  title: "My own work",
  assignedTo: "u-co",
  assignedToName: "Zara",
  assignedBy: "u-co",
  assignedByName: "Zara",
};

function renderPage(opts: { role: Role; userId: string; tasks: TaskWithCount[] }) {
  return render(
    <ProjectDetailClient
      project={PROJECT}
      tasks={opts.tasks}
      budgets={[]}
      users={[] as User[]}
      canSeeBudgets={false}
      currentUserId={opts.userId}
      currentUserRole={opts.role}
    />
  );
}

async function openDetail(title: string) {
  const userEv = userEvent.setup();
  await userEv.click(screen.getByRole("button", { name: `Open task ${title}` }));
  return { userEv, dialog: await screen.findByRole("dialog") };
}

beforeEach(() => {
  spies.updateTaskStatusAction.mockReset();
  spies.updateTaskStatusAction.mockResolvedValue({ success: false, error: "Not authorized" });
  spies.deleteTaskAction.mockReset();
});

describe("sec-016 — the project page's task modal matches updateTaskStatusAction", () => {
  it("disables the status select for a cofounder on a task owned by neither party", async () => {
    const actor = { userId: "u-co", role: "cofounder" as Role };
    // Guard the guard: if the owner ever widens canEditTask, this case stops
    // being about a refused control and the assertion below would be vacuous.
    expect(
      canEditTask({ actor, task: SOMEONE_ELSES }),
      "fixture no longer models a task the server refuses — pick one canEditTask rejects"
    ).toBe(false);

    renderPage({ role: "cofounder", userId: "u-co", tasks: [SOMEONE_ELSES] });
    const { dialog } = await openDetail("Ayesha's migration");

    expect(
      within(dialog).getByLabelText("Change status"),
      "the project page offers an enabled status select to a viewer updateTaskStatusAction will refuse with a bare 'Not authorized' toast"
    ).toBeDisabled();
  });

  it("explains why, rather than leaving title undefined", async () => {
    renderPage({ role: "cofounder", userId: "u-co", tasks: [SOMEONE_ELSES] });
    const { dialog } = await openDetail("Ayesha's migration");

    // `?? ""` because the bug's signature is a MISSING title, and toMatch on
    // null throws a type error instead of the assertion message.
    expect(
      within(dialog).getByLabelText("Change status").getAttribute("title") ?? "",
      "the select is unusable with no explanation of why"
    ).toMatch(/assignee|filed it|admin/i);
  });

  it("never reaches updateTaskStatusAction for that viewer", async () => {
    renderPage({ role: "cofounder", userId: "u-co", tasks: [SOMEONE_ELSES] });
    const { userEv, dialog } = await openDetail("Ayesha's migration");

    // userEvent refuses to drive a disabled control, so this throws once the
    // narrowing lands — which is the point. Before it, the change goes through
    // to the server and comes back "Not authorized".
    await userEv
      .selectOptions(within(dialog).getByLabelText("Change status"), "completed")
      .catch(() => {});

    expect(spies.updateTaskStatusAction).not.toHaveBeenCalled();
  });

  it("leaves the select enabled on the viewer's own task", async () => {
    const actor = { userId: "u-co", role: "cofounder" as Role };
    expect(canEditTask({ actor, task: MINE })).toBe(true);

    renderPage({ role: "cofounder", userId: "u-co", tasks: [MINE] });
    const { dialog } = await openDetail("My own work");

    expect(
      within(dialog).getByLabelText("Change status"),
      "the narrowing went too far: a cofounder can no longer move the task they filed"
    ).toBeEnabled();
  });

  it("leaves the select enabled for an admin on anyone's task", async () => {
    renderPage({ role: "admin", userId: "u-admin", tasks: [SOMEONE_ELSES] });
    const { dialog } = await openDetail("Ayesha's migration");

    expect(within(dialog).getByLabelText("Change status")).toBeEnabled();
  });
});

/**
 * The Delete button's accessible name comes from its `aria-label`
 * ("Delete task <title>"), not its visible text, so every query below asks for
 * that — a `/^Delete$/` matcher finds nothing either way and would make the
 * "hidden" case pass against the broken code.
 */
describe("sec-016 — and its Delete button reads canDeleteTask, not a local copy", () => {
  it("hides Delete from a cofounder on a task they did not file", async () => {
    const actor = { userId: "u-co", role: "cofounder" as Role };
    expect(canDeleteTask({ actor, task: SOMEONE_ELSES })).toBe(false);

    renderPage({ role: "cofounder", userId: "u-co", tasks: [SOMEONE_ELSES] });
    const { dialog } = await openDetail("Ayesha's migration");

    expect(
      within(dialog).queryByRole("button", { name: "Delete task Ayesha's migration" })
    ).toBeNull();
  });

  it("offers Delete on a task they filed", async () => {
    renderPage({ role: "cofounder", userId: "u-co", tasks: [MINE] });
    const { dialog } = await openDetail("My own work");

    expect(within(dialog).getByRole("button", { name: "Delete task My own work" })).toBeTruthy();
  });

  it("offers Delete to an admin on anyone's task", async () => {
    renderPage({ role: "admin", userId: "u-admin", tasks: [SOMEONE_ELSES] });
    const { dialog } = await openDetail("Ayesha's migration");

    expect(
      within(dialog).getByRole("button", { name: "Delete task Ayesha's migration" })
    ).toBeTruthy();
  });
});
