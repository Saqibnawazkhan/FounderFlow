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
 * THE SECOND HALF, added 2026-09-29 once `Project.updatedAt` existed. Narrow
 * writes remove the collision for the three status paths — the headline case —
 * but two people editing the NAME in the Edit modal at the same time both
 * genuinely mean to write it, so narrowing cannot help and the later save
 * silently won. `updatedAt` is the optimistic-concurrency token that makes that
 * detectable; the final describe block in this file is that contract, and it
 * changes the contract of the two blocks above it: a payload that writes
 * anything except `status` must now carry `expectedUpdatedAt`. The full-payload
 * tests below therefore send one, because the Edit modal — their subject —
 * sends one. A tokenless whole-row overwrite being accepted IS the bug, so a
 * test asserting it still works would be a test that encodes the bug.
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

/** The UPDATE the action issued, whichever delegate method carried it. The
 *  property under test is which COLUMNS a write carries; whether the
 *  concurrency token turned it into an `updateMany` is the mechanism, and a
 *  test pinned to the mechanism would have to be rewritten to change it. */
function projectWrites(): Array<Record<string, unknown>> {
  return H.calls
    .filter((c) => c.path === "project.update" || c.path === "project.updateMany")
    .map((c) => c.args);
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
  updatedAt: new Date("2026-09-29T09:00:00.000Z"),
  deletedAt: null,
};

/**
 * The optimistic-concurrency token a form rendered from LIVE_PROJECT sends
 * back. Every payload that writes a field other than `status` needs one — see
 * the file header.
 */
const TOKEN = LIVE_PROJECT.updatedAt.toISOString();

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
  // The token matches by default; the tests about a CONFLICT set count: 0.
  when("project.updateMany", { count: 1 });
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

    const data = dataOf(projectWrites()[0]);
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
    await updateProjectAction({
      projectId: "p-1",
      name: "Renamed by me",
      expectedUpdatedAt: TOKEN,
    });

    const data = dataOf(projectWrites()[0]);
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
    await updateProjectAction({
      projectId: "p-1",
      name: STALE_SNAPSHOT.name,
      expectedUpdatedAt: TOKEN,
    });

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
    expect(projectWrites().length).toBe(0);
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
      expectedUpdatedAt: TOKEN,
    });
    expect(res.success, res.success ? "" : res.error).toBe(true);

    const data = dataOf(projectWrites()[0]);
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
      expectedUpdatedAt: TOKEN,
    });
    expect(res.success, res.success ? "" : res.error).toBe(true);

    const data = dataOf(projectWrites()[0]);
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
      expectedUpdatedAt: TOKEN,
    });
    const data = dataOf(projectWrites()[0]);
    expect(Object.prototype.hasOwnProperty.call(data, "targetEndDate")).toBe(true);
    expect(data.targetEndDate).toBeNull();
  });

  it("still validates what it is given", async () => {
    const res = await updateProjectAction({ projectId: "p-1", status: "banana" });
    expect(res.success).toBe(false);
    expect(projectWrites().length).toBe(0);
  });

  it("still refuses a caller who cannot manage the project", async () => {
    signedIn("member", "u-nobody");
    const res = await updateProjectAction({ projectId: "p-1", status: "completed" });
    expect(res.success).toBe(false);
    expect(projectWrites().length).toBe(0);
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

/**
 * THE RESIDUE OF projects-010 — the NAME case.
 *
 * Narrow writes above fix the three status/archive paths: a payload that does
 * not mention a field leaves the column alone, so a stale echo can no longer
 * carry a name back. That closes the collision between a status click and an
 * edit. It does NOT close the collision between TWO EDITS, because both of
 * those genuinely mean to write the name — and the later one wins with no
 * warning, destroying prose somebody typed.
 *
 * `Project.updatedAt` (prisma/schema.prisma, migration
 * 20260929000000_billing_ledger_and_tombstone_gaps) is the token that makes the
 * collision detectable: the edit form sends back the value it was RENDERED
 * from, and the UPDATE only lands if the row still carries it. The database
 * answers the question, in one statement — a re-read and a comparison in
 * application code would have the identical race inside it.
 *
 * WHY THE TOKEN IS MANDATORY FOR EVERYTHING BUT `status`. `status` has
 * dedicated one-click controls (the header menu, Archive, Restore) which, after
 * the narrowing above, write one column that nobody types; losing that race
 * costs a click and is immediately visible on the card. Every other field
 * reaches this action from the Edit modal, which always has a token, so
 * requiring one there is free — and it is what stops a future caller from
 * reintroducing the tokenless whole-row overwrite that was the bug.
 */
describe("projects-010 residue — two people editing the same NAME", () => {
  /** The token a form rendered from LIVE_PROJECT would send back. */
  const CURRENT_TOKEN = "2026-09-29T09:00:00.000Z";
  /** What a tab rendered before the colleague's rename still holds. */
  const STALE_TOKEN = "2026-09-29T08:00:00.000Z";

  function editPayload(extra: Record<string, unknown> = {}) {
    return {
      projectId: "p-1",
      name: "Renamed in my tab",
      description: "and my description",
      color: "forest",
      status: "active",
      targetEndDate: null,
      ...extra,
    };
  }

  it("refuses the write when the project changed since the form was opened", async () => {
    // The row no longer carries the token the form was rendered from, so the
    // conditional UPDATE matches nothing.
    when("project.updateMany", { count: 0 });

    const res = await updateProjectAction(editPayload({ expectedUpdatedAt: STALE_TOKEN }));

    expect(
      res.success,
      "a rename built from a row somebody else has since edited was accepted, so their work is gone"
    ).toBe(false);
    expect(res.success === false && res.error).toMatch(/changed since|reload/i);
  });

  it("asks the DATABASE, by scoping the UPDATE on the token the form carried", async () => {
    when("project.updateMany", { count: 1 });

    await updateProjectAction(editPayload({ expectedUpdatedAt: STALE_TOKEN }));

    const writes = callsTo("project.updateMany");
    expect(
      writes.length,
      "the write is not conditional on anything, so the conflict can only be detected by a re-read — which has the same race inside it"
    ).toBe(1);
    const where = whereOf(writes[0]);
    expect(where.id).toBe("p-1");
    expect(where.companyId).toBe("c-1");
    expect(where.deletedAt).toBeNull();
    expect(where.updatedAt).toBeInstanceOf(Date);
    expect((where.updatedAt as Date).toISOString()).toBe(STALE_TOKEN);
  });

  it("leaves no trace at all when the token is stale — no activity row", async () => {
    when("project.updateMany", { count: 0 });

    await updateProjectAction(editPayload({ expectedUpdatedAt: STALE_TOKEN }));

    expect(
      callsTo("activity.create").length,
      'a refused edit still wrote "Ada updated project …" into the feed, so the feed records a change that never happened'
    ).toBe(0);
  });

  it("lets the edit through when the token still matches the live row", async () => {
    when("project.updateMany", { count: 1 });

    const res = await updateProjectAction(editPayload({ expectedUpdatedAt: CURRENT_TOKEN }));

    expect(res.success, res.success ? "" : `a legitimate edit was refused: ${res.error}`).toBe(
      true
    );
    expect(dataOf(callsTo("project.updateMany")[0]).name).toBe("Renamed in my tab");
    expect(callsTo("activity.create").length).toBe(1);
  });

  it("refuses a prose edit that carries NO token, rather than overwriting blind", async () => {
    const res = await updateProjectAction(editPayload());

    expect(
      res.success,
      "a payload with no token overwrote the name anyway, so the guard is advisory and any caller that forgets it reopens the bug"
    ).toBe(false);
    expect(res.success === false && res.error).toMatch(/out of date|reload/i);
    expect(projectWrites().length).toBe(0);
  });

  it("refuses a token that is not a real instant", async () => {
    const res = await updateProjectAction(editPayload({ expectedUpdatedAt: "not-a-date" }));

    expect(res.success).toBe(false);
    expect(projectWrites().length).toBe(0);
  });

  it("refuses an unusable token even on an otherwise-exempt status write", async () => {
    // A caller that tried to prove it had read the row and got the proof wrong
    // is understood LESS well than one that never tried; silently ignoring the
    // token is how a guard becomes decoration.
    const res = await updateProjectAction({
      projectId: "p-1",
      status: "completed",
      expectedUpdatedAt: "",
    });

    expect(res.success).toBe(false);
    expect(projectWrites().length).toBe(0);
  });

  it("still lets a status-only click through with no token", async () => {
    // The header's Completed / Archive / Restore buttons write one column that
    // nobody types. Demanding a token there would make the narrow writes above
    // unusable for the very callers they were built for.
    const res = await updateProjectAction({ projectId: "p-1", status: "completed" });
    expect(res.success, res.success ? "" : `status click refused: ${res.error}`).toBe(true);
  });
});
