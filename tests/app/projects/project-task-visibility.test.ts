/**
 * projects-017 — clicking a project link bypasses the confidentiality rule the
 * task board enforces at the data boundary.
 *
 * THE RULE, AS THE PRODUCT STATES IT. lib/queries/tasks.ts, in its own comment:
 * "On the GLOBAL board a member only ever sees tasks assigned to THEM — never a
 * teammate's, admin's, or co-founder's work. Enforced here at the data boundary
 * so it can't be unfiltered from the client."
 *
 * WHERE IT LEAKS. That filter is applied only when `opts.projectId` is ABSENT:
 * `...(role === "member" && !opts.projectId ? { assignedTo: userId } : {})`. The
 * project detail page calls `getTasks({ projectId })`, so a plain member holding
 * ONE task in a project receives every task in it — titles, assignee names,
 * statuses, deadlines, priorities — and project-detail-client.tsx renders the
 * first ten. In a workspace where most work lives in a handful of projects, which
 * is the shape the `add_projects` migration's per-company "General" project
 * produced, that is the whole company's task list.
 *
 * The comment defends the widening as preserving the supervisor escape hatch. The
 * supervisor case is already covered by `canManageProject`; extending it to every
 * ASSIGNED member is the part that was never argued.
 *
 * WHAT THIS FILE TESTS, AND WHY HERE. The authoritative fix is one clause in
 * `taskScopeWhere`, and that file belongs to another agent this wave — the exact
 * change is in this agent's `needsOtherFiles`. What is testable and fixable HERE
 * is the layer the customer actually meets: `app/(app)/projects/[id]/page.tsx`
 * decides what crosses into the RSC payload. So these tests hand the page a
 * data layer that returns everything (which is what it returns today) and assert
 * that a teammate's task never reaches the client component.
 *
 * Both layers, deliberately. CLAUDE.md's own rule for permission gates is that
 * middleware and the action layer "both must agree" rather than one deferring to
 * the other; the same applies to a read boundary and the page that renders it.
 * This page filter should NOT be deleted once `taskScopeWhere` narrows.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScopedSession } from "@/lib/queries/session";
import type { ProjectOverview } from "@/lib/queries/projects";
import type { TaskWithCount } from "@/lib/queries/tasks";

const H = vi.hoisted(() => ({
  session: null as unknown as ScopedSession,
  overview: null as unknown as ProjectOverview,
  tasks: [] as unknown[],
}));

// `db` is never touched: every query this page makes is stubbed below. It is
// mocked anyway so importing the real lib/queries/projects (for the decision
// function under test) cannot construct a Prisma client.
vi.mock("@/lib/db", () => ({ db: {} }));

vi.mock("@/lib/queries/session", () => ({
  requireScopedSession: async () => H.session,
}));

// Partial mock: the page's project READS are stubbed, but everything else in
// lib/queries/projects — including the visibility decision this fix adds — is
// the real module. Mocking the whole thing would mean asserting against a fake.
vi.mock("@/lib/queries/projects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries/projects")>();
  return {
    ...actual,
    getProjectOverview: async () => H.overview,
    getProjectTitleForUser: async () => H.overview?.name ?? null,
  };
});

// The data layer as it behaves TODAY for a project-scoped read: everything in
// the project, unfiltered by assignee. That is the premise of the finding, so
// hard-coding it here is what keeps these tests about the page's own decision
// rather than about whichever half of the fix landed first.
vi.mock("@/lib/queries/tasks", () => ({
  getTasks: async () => H.tasks,
}));
vi.mock("@/lib/queries/budgets", () => ({ getBudgetsWithSpend: async () => [] }));
vi.mock("@/lib/queries/users", () => ({ getCompanyUsers: async () => [] }));
vi.mock("@/app/(app)/projects/[id]/project-detail-client", () => ({
  ProjectDetailClient: () => null,
}));

const SUPERVISOR = "u-sup";
const MEMBER = "u-member";
const ADMIN = "u-admin";

function task(id: string, title: string, assignedTo: string): TaskWithCount {
  return {
    id,
    companyId: "c-1",
    projectId: "p-1",
    title,
    description: "",
    status: "pending",
    priority: "high",
    assignedTo,
    assignedToName: assignedTo,
    assignedBy: ADMIN,
    assignedByName: "Ada",
    deadline: "2026-10-05T00:00:00.000Z",
    createdAt: "2026-09-01T00:00:00.000Z",
    completedAt: null,
    commentCount: 0,
  } as unknown as TaskWithCount;
}

/** The project board as the data layer hands it over: three people's work. */
const ALL_TASKS: TaskWithCount[] = [
  task("t-mine", "Chase the invoice", MEMBER),
  task("t-admins", "Board deck: dilution scenarios", ADMIN),
  task("t-sups", "Interview the second candidate", SUPERVISOR),
];

function overviewFor(): ProjectOverview {
  return {
    id: "p-1",
    companyId: "c-1",
    name: "Nimbus",
    description: null,
    supervisorId: SUPERVISOR,
    supervisorName: "Bilal",
    status: "active",
    color: "emerald",
    targetEndDate: null,
    createdBy: ADMIN,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-09-29T08:00:00.000Z",
    openTaskCount: 3,
    totalTaskCount: 3,
    monthToDateSpendPkr: 0,
    financeVisible: false,
    trackedMs: 0,
    memberCount: 3,
  } as unknown as ProjectOverview;
}

function sessionFor(userId: string, role: ScopedSession["role"]): ScopedSession {
  return {
    userId,
    userName: userId,
    email: `${userId}@nimbus.app`,
    companyId: "c-1",
    role,
  } as ScopedSession;
}

/** The task list the page actually hands the client component. */
async function renderedTasks(): Promise<TaskWithCount[]> {
  const mod = await import("@/app/(app)/projects/[id]/page");
  const element = (await mod.default({ params: { id: "p-1" } })) as {
    props: { tasks: TaskWithCount[] };
  };
  return element.props.tasks;
}

function titles(rows: TaskWithCount[]): string[] {
  return rows.map((r) => r.title).sort();
}

beforeEach(() => {
  H.overview = overviewFor();
  H.tasks = ALL_TASKS;
  H.session = sessionFor(ADMIN, "admin");
});

describe("projects-017 — a plain member sees only their own work on a project page", () => {
  it("does not hand a member the admin's task", async () => {
    H.session = sessionFor(MEMBER, "member");

    const rows = await renderedTasks();

    expect(
      titles(rows),
      "a member with one task in this project receives every teammate's task — title, assignee, status, deadline and priority — which is exactly what /tasks refuses them"
    ).toEqual(["Chase the invoice"]);
  });

  it("does not leak a teammate's name either", async () => {
    // The assignee column is half of what makes this a confidentiality problem:
    // it maps work to people.
    H.session = sessionFor(MEMBER, "member");

    const rows = await renderedTasks();

    expect(rows.map((r) => r.assignedTo)).toEqual([MEMBER]);
  });

  it("gives a member with nothing in the project an empty list, not everything", async () => {
    H.session = sessionFor("u-stranger", "member");

    expect(await renderedTasks()).toEqual([]);
  });
});

describe("projects-017 — the escape hatch and the founders keep their whole board", () => {
  it("a member who SUPERVISES the project still sees every task in it", async () => {
    // This is the case the original comment was protecting, and it must survive:
    // a supervisor who can only see their own tasks cannot supervise.
    H.session = sessionFor(SUPERVISOR, "member");

    expect(titles(await renderedTasks())).toEqual(titles(ALL_TASKS));
  });

  it("an admin still sees every task in it", async () => {
    H.session = sessionFor(ADMIN, "admin");

    expect(titles(await renderedTasks())).toEqual(titles(ALL_TASKS));
  });

  it("a cofounder still sees every task in it", async () => {
    H.session = sessionFor("u-cofounder", "cofounder");

    expect(titles(await renderedTasks())).toEqual(titles(ALL_TASKS));
  });

  it("guards the guard: the fixture really does carry three people's work", () => {
    // If ALL_TASKS ever collapsed to one row, every assertion above would pass
    // for the wrong reason.
    expect(new Set(ALL_TASKS.map((t) => t.assignedTo)).size).toBe(3);
  });
});
