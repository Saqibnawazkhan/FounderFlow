/**
 * tasks-and-comments-010, second half — "select all" on a big board answers with
 * a raw developer error.
 *
 * THE MECHANISM. `toggleSelectAll` (app/(app)/tasks/tasks-client.tsx:381) selects
 * every FILTERED id with no ceiling, while `BulkTaskStatusSchema` and
 * `BulkTaskDeleteSchema` cap `ids` at 200 (lib/schemas/task.ts:39). Both bulk
 * actions then surface zod's own words verbatim:
 *
 *     return { success: false, error: parsed.error.issues[0]?.message ?? … }
 *
 * so a 201-task select-all put "Array must contain at most 200 element(s)" in a
 * toast, in English, in a product that ships Urdu — a sentence about a JavaScript
 * array, shown to a founder who pressed a checkbox. The headline bulk feature
 * becomes an error message with no user-facing meaning, and nothing tells them
 * what to do instead.
 *
 * WHAT IS FIXED HERE and WHAT IS NOT. The message is the action's to own, and it
 * is fixed here: an over-sized selection gets a sentence that names the limit,
 * names how many were selected, and says what to do. The *clamp* — not letting
 * the checkbox select 201 in the first place — lives in tasks-client.tsx, which
 * this agent does not own; it is in the report.
 *
 * The last case pins the action's number against the SCHEMA's number. Two
 * constants that must agree, in two files, is exactly the drift that produces a
 * message promising 200 while the parser rejects at 150.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { BulkTaskDeleteSchema, BulkTaskStatusSchema } from "@/lib/schemas/task";

const H = vi.hoisted(() => {
  const calls: Array<{ path: string; args: Record<string, unknown> }> = [];
  const results = new Map<string, unknown>();

  const MODELS = ["task", "user", "activity", "notification"];
  const OPS = [
    "findUnique",
    "findFirst",
    "findMany",
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
    typeof arg === "function" ? await (arg as (tx: unknown) => Promise<unknown>)(db) : arg;

  return { db, calls, results, session: { value: null as unknown } };
});

vi.mock("@/lib/db", () => ({ db: H.db }));
vi.mock("@/lib/auth", () => ({ auth: async () => H.session.value }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/sentry-server", () => ({ captureServerError: vi.fn() }));
vi.mock("@/lib/safety/bulk-mutation-guard", () => ({ warnBulkMutation: vi.fn() }));
vi.mock("@/lib/notify/fan-out", () => ({ notifyUsers: async () => ({ notified: 0 }) }));
// The bulk limiter is per-user and in-memory; a fresh id per test keeps the
// rate limit out of the assertions.
let seat = 0;

import { bulkDeleteTasksAction, bulkUpdateTaskStatusAction } from "@/lib/actions/tasks";

function ids(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(`t-${i}`);
  return out;
}

/** The largest `ids` array the schema accepts — discovered, not hard-coded, so
 *  this file cannot drift from lib/schemas/task.ts. */
function schemaCap(): number {
  for (let n = 1; n <= 1000; n++) {
    if (!BulkTaskStatusSchema.safeParse({ ids: ids(n), status: "pending" }).success) return n - 1;
  }
  throw new Error("BulkTaskStatusSchema has no ids ceiling at all");
}

beforeEach(() => {
  H.calls.length = 0;
  H.results.clear();
  seat += 1;
  H.session.value = { user: { id: `u-${seat}`, companyId: "c-1", role: "admin" } };
  H.results.set("user.findUnique", { id: `u-${seat}`, name: "Ada", companyId: "c-1" });
  H.results.set("task.updateMany", { count: 0 });
  H.results.set("task.findMany", []);
  H.results.set("activity.create", { id: "a-1" });
  H.results.set("notification.deleteMany", { count: 0 });
});

const ZOD_WORDS = /array|element\(s\)/i;

describe("tasks-and-comments-010 — an over-sized selection gets a sentence, not zod's", () => {
  it("bulkUpdateTaskStatusAction explains the limit in the user's terms", async () => {
    const cap = schemaCap();
    const res = await bulkUpdateTaskStatusAction({ ids: ids(cap + 1), status: "completed" });

    expect(res.success).toBe(false);
    const error = res.success === false ? res.error : "";
    expect(error, `the user is shown zod's own words: "${error}"`).not.toMatch(ZOD_WORDS);
    expect(error, "the message must name the limit").toContain(String(cap));
    expect(error, "and how many they actually selected").toContain(String(cap + 1));
    expect(H.calls.filter((c) => c.path === "task.updateMany").length).toBe(0);
  });

  it("bulkDeleteTasksAction explains the limit too", async () => {
    const cap = schemaCap();
    const res = await bulkDeleteTasksAction({ ids: ids(cap + 1) });

    expect(res.success).toBe(false);
    const error = res.success === false ? res.error : "";
    expect(error, `the user is shown zod's own words: "${error}"`).not.toMatch(ZOD_WORDS);
    expect(error).toContain(String(cap));
    expect(H.calls.filter((c) => c.path === "task.updateMany").length).toBe(0);
  });

  it("a selection AT the limit is still allowed through", async () => {
    const cap = schemaCap();
    const res = await bulkUpdateTaskStatusAction({ ids: ids(cap), status: "completed" });
    expect(res.success, res.success === false ? res.error : "").toBe(true);
  });

  it("an empty selection still says to select something", async () => {
    const res = await bulkUpdateTaskStatusAction({ ids: [], status: "completed" });
    expect(res.success).toBe(false);
    expect(res.success === false && res.error).toMatch(/select at least one/i);
  });

  it("the two schemas agree on one ceiling", () => {
    const cap = schemaCap();
    expect(BulkTaskDeleteSchema.safeParse({ ids: ids(cap) }).success).toBe(true);
    expect(BulkTaskDeleteSchema.safeParse({ ids: ids(cap + 1) }).success).toBe(false);
  });
});
