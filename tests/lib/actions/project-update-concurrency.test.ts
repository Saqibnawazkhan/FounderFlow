/**
 * projects-010 — two people editing the same project silently destroy each
 * other's work — plus the two project lookups data-integrity-002 left behind.
 *
 * THE SCENARIO, IN THE USER'S WORDS. A founder renames a project. The
 * cofounder, whose tab has been open since before the rename, clicks
 * "Completed" in the header menu. The rename is gone. No error, no toast, no
 * activity row saying the name changed back — only a `project_updated` entry
 * carrying the OLD name.
 *
 * THE MECHANISM. `updateProjectAction` writes name, description, color, status
 * and targetEndDate UNCONDITIONALLY, and every caller sends a full client-side
 * snapshot of every column taken from the props of the render it was mounted
 * with:
 *
 *   handleStatusChange  project-detail-client.tsx:200
 *   handleArchive       project-detail-client.tsx:160
 *   handleUnarchive     project-detail-client.tsx:179
 *
 * None of those three is trying to change a name. They send one because
 * `UpdateProjectSchema` demands all five fields, so "set the status" is
 * expressed as "overwrite the whole row with what I last saw". A stale echo is
 * indistinguishable from an edit once it reaches the server — which is why the
 * fix has to be that the action accepts an intent narrow enough to be honest:
 * a field that is ABSENT from the payload is not written at all.
 *
 * THE DISTINCTION THIS FILE IS CAREFUL ABOUT. "Absent" and "empty" are not the
 * same thing, and conflating them would trade one silent data bug for another:
 * the Edit modal clears a description by submitting an empty one, so a payload
 * that CARRIES `description` with no value must still write NULL. Only a
 * payload that does not mention the field at all leaves it alone. Two tests
 * below pin each direction, because a fix that only checks for a falsy value
 * passes the lost-update test and quietly breaks "clear the description".
 *
 * WHAT IS NOT CLOSED HERE, and is in the report rather than hidden in a green
 * test: with no `updatedAt`/`version` column on Project (prisma/schema.prisma
 * has neither), the server cannot detect that a payload was built from a stale
 * row. Narrow writes remove the collision for the three status paths — the
 * headline case — but two people editing the NAME in the Edit modal at the same
 * time still resolve last-write-wins.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => {
  const calls: Array<{ path: string; args: Record<string, unknown> }> = [];
  const results = new Map<string, unknown>();

  const MODELS = ["project", "user", "activity", "notification", "task", "budget"];
  const OPS = [
    "findUnique",
    "findFirst",
    "findMany",
    "count",
    "create",
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

  return { db, calls, results, session: { value: null as unknown } };
});

vi.mock("@/lib/db", () => ({ db: H.db }));
vi.mock("@/lib/auth", () => ({ auth: async () => H.session.value }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/sentry-server", () => ({ captureServerError: vi.fn() }));
vi.mock("@/lib/safety/bulk-mutation-guard", () => ({ warnBulkMutation: vi.fn() }));
vi.mock("@/lib/notify/fan-out", () => ({
  notifyUsers: async () => ({ notified: 0 }),
}));

import { changeSupervisorAction, updateProjectAction } from "@/lib/actions/projects";

function when(path: string, value: unknown): void {
  H.results.set(path, value);
}

function callsTo(path: string): Array<Record<string, unknown>> {
  return H.calls.filter((c) => c.path === path).map((c) => c.args);
}

function whereOf(args: Record<string, unknown> | undefined): Record<string, unknown> {
  return (args?.where ?? {}) as Record<string, unknown>;
}

function dataOf(args: Record<string, unknown> | undefined): Record<string, unknown> {
  return (args?.data ?? {}) as Record<string, unknown>;
}

/** Every project.* lookup the action might use, so the assertion does not care
 *  whether it is a findUnique or a findFirst. */
function projectLookups(): Array<Record<string, unknown>> {
  return H.calls
    .filter((c) => c.path === "project.findUnique" || c.path === "project.findFirst")
    .map((c) => c.args);
}

/** The project row as it stands in the database RIGHT NOW — i.e. after the
 *  colleague's rename that the stale tab never saw. */
const LIVE_PROJECT = {
  id: "p-1",
  companyId: "c-1",
  name: "Nimbus — Q4 launch",
  description: "The real, current description",
  supervisorId: "u-1",
  status: "active",
  color: "emerald",
  targetEndDate: new Date("2026-12-31T00:00:00.000Z"),
  createdBy: "u-1",
  deletedAt: null,
};

/** What a tab mounted BEFORE the rename would echo back. */
const STALE_SNAPSHOT = {
  name: "Nimbus",
  description: "the old description",
  color: "slate",
  targetEndDate: null,
};

function signedIn(role = "admin", id = "u-1") {
  H.session.value = { user: { id, companyId: "c-1", role } };
}

beforeEach(() => {
  H.calls.length = 0;
  H.results.clear();
  signedIn();
  when("project.findUnique", LIVE_PROJECT);
  when("project.findFirst", LIVE_PROJECT);
  when("user.findUnique", { id: "u-1", name: "Ada", companyId: "c-1" });
  when("user.findFirst", { id: "u-2", name: "Bilal" });
  when("project.update", { ...LIVE_PROJECT });
  when("activity.create", { id: "a-1" });
});

describe("projects-010 — changing the status changes the status, and nothing else", () => {
  it("accepts a status-only payload", async () => {
    const res = await updateProjectAction({ projectId: "p-1", status: "completed" });
    expect(
      res.success,
      `a status change must not have to restate the whole row; got: ${res.success ? "" : res.error}`
    ).toBe(true);
  });

  it("writes ONLY the status, so a colleague's rename survives", async () => {
    await updateProjectAction({ projectId: "p-1", status: "completed" });

    const data = dataOf(callsTo("project.update")[0]);
    expect(data.status).toBe("completed");
    expect(
      Object.prototype.hasOwnProperty.call(data, "name"),
      "the UPDATE carries a name, so whatever the caller last saw is written over the current name"
    ).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(data, "description")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(data, "color")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(data, "targetEndDate")).toBe(false);
  });

  it("does not write a field the caller never mentioned, even when it sends others", async () => {
    await updateProjectAction({ projectId: "p-1", name: "Renamed by me" });

    const data = dataOf(callsTo("project.update")[0]);
    expect(data.name).toBe("Renamed by me");
    expect(
      Object.prototype.hasOwnProperty.call(data, "status"),
      "a rename must not also reset the status"
    ).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(data, "targetEndDate")).toBe(false);
  });

  it("logs the activity against the CURRENT name when the payload names none", async () => {
    await updateProjectAction({ projectId: "p-1", status: "completed" });

    const message = dataOf(callsTo("activity.create")[0]).message as string;
    expect(
      message,
      "the feed's only record of the change has to quote the project's real name, not the payload's missing one"
    ).toContain(LIVE_PROJECT.name);
    expect(message).not.toContain("undefined");
  });

  it("records the previous name on a real rename, so the feed can be read backwards", async () => {
    await updateProjectAction({ projectId: "p-1", name: STALE_SNAPSHOT.name });

    const metadata = JSON.parse(dataOf(callsTo("activity.create")[0]).metadata as string) as Record<
      string,
      unknown
    >;
    expect(metadata.projectName).toBe(STALE_SNAPSHOT.name);
    expect(
      metadata.previousName,
      "a rename leaves no trace of what the project used to be called"
    ).toBe(LIVE_PROJECT.name);
  });

  it("still records an archive as an archive when the payload is status-only", async () => {
    await updateProjectAction({ projectId: "p-1", status: "archived" });
    expect(dataOf(callsTo("activity.create")[0]).type).toBe("project_archived");
  });

  it("refuses a payload that asks for nothing", async () => {
    const res = await updateProjectAction({ projectId: "p-1" });
    expect(res.success).toBe(false);
    expect(res.success === false && res.error).toMatch(/nothing|no changes|field/i);
    expect(callsTo("project.update").length).toBe(0);
  });
});

describe("a full payload still means every field — the Edit modal must keep working", () => {
  it("writes all five fields when all five are sent", async () => {
    const res = await updateProjectAction({
      projectId: "p-1",
      name: "Deliberate rename",
      description: "Deliberate description",
      color: "forest",
      status: "on_hold",
      targetEndDate: new Date("2027-01-31T00:00:00.000Z"),
    });
    expect(res.success).toBe(true);

    const data = dataOf(callsTo("project.update")[0]);
    expect(data.name).toBe("Deliberate rename");
    expect(data.description).toBe("Deliberate description");
    expect(data.color).toBe("forest");
    expect(data.status).toBe("on_hold");
    expect(data.targetEndDate).toBeInstanceOf(Date);
  });

  it("clears the description when the caller submits an EMPTY one", async () => {
    // The modal's textarea sends "" — DescriptionField coerces that to
    // undefined, so a fix that tests the VALUE cannot tell this apart from
    // "field absent" and would silently stop letting anyone clear a description.
    const res = await updateProjectAction({
      projectId: "p-1",
      name: "Deliberate rename",
      description: "",
      color: "forest",
      status: "active",
      targetEndDate: null,
    });
    expect(res.success).toBe(true);

    const data = dataOf(callsTo("project.update")[0]);
    expect(Object.prototype.hasOwnProperty.call(data, "description")).toBe(true);
    expect(data.description, "an emptied description must persist as NULL").toBeNull();
  });

  it("clears the target end date when the caller submits an empty one", async () => {
    await updateProjectAction({
      projectId: "p-1",
      name: "Deliberate rename",
      color: "forest",
      status: "active",
      targetEndDate: null,
    });
    const data = dataOf(callsTo("project.update")[0]);
    expect(Object.prototype.hasOwnProperty.call(data, "targetEndDate")).toBe(true);
    expect(data.targetEndDate).toBeNull();
  });

  it("still validates what it is given", async () => {
    const res = await updateProjectAction({ projectId: "p-1", status: "banana" });
    expect(res.success).toBe(false);
    expect(callsTo("project.update").length).toBe(0);
  });

  it("still refuses a caller who cannot manage the project", async () => {
    signedIn("member", "u-nobody");
    const res = await updateProjectAction({ projectId: "p-1", status: "completed" });
    expect(res.success).toBe(false);
    expect(callsTo("project.update").length).toBe(0);
  });
});

describe("data-integrity-002 — a tombstoned project is not editable", () => {
  it("updateProjectAction resolves the project with deletedAt: null", async () => {
    when("project.findUnique", null);
    when("project.findFirst", null);

    const res = await updateProjectAction({ projectId: "p-dead", status: "active" });

    expect(res.success).toBe(false);
    const lookups = projectLookups();
    expect(lookups.length).toBeGreaterThan(0);
    expect(
      whereOf(lookups[0]).deletedAt,
      "updateProjectAction resolves a soft-deleted project, so a stale tab can keep editing a project that exists on no surface"
    ).toBeNull();
  });

  it("changeSupervisorAction resolves the project with deletedAt: null", async () => {
    when("project.findUnique", null);
    when("project.findFirst", null);

    const res = await changeSupervisorAction({ projectId: "p-dead", supervisorId: "u-2" });

    expect(res.success).toBe(false);
    const lookups = projectLookups();
    expect(lookups.length).toBeGreaterThan(0);
    expect(
      whereOf(lookups[0]).deletedAt,
      "changeSupervisorAction can hand a deleted project to somebody, and notify them about it"
    ).toBeNull();
  });

  it("scopes the project lookup to the caller's company in the same query", async () => {
    await updateProjectAction({ projectId: "p-1", status: "completed" });
    expect(whereOf(projectLookups()[0]).companyId).toBe("c-1");
  });
});
