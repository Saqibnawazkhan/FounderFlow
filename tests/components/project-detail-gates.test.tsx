/**
 * The project detail header and its two mis-gated affordances, plus the colour
 * stripe that disagrees with the card it was clicked from.
 *
 * FOUR CONTRACTS, all about `app/(app)/projects/[id]/project-detail-client.tsx`:
 *
 *   projects-003  A link the app renders goes somewhere the viewer is allowed
 *                 to go. "All company budgets →" sits inside the Budgets
 *                 section, which is shown whenever `canSeeBudgets` is true —
 *                 and `canSeeProjectFinances` makes that true for a MEMBER who
 *                 supervises this project. `/budgets` is in
 *                 MEMBER_BLOCKED_ROUTES, so auth.config.ts bounces role
 *                 "member" to /tasks. The escape hatch is documented as
 *                 per-project only ("CANNOT reach the global /budgets …",
 *                 lib/auth/project-permissions.ts), so the link contradicts the
 *                 permission model it is rendered inside.
 *
 *   projects-007  The "New task" button is offered to whoever can OPEN the
 *                 project, but `addTaskAction` only accepts admin, cofounder or
 *                 this project's supervisor. A plain member holding one task
 *                 here fills in five fields and gets a red toast.
 *
 *   projects-004  The header stripe and the grid card must paint the same
 *                 colour. The card reads COLOR_CLASSES (five slugs, matching
 *                 PROJECT_COLORS); the header had its own map keyed on the
 *                 slugs the 20260923000000_rebrand_project_colors migration
 *                 retired, with no `slate` entry at all. The loop below asserts
 *                 agreement for every slug rather than a hand-copied class, so
 *                 a sixth palette entry cannot be added to one map only.
 *
 *   projects-012  A destructive header button must not fire twice on a
 *                 double-click. The two clicks below are dispatched
 *                 SYNCHRONOUSLY, in one task, which is what a real double-click
 *                 is — so a `useState` flag alone cannot pass this: the
 *                 re-render that would apply `disabled` has not happened when
 *                 the second handler runs. Only a guard that updates
 *                 synchronously does.
 *
 * Plus the residue of projects-002: STATUS_LABEL_KEY was extracted so "the
 * other three sites import one source of truth", and none of them did. This
 * file pins the one of those three that is a header pill.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";
import type { ProjectOverview } from "@/lib/queries/projects";
import type { Role } from "@/lib/auth/role-gates";
import type { User } from "@/lib/types";
import { PROJECT_COLORS } from "@/lib/schemas/project";
import { COLOR_CLASSES } from "@/components/projects/project-card";
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
  default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));
// Archive asks for confirmation; every test here is about what happens once the
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

function renderPage(
  opts: {
    project?: Partial<ProjectOverview>;
    role?: Role;
    userId?: string;
    canSeeBudgets?: boolean;
  } = {}
) {
  return render(
    <ProjectDetailClient
      project={{ ...PROJECT, ...opts.project }}
      tasks={[]}
      budgets={[]}
      users={USERS}
      canSeeBudgets={opts.canSeeBudgets ?? true}
      currentUserId={opts.userId ?? "u-admin"}
      currentUserRole={opts.role ?? "admin"}
    />
  );
}

/** The header's decorative colour stripe: the first aria-hidden span inside it. */
function headerStripeClass(container: HTMLElement): string {
  const stripe = container.querySelector('header > span[aria-hidden="true"]');
  if (!stripe) throw new Error("no header colour stripe rendered");
  return stripe.className;
}

beforeEach(() => {
  spies.updateProjectAction.mockReset();
  spies.updateProjectAction.mockResolvedValue({ success: true, data: undefined });
  spies.deleteProjectAction.mockReset();
});

describe("projects-003 — the company-budgets link is only offered to people /budgets admits", () => {
  it("is absent for a member who supervises this project", () => {
    // Exactly what app/(app)/projects/[id]/page.tsx passes for this user:
    // canSeeProjectFinances is true via the supervisor escape hatch, so the
    // Budgets SECTION is right to render. The company-wide link is not.
    renderPage({ role: "member", userId: "u-sup", canSeeBudgets: true });

    expect(
      screen.queryByRole("link", { name: /all company budgets/i }),
      "a member-supervisor is offered a link to /budgets, which auth.config.ts redirects role=member to /tasks — the one role the escape hatch exists for gets a broken link on its main screen"
    ).toBeNull();
  });

  it("still renders the project's own Budgets section for that member", () => {
    // The fix must gate the LINK, not the section: the per-project figures are
    // the whole point of the escape hatch.
    renderPage({ role: "member", userId: "u-sup", canSeeBudgets: true });

    expect(screen.getByText(/no budgets set for this project yet/i)).toBeTruthy();
  });

  it("is still there for an admin, who can reach /budgets", () => {
    renderPage({ role: "admin", canSeeBudgets: true });

    const link = screen.getByRole("link", { name: /all company budgets/i });
    expect(link.getAttribute("href")).toBe("/budgets");
  });

  it("is still there for a cofounder", () => {
    renderPage({ role: "cofounder", canSeeBudgets: true });

    expect(screen.getByRole("link", { name: /all company budgets/i })).toBeTruthy();
  });
});

describe("projects-007 — New task is offered only to whoever addTaskAction accepts", () => {
  it("is absent for a member who is not this project's supervisor", () => {
    renderPage({ role: "member", userId: "u-member", canSeeBudgets: false });

    expect(
      screen.queryByRole("button", { name: /new task/i }),
      "a plain member is invited to add a task, fills five fields, and addTaskAction then refuses with 'Only the supervisor or a founder can add tasks here'"
    ).toBeNull();
  });

  it("is there for a member who IS the supervisor", () => {
    renderPage({ role: "member", userId: "u-sup", canSeeBudgets: true });

    expect(screen.getByRole("button", { name: /new task/i })).toBeTruthy();
  });

  it("is there for an admin", () => {
    renderPage({ role: "admin" });

    expect(screen.getByRole("button", { name: /new task/i })).toBeTruthy();
  });

  it("is absent on an archived project even for an admin", () => {
    // The pre-existing rule, which the fix must not drop.
    renderPage({ role: "admin", project: { status: "archived" } });

    expect(screen.queryByRole("button", { name: /new task/i })).toBeNull();
  });
});

describe("projects-004 — the header stripe paints what the card painted", () => {
  // Guard the guard: an empty or truncated palette would make the loop below
  // vacuous, which is how this repo's structural tests have failed before.
  it("checks every slug the schema allows", () => {
    expect(PROJECT_COLORS.length).toBe(5);
    for (const slug of PROJECT_COLORS) {
      expect(COLOR_CLASSES[slug], `no card swatch for "${slug}"`).toBeTruthy();
    }
  });

  for (const slug of PROJECT_COLORS) {
    it(`"${slug}" gets the card's ${COLOR_CLASSES[slug].stripe}`, () => {
      const { container } = renderPage({ project: { color: slug } });

      expect(
        headerStripeClass(container),
        `a "${slug}" project shows ${COLOR_CLASSES[slug].stripe} on the grid card and something else in its own header, so the colour tag means two different things on two screens`
      ).toContain(COLOR_CLASSES[slug].stripe);
    });
  }
});

describe("projects-012 — a synchronous double-click writes once", () => {
  it("Archive fires updateProjectAction once for two clicks in one task", async () => {
    // Never resolves: the request is still in flight for the second click,
    // which is the window the finding is about.
    spies.updateProjectAction.mockReturnValue(new Promise(() => {}));
    renderPage({ role: "admin" });
    const button = screen.getByRole("button", { name: "Archive" });

    // Two NATIVE clicks in one task — no await between them, so React has not
    // re-rendered and a `disabled` derived from state is not on the element
    // yet. This is what page.evaluate(() => { b.click(); b.click(); }) does.
    await act(async () => {
      button.click();
      button.click();
    });

    expect(
      spies.updateProjectAction.mock.calls.length,
      "both clicks reached the action, so one user action writes two Activity rows and archives twice"
    ).toBe(1);
  });

  it("Restore fires updateProjectAction once for two clicks in one task", async () => {
    spies.updateProjectAction.mockReturnValue(new Promise(() => {}));
    renderPage({ role: "admin", project: { status: "archived" } });
    const button = screen.getByRole("button", { name: "Restore" });

    await act(async () => {
      button.click();
      button.click();
    });

    expect(spies.updateProjectAction.mock.calls.length).toBe(1);
  });

  it("Delete fires deleteProjectAction once for two clicks in one task", async () => {
    spies.deleteProjectAction.mockReturnValue(new Promise(() => {}));
    renderPage({ role: "admin" });
    const button = screen.getByRole("button", { name: "Delete" });

    await act(async () => {
      button.click();
      button.click();
    });

    expect(spies.deleteProjectAction.mock.calls.length).toBe(1);
  });

  it("shows the in-flight button as disabled, so the user can see why", async () => {
    spies.updateProjectAction.mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();
    renderPage({ role: "admin" });

    await user.click(screen.getByRole("button", { name: "Archive" }));

    expect(
      (screen.getByRole("button", { name: "Archive" }) as HTMLButtonElement).disabled,
      "nothing on screen says the archive is in flight, so the natural response is to click again"
    ).toBe(true);
  });

  it("re-enables the buttons when the write fails, so the action is retryable", async () => {
    spies.updateProjectAction.mockResolvedValue({ success: false, error: "nope" });
    const user = userEvent.setup();
    renderPage({ role: "admin" });

    await user.click(screen.getByRole("button", { name: "Archive" }));

    expect((screen.getByRole("button", { name: "Archive" }) as HTMLButtonElement).disabled).toBe(
      false
    );
  });
});

describe("projects-002 residue — the header status pill is a lookup, not a built string", () => {
  /**
   * Rendered as a member who does NOT supervise this project, on purpose.
   * `canManage` is then false, so StatusMenu — which shows the same four labels
   * on its trigger and in its menu — is not on the page at all, and a match for
   * the label can only be the header pill. The first draft of these two tests
   * rendered as an admin and one of them PASSED against the unfixed code,
   * because it was finding StatusMenu's trigger text.
   */
  const READER = { role: "member" as Role, userId: "u-member", canSeeBudgets: false };

  it('renders "On hold" rather than nothing', () => {
    // `status${"on_hold".charAt(0).toUpperCase()}${"on_hold".slice(1).replace("_","")}`
    // is "statusOnhold" — lowercase h. lib/i18n/strings.ts defines statusOnHold
    // and nothing named statusOnhold, so React rendered an empty pill.
    renderPage({ ...READER, project: { status: "on_hold" } });

    expect(
      screen.getByText("On hold"),
      "the header status pill is blank for on_hold, so the page does not say the project is paused"
    ).toBeTruthy();
  });

  it("renders the label for every status", () => {
    const expected: Record<string, string> = {
      active: "Active",
      on_hold: "On hold",
      completed: "Completed",
      archived: "Archived",
    };
    for (const [status, label] of Object.entries(expected)) {
      const { unmount } = renderPage({
        ...READER,
        project: { status: status as ProjectOverview["status"] },
      });
      expect(screen.getByText(label), `no header pill text for "${status}"`).toBeTruthy();
      unmount();
    }
  });
});
