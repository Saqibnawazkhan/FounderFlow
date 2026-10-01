/**
 * The Clock-in dialog's task picker is a task list, and it obeys the same
 * boundary the task board does. Finding tasks-and-comments-006.
 *
 * WHAT WAS WRONG. `getOpenEntryAction` ran
 *
 *     db.task.findMany({
 *       where: { companyId, status: { not: "completed" } },
 *       select: { id: true, title: true },
 *       orderBy: { createdAt: "desc" },
 *       take: 100,
 *     })
 *
 * — no `assignedTo` filter, no `deletedAt: null`, no role branch — and its
 * result is rendered as one `<option>` per task in the clock-in modal
 * (components/time/clock-widget.tsx), which `<ClockWidget />` mounts
 * unconditionally in the top bar for every role, on every app route a member
 * can reach. Meanwhile lib/queries/tasks.ts:75-81 states the boundary
 * explicitly — "On the GLOBAL board a member only ever sees tasks assigned to
 * THEM … Enforced here at the data boundary so it can't be unfiltered from the
 * client" — and lib/queries/search.ts mirrors it for the command palette on
 * purpose. So the one place the product promises a member cannot see other
 * people's work was bypassed by a control sitting on every screen, and task
 * titles in this product are things like "Terminate Ahmed's contract". It
 * also surfaced tombstoned tasks, which every other surface hides.
 *
 * WHY THIS TEST LOOKS LIKE THIS. Same reasoning as
 * tests/lib/actions/soft-delete.test.ts and
 * tests/lib/queries/search-scoping.test.ts: there is no database, so the
 * assertions are about the QUESTION ASKED, not the rows. The fake client hands
 * a teammate's task to anyone who asks, so "the member's picker is empty" would
 * be proof nothing asked — but the stronger and more durable claim is the one
 * made below: the recorded `where` clause carries `assignedTo`. A member's
 * picker being empty could be arranged by any number of accidents; the filter
 * being present cannot.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => {
  const calls: Array<{ path: string; args: Record<string, unknown> }> = [];
  const results = new Map<string, unknown>();

  const MODELS = ["task", "timeEntry", "user", "project"];
  const OPS = ["findUnique", "findFirst", "findMany", "count", "create", "update"];

  const db: Record<string, unknown> = {};
  for (const model of MODELS) {
    const delegate: Record<string, (args?: Record<string, unknown>) => Promise<unknown>> = {};
    for (const op of OPS) {
      const path = `${model}.${op}`;
      delegate[op] = async (args?: Record<string, unknown>) => {
        calls.push({ path, args: args ?? {} });
        return results.get(path);
      };
    }
    db[model] = delegate;
  }

  return { db, calls, results, session: { value: null as unknown } };
});

vi.mock("@/lib/db", () => ({ db: H.db }));
vi.mock("@/lib/auth", () => ({ auth: async () => H.session.value }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/sentry-server", () => ({ captureServerError: vi.fn() }));
// The open-entry half has its own query and its own tests; stubbing it keeps
// this file about the picker.
vi.mock("@/lib/queries/time", () => ({ getOpenEntry: async () => null }));

import { getOpenEntryAction } from "@/lib/actions/time";

/** A task title a member must never be shown. Distinctive on purpose. */
const SECRET_TITLE = "Terminate Ahmed's contract";

const MEMBER_ID = "u_member";

function signedInAs(role: string, id = "u_admin"): void {
  H.session.value = { user: { id, companyId: "c_nimbus", role } };
}

function whereOfTaskRead(): Record<string, unknown> {
  const read = H.calls.find((c) => c.path === "task.findMany");
  expect(read, "the picker never read any tasks").toBeDefined();
  return (read!.args.where ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
  H.calls.length = 0;
  H.results.clear();
  // The fake hands a teammate's task to anyone who asks.
  H.results.set("task.findMany", [{ id: "t_theirs", title: SECRET_TITLE }]);
  signedInAs("admin");
});

describe("getOpenEntryAction — the clock-in task picker", () => {
  it("offers a member only the tasks assigned to them", async () => {
    signedInAs("member", MEMBER_ID);

    const result = await getOpenEntryAction();
    expect(result.success).toBe(true);

    // The boundary is the WHERE clause, at the data layer, exactly as
    // lib/queries/tasks.ts states it — not a filter applied to the options
    // after they arrive, which the client could undo.
    expect(whereOfTaskRead().assignedTo).toBe(MEMBER_ID);
  });

  it("does not narrow an admin to their own tasks", async () => {
    // The converse: clocking time against a teammate's task is a founder
    // capability the board already grants, so narrowing here would be a
    // regression rather than a tightening.
    signedInAs("admin");

    await getOpenEntryAction();

    expect(whereOfTaskRead().assignedTo).toBeUndefined();
  });

  it("does not narrow a cofounder either", async () => {
    // A gate written as `role === "member" ? …` and one written as
    // `role === "admin" ? …` differ only here.
    signedInAs("cofounder", "u_cofounder");

    await getOpenEntryAction();

    expect(whereOfTaskRead().assignedTo).toBeUndefined();
  });

  it("hides tombstoned tasks from the picker", async () => {
    // Every other surface filters them; a soft-deleted task offered as a
    // clock-in target is both a leak of a deleted title and a time entry
    // pointing at a row on its way to the purge cron.
    signedInAs("member", MEMBER_ID);

    await getOpenEntryAction();

    expect(whereOfTaskRead().deletedAt).toBeNull();
  });

  it("keeps the picker to the caller's own company", async () => {
    signedInAs("member", MEMBER_ID);

    await getOpenEntryAction();

    expect(whereOfTaskRead().companyId).toBe("c_nimbus");
  });

  it("offers the same projects the board does, so a picked task is findable after", async () => {
    // The global board hides tasks whose parent project is completed or
    // archived (lib/queries/tasks.ts). A picker that offers one lets someone
    // clock into work that is not on any board they can open — which is
    // projects-011 seen from the time side.
    signedInAs("admin");

    await getOpenEntryAction();

    const project = whereOfTaskRead().project as { status?: { notIn?: string[] } } | undefined;
    expect(project?.status?.notIn).toContain("completed");
    expect(project?.status?.notIn).toContain("archived");
  });

  it("still caps how many options it loads", async () => {
    signedInAs("admin");

    await getOpenEntryAction();

    const read = H.calls.find((c) => c.path === "task.findMany")!;
    expect(read.args.take as number).toBeGreaterThan(0);
  });
});

/**
 * time-013 — the picker's ceiling was silent.
 *
 * `take: 100` with `orderBy: { createdAt: "desc" }` and a plain native `<select>`:
 * no search field, no count, no hint. So in a workspace with more than a hundred
 * open tasks the 101st-oldest was simply untaggable, and long-lived backlog items
 * are exactly the ones that fall off the bottom of a createdAt-desc list — the
 * tasks people track the most time against became the ones they could not tag,
 * and their hours landed as untagged work.
 *
 * A ceiling is legitimate; an INVISIBLE ceiling is the bug. These cases assert
 * the action reports the truncation, using the repo's own has-more probe pattern
 * (`take + 1`, as documented on `getTaskPage`) rather than a second `count()` —
 * the widget mounts on every route, so an extra aggregate per page view is not
 * free.
 *
 * Making the 101st task REACHABLE needs a searchable combobox backed by a
 * `title contains` query. That is a feature, not a fix, and it is reported rather
 * than built.
 */
describe("getOpenEntryAction — the picker says when it is showing a subset", () => {
  function openTasks(n: number) {
    return Array.from({ length: n }, (_, i) => ({ id: `t_${i}`, title: `Task ${i}` }));
  }

  it("reports truncation and drops the probe row when the workspace is over the cap", async () => {
    signedInAs("admin");
    // One more than whatever the action asked for: the probe hits.
    H.results.set("task.findMany", openTasks(1_000));

    const result = await getOpenEntryAction();
    expect(result.success).toBe(true);
    if (!result.success) return;

    const read = H.calls.find((c) => c.path === "task.findMany")!;
    const take = read.args.take as number;
    expect(
      result.data.tasks.length,
      "the has-more probe row must not be offered as an option"
    ).toBe(take - 1);
    expect(result.data.tasksTruncated, "a ceiling nobody is told about is the finding").toBe(true);
  });

  it("reports no truncation for a workspace inside the cap", async () => {
    signedInAs("admin");
    H.results.set("task.findMany", openTasks(7));

    const result = await getOpenEntryAction();
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.tasks).toHaveLength(7);
    expect(result.data.tasksTruncated).toBe(false);
  });
});
