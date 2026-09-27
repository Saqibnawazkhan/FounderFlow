/**
 * perf-003, in the file this wave owns: `getAccountStats` downloaded EVERY
 * TimeEntry the user has ever logged and added the durations up in JavaScript,
 * to render three cards on /settings.
 *
 * WHAT IT WAS. `db.timeEntry.findMany({ where: { userId } })` with no `take`,
 * then `entries.reduce(durationMs)`. A person who clocks 8 entries a week for
 * three years is 1,200 rows; a workspace-wide equivalent is ~20k. Every
 * /settings load pulled all of them into the Node heap to produce ONE number,
 * which on a serverless function is a memory ceiling rather than a slow page.
 * `entries.length` was doing the same thing for the session count — a COUNT(*)
 * spelled as a full table read.
 *
 * WHAT IT MUST BE. One SUM, grouped by nothing, computed by Postgres.
 *
 * WHY THESE TESTS LOOK LIKE THIS. There is no database here, so the SQL's
 * arithmetic cannot be executed. Two things can be asserted and both are the
 * defect itself rather than a proxy for it:
 *
 *   1. `timeEntry.findMany` is NOT REACHED. That is the finding, stated as a
 *      forbidden operation — the same framing tests/lib/actions/soft-delete.test.ts
 *      uses, because "a query happened and returned a number" was already true
 *      of the broken version.
 *   2. The row the driver hands back is coerced. Postgres `EXTRACT(EPOCH …)`
 *      returns `numeric`, and Prisma maps numeric to `Prisma.Decimal` (and
 *      int8 to `BigInt`), so a raw result is NOT reliably a JS number. An
 *      un-coerced `totalTrackedMs` would serialize across the RSC boundary as a
 *      Decimal object and render as "[object Object]" — or throw
 *      "Do not know how to serialize a BigInt". The cast in the SQL is the first
 *      line of defence and `Number()` is the second.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => {
  const calls: Array<{ path: string; args: unknown[] }> = [];
  const results = new Map<string, unknown>();

  /** Tagged-template form: db.$queryRaw`…` arrives as (strings, ...values). */
  const queryRaw = vi.fn(async (...args: unknown[]) => {
    calls.push({ path: "$queryRaw", args });
    return results.get("$queryRaw") ?? [];
  });
  /** Present so a test can prove it is never reached — a missing method would
   *  fail as a TypeError, which reads like a broken test rather than a finding. */
  const queryRawUnsafe = vi.fn(async (...args: unknown[]) => {
    calls.push({ path: "$queryRawUnsafe", args });
    return [];
  });

  const db: Record<string, unknown> = { $queryRaw: queryRaw, $queryRawUnsafe: queryRawUnsafe };
  for (const model of ["user", "timeEntry"]) {
    const delegate: Record<string, (args?: unknown) => Promise<unknown>> = {};
    for (const op of ["findUnique", "findMany", "count", "aggregate", "groupBy"]) {
      const path = `${model}.${op}`;
      delegate[op] = async (args?: unknown) => {
        calls.push({ path, args: [args] });
        return results.get(path) ?? [];
      };
    }
    db[model] = delegate;
  }

  return { db, calls, results, session: { value: null as unknown } };
});

vi.mock("@/lib/db", () => ({ db: H.db }));
vi.mock("@/lib/auth", () => ({ auth: async () => H.session.value }));

import { getAccountStats } from "@/lib/queries/stats";

function callsTo(path: string): Array<{ path: string; args: unknown[] }> {
  return H.calls.filter((c) => c.path === path);
}

/** The SQL text of the one raw call, template holes elided and whitespace
 *  collapsed — the assertions below are about which SQL constructs are present,
 *  not about how the query is indented. */
function sqlText(): string {
  const call = callsTo("$queryRaw")[0];
  if (!call) return "";
  return (call.args[0] as string[]).join(" ? ").replace(/\s+/g, " ");
}

/** The bound parameters of the one raw call. */
function sqlParams(): unknown[] {
  const call = callsTo("$queryRaw")[0];
  return call ? call.args.slice(1) : [];
}

beforeEach(() => {
  H.calls.length = 0;
  H.results.clear();
  H.session.value = { user: { id: "u1", companyId: "c1", role: "admin", name: "Ada" } };
  H.results.set("user.findUnique", {
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    lastSignInAt: new Date("2026-09-20T08:00:00.000Z"),
  });
  H.results.set("$queryRaw", [{ totalTrackedMs: 3_600_000, sessionCount: 2 }]);
});

describe("getAccountStats() — the time sum (perf-003)", () => {
  it("never downloads the user's time entries", async () => {
    await getAccountStats();
    expect(callsTo("timeEntry.findMany").length).toBe(0);
  });

  it("asks Postgres for the sum, once", async () => {
    await getAccountStats();
    expect(callsTo("$queryRaw").length).toBe(1);
    const sql = sqlText();
    expect(sql).toContain("SUM(");
    expect(sql).toMatch(/EXTRACT\(\s*EPOCH FROM/);
    expect(sql).toContain('"TimeEntry"');
    // Open entries accrue up to now — the JS version credited them via
    // `durationMs(clockInAt, null, now)`, and dropping that would silently
    // zero out the card of anyone currently on the clock.
    expect(sql).toContain('COALESCE("clockOutAt"');
  });

  it("binds the user id instead of interpolating it", async () => {
    await getAccountStats();
    expect(sqlParams()).toContain("u1");
    expect(sqlText()).not.toContain("u1");
    expect(callsTo("$queryRawUnsafe").length).toBe(0);
  });

  it("clamps a negative interval the way durationMs did", async () => {
    // durationMs is `Math.max(0, …)`: an edited entry whose clock-out precedes
    // its clock-in contributed 0, not a negative that ate someone else's hours.
    await getAccountStats();
    expect(sqlText()).toContain("GREATEST");
  });

  it("returns the SQL figures", async () => {
    const stats = await getAccountStats();
    expect(stats.totalTrackedMs).toBe(3_600_000);
    expect(stats.sessionCount).toBe(2);
    expect(stats.memberSince).toBe("2026-01-01T00:00:00.000Z");
    expect(stats.lastSignInAt).toBe("2026-09-20T08:00:00.000Z");
  });

  it("coerces what the driver actually hands back", async () => {
    // numeric → Prisma.Decimal, int8 → BigInt. Either one escaping to the RSC
    // boundary as-is is a render failure, not a rounding one.
    H.results.set("$queryRaw", [{ totalTrackedMs: "5400000", sessionCount: BigInt(7) }]);
    const stats = await getAccountStats();
    expect(stats.totalTrackedMs).toBe(5_400_000);
    expect(stats.sessionCount).toBe(7);
    expect(typeof stats.totalTrackedMs).toBe("number");
    expect(typeof stats.sessionCount).toBe("number");
  });

  it("reads zero when the user has never clocked in", async () => {
    H.results.set("$queryRaw", []);
    const stats = await getAccountStats();
    expect(stats.totalTrackedMs).toBe(0);
    expect(stats.sessionCount).toBe(0);
  });
});
