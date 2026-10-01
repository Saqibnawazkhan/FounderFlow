/**
 * projects-005 — duplicating a project with "Keep each task's assignee" on is
 * the ONE deliberate way to assign work in bulk, and it was the one way that
 * told nobody.
 *
 * THE SCENARIO. Ada duplicates "Nimbus" with the assignee checkbox on. Seven of
 * the copied tasks are Bilal's and three are Chen's. Both of them now hold new
 * obligations, with deadlines, on their /tasks count. Neither gets a
 * notification, an email, or an activity row naming them. They find out by
 * opening the app.
 *
 * WHY THAT IS A CONTRADICTION AND NOT JUST A GAP. `addTaskAction` fires
 * `task_assigned` for a SINGLE task landing on a colleague. And
 * `DuplicateProjectSchema.keepAssignees` argues its own default-false case in
 * precisely these terms — "fifteen new obligations on fourteen colleagues — each
 * with a notification, each showing up in their /tasks count". The schema
 * describes behaviour the action did not have.
 *
 * WHY A SUMMARY AND NOT A FAN-OUT. `MAX_DUPLICATED_TASKS` is 500, so one per
 * task is up to 500 notification rows and 500 pushes from one click. One per
 * PERSON, carrying the count, is the shape that survives the ceiling — and it is
 * the shape a recipient can actually act on.
 *
 * WHAT THIS FILE DOES NOT ASSERT. The exact wording. It asserts who is told, how
 * many they are told about, which event it is (so notification PREFERENCES and
 * the finance filter in fan-out.ts apply), and that the duplicator is not
 * notified about their own click.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => {
  const calls: Array<{ path: string; args: Record<string, unknown> }> = [];
  const results = new Map<string, unknown>();
  const notified: Array<Record<string, unknown>> = [];

  const MODELS = ["project", "user", "activity", "notification", "task", "budget"];
  const OPS = [
    "findUnique",
    "findFirst",
    "findMany",
    "count",
    "create",
    "createMany",
    "update",
    "updateMany",
    "deleteMany",
  ];

  type Op = (args?: Record<string, unknown>) => Promise<unknown>;
  const db: Record<string, unknown> = {};
  for (const model of MODELS) {
    const delegate: Record<string, Op> = {};
    for (const op of OPS) {
      const path = `${model}.${op}`;
      delegate[op] = async (args?: Record<string, unknown>) => {
        calls.push({ path, args: args ?? {} });
        const canned = results.get(path);
        return typeof canned === "function"
          ? (canned as (a: Record<string, unknown>) => unknown)(args ?? {})
          : canned;
      };
    }
    db[model] = delegate;
  }
  db.$transaction = async (arg: unknown) =>
    typeof arg === "function"
      ? await (arg as (tx: unknown) => Promise<unknown>)(db)
      : await Promise.all(arg as Array<Promise<unknown>>);

  return { db, calls, results, notified, session: { value: null as unknown } };
});

vi.mock("@/lib/db", () => ({ db: H.db }));
vi.mock("@/lib/auth", () => ({ auth: async () => H.session.value }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/sentry-server", () => ({ captureServerError: vi.fn() }));
vi.mock("@/lib/safety/bulk-mutation-guard", () => ({ warnBulkMutation: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  limiters: { write: { consume: () => ({ allowed: true }) } },
}));
vi.mock("@/lib/notify/fan-out", () => ({
  notifyUsers: async (input: Record<string, unknown>) => {
    H.notified.push(input);
    return { notified: (input.userIds as string[]).length };
  },
}));

import { duplicateProjectAction } from "@/lib/actions/projects";

const SOURCE = {
  id: "p-src",
  name: "Nimbus",
  description: "the plan",
  supervisorId: "u-sup",
  color: "emerald",
};

/** Seven for Bilal, three for Chen, two already Ada's own. */
function sourceTasks() {
  const rows: Array<Record<string, unknown>> = [];
  const make = (i: number, who: string, name: string) => ({
    title: `task ${i}`,
    description: "",
    priority: "medium",
    assignedTo: who,
    assignedToName: name,
    deadline: new Date("2026-10-01T00:00:00.000Z"),
    order: i,
  });
  for (let i = 0; i < 7; i++) rows.push(make(i, "u-bilal", "Bilal"));
  for (let i = 7; i < 10; i++) rows.push(make(i, "u-chen", "Chen"));
  for (let i = 10; i < 12; i++) rows.push(make(i, "u-ada", "Ada"));
  return rows;
}

/** Every notifyUsers call carrying the assignment event. */
function assignmentPings(): Array<Record<string, unknown>> {
  return H.notified.filter((n) => n.event === "task_assigned");
}

/** The single ping addressed to `userId`, or undefined. */
function pingFor(userId: string): Record<string, unknown> | undefined {
  return assignmentPings().find((n) => (n.userIds as string[]).indexOf(userId) !== -1);
}

function signedIn(id = "u-ada", role = "admin") {
  H.session.value = { user: { id, companyId: "c-1", role } };
}

beforeEach(() => {
  H.calls.length = 0;
  H.results.clear();
  H.notified.length = 0;
  signedIn();
  H.results.set("project.findFirst", SOURCE);
  H.results.set("project.create", { id: "p-new", name: "Nimbus round 2" });
  H.results.set("user.findUnique", { id: "u-ada", name: "Ada", companyId: "c-1" });
  // Both carried-over assignees are live members.
  H.results.set("user.findMany", [
    { id: "u-bilal", name: "Bilal" },
    { id: "u-chen", name: "Chen" },
  ]);
  H.results.set("user.findFirst", { id: "u-sup" });
  H.results.set("task.findMany", sourceTasks());
  H.results.set("task.createMany", { count: 12 });
  H.results.set("task.count", 1);
  H.results.set("activity.create", { id: "a-1" });
});

const DUPLICATE = {
  sourceProjectId: "p-src",
  name: "Nimbus round 2",
  copyTasks: true,
  keepAssignees: true,
  shiftDeadlines: false,
};

describe("projects-005 — a colleague who inherits copied tasks is told", () => {
  it("succeeds, so the assertions below are about a duplicate that happened", async () => {
    const res = await duplicateProjectAction(DUPLICATE);
    expect(res.success, res.success ? "" : res.error).toBe(true);
  });

  it("tells every colleague whose tasks were copied", async () => {
    await duplicateProjectAction(DUPLICATE);

    const told = assignmentPings()
      .flatMap((n) => n.userIds as string[])
      .sort();
    expect(
      told,
      "duplicating with keepAssignees on hands colleagues up to 500 new tasks and emits no task_assigned event for any of them — the one deliberate bulk-assign path is the one that tells nobody"
    ).toEqual(["u-bilal", "u-chen"]);
  });

  it("tells each of them how many tasks landed on them", async () => {
    await duplicateProjectAction(DUPLICATE);

    expect(String(pingFor("u-bilal")?.message)).toContain("7");
    expect(String(pingFor("u-chen")?.message)).toContain("3");
  });

  it("names the project the work came from", async () => {
    await duplicateProjectAction(DUPLICATE);

    expect(String(pingFor("u-bilal")?.message)).toContain("Nimbus");
  });

  it("links to the new project, not the source", async () => {
    await duplicateProjectAction(DUPLICATE);

    expect(pingFor("u-bilal")?.link).toBe("/projects/p-new");
    expect(pingFor("u-bilal")?.projectId).toBe("p-new");
  });

  it("does not notify the duplicator about their own click", async () => {
    await duplicateProjectAction(DUPLICATE);

    // Two of the twelve tasks were already Ada's, and she pressed the button.
    expect(pingFor("u-ada"), "Ada is notified that Ada assigned Ada some work").toBeUndefined();
  });

  it("sends one notification per person, not one per task", async () => {
    await duplicateProjectAction(DUPLICATE);

    // Ten copied tasks belong to colleagues. A per-task fan-out is 10 rows here
    // and up to 500 at the ceiling.
    const recipients = assignmentPings().flatMap((n) => n.userIds as string[]);
    expect(recipients.length).toBe(2);
  });

  it("uses the task_assigned event, so preferences and the finance filter apply", async () => {
    await duplicateProjectAction(DUPLICATE);

    // notifyUsers keys notification preferences, push and the sec-005 finance
    // recipient filter off `event`. A bespoke event name would bypass all three.
    expect(assignmentPings().length).toBeGreaterThan(0);
    for (const ping of assignmentPings()) {
      expect(ping.category).toBe("task");
      expect(ping.companyId).toBe("c-1");
    }
  });

  it("records the per-person breakdown in the activity row", async () => {
    await duplicateProjectAction(DUPLICATE);

    // The audit trail half: "who was signed up for what". One row, not one per
    // task — the metadata carries the split.
    const activity = H.calls.find((c) => c.path === "activity.create");
    const data = (activity?.args.data ?? {}) as Record<string, unknown>;
    const metadata = JSON.parse(String(data.metadata)) as Record<string, unknown>;
    expect(
      metadata.assignedCounts,
      "nothing in the feed records which colleague was signed up for how many copied tasks"
    ).toEqual({ "u-bilal": 7, "u-chen": 3 });
  });
});

describe("projects-005 — the cases that must NOT produce an assignment ping", () => {
  it("says nothing when keepAssignees is off, because everything lands on the duplicator", async () => {
    await duplicateProjectAction({ ...DUPLICATE, keepAssignees: false });

    expect(
      assignmentPings(),
      "with keepAssignees off every copied task is assigned to the duplicator, so there is nobody to tell"
    ).toEqual([]);
  });

  it("says nothing when the tasks are not copied at all", async () => {
    await duplicateProjectAction({ ...DUPLICATE, copyTasks: false });

    expect(assignmentPings()).toEqual([]);
  });

  it("does not ping a deactivated assignee whose tasks fell back to the duplicator", async () => {
    // Bilal has been deactivated since the source project was planned, so
    // `user.findMany` (which filters deletedAt: null) does not return him and his
    // seven tasks land on Ada. Telling a tombstoned account about work it cannot
    // open would be the deactivated-assignment bug wearing a notification.
    H.results.set("user.findMany", [{ id: "u-chen", name: "Chen" }]);

    await duplicateProjectAction(DUPLICATE);

    expect(pingFor("u-bilal")).toBeUndefined();
    expect(pingFor("u-chen")).toBeDefined();
  });

  it("still notifies the carried-over supervisor, as it always did", async () => {
    await duplicateProjectAction(DUPLICATE);

    const supervisorPings = H.notified.filter((n) => n.event === "project_supervisor");
    expect(supervisorPings.length, "the pre-existing supervisor notification was dropped").toBe(1);
  });
});
