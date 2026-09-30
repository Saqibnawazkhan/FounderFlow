// @vitest-environment node

/**
 * data-integrity-007 — the nightly sweep could move a real clock-out back by up
 * to twelve and a half hours and label it "auto-closed".
 *
 * `sweepAutoCloseEntries` reads every stale open entry, then writes each one with
 * `db.timeEntry.update({ where: { id: s.id }, data: { clockOutAt:
 * s.lastActivityAt, autoClosed: true } })` — the primary key alone, with no
 * re-check that the entry is still open. The loop is deliberately NOT one
 * transaction ("one stuck row shouldn't block sweeping the other 99"), so every
 * row carries its own window between the snapshot and its write, and `AUTO_CLOSE_MS`
 * is 12.5 hours.
 *
 * WHAT THE USER SEES. They finish a long session and clock out at 18:00. The
 * sweep, holding a snapshot taken moments earlier, writes `clockOutAt =
 * lastActivityAt` — 05:30 — and `autoClosed: true`. So the entry now ends twelve
 * hours before they stopped working, the duration is wrong, and the audit trail
 * says the system ended it. There is no previous value anywhere: `TimeEntry` has
 * no history column, so the original clock-out is simply gone and the customer's
 * own record contradicts them on an hours-based invoice.
 *
 * THE FIX IS THE SAME SHAPE AS data-integrity-006's: put the guard in the
 * statement. `updateMany({ where: { id, clockOutAt: null, deletedAt: null } })`,
 * and read `count === 0` as "the user beat us to it" — which is a normal,
 * expected outcome of a sweep, not a failure, and must not be reported as one.
 *
 * THE FAKE INTERLEAVES AFTER THE READ, on purpose. A sequential test — close the
 * entry, then run the sweep — passes against the BUG, because the stale query
 * already filters `clockOutAt: null` so the row is simply not in the snapshot.
 * The defect only exists in the window between the snapshot and the write, so
 * that is the only thing worth simulating.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

type Row = {
  id: string;
  clockOutAt: Date | null;
  deletedAt: Date | null;
  lastActivityAt: Date;
  userId: string;
  companyId: string;
  autoClosed: boolean;
  company: { deletedAt: Date | null };
};

const H = vi.hoisted(() => ({
  rows: [] as unknown[],
  /** Entry ids to close the instant the sweep's snapshot has been handed over. */
  closeAfterRead: [] as string[],
  /** The clock-out the competing user wrote. */
  userClosedAt: new Date("2026-09-30T18:00:00Z"),
}));

function matches(row: Row, where: Record<string, unknown>): boolean {
  const has = (k: string) => Object.prototype.hasOwnProperty.call(where, k);
  if (has("id") && row.id !== where.id) return false;
  if (has("clockOutAt") && where.clockOutAt === null && row.clockOutAt !== null) return false;
  if (has("deletedAt") && where.deletedAt === null && row.deletedAt !== null) return false;
  if (has("lastActivityAt")) {
    const lt = (where.lastActivityAt as { lt?: Date }).lt;
    if (lt && !(row.lastActivityAt.getTime() < lt.getTime())) return false;
  }
  if (has("company")) {
    const c = where.company as { deletedAt?: unknown };
    if (c.deletedAt === null && row.company.deletedAt !== null) return false;
  }
  return true;
}

vi.mock("@/lib/db", () => ({
  db: {
    timeEntry: {
      findMany: async (args: { where?: Record<string, unknown> }) => {
        const found = (H.rows as Row[]).filter((r) => matches(r, args?.where ?? {}));
        // Hand back SNAPSHOTS, then let the competing clock-out land. The sweep
        // therefore holds a read that was true when it was taken.
        const snapshots = found.map((r) => ({ ...r }));
        for (const id of H.closeAfterRead) {
          const row = (H.rows as Row[]).filter((r) => r.id === id)[0];
          if (row) row.clockOutAt = H.userClosedAt;
        }
        H.closeAfterRead.length = 0;
        return snapshots;
      },
      update: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const row = (H.rows as Row[]).filter((r) => matches(r, args.where))[0];
        if (!row) throw new Error("P2025: record not found");
        Object.assign(row, args.data);
        return row;
      },
      updateMany: async (args: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const found = (H.rows as Row[]).filter((r) => matches(r, args.where));
        for (const row of found) Object.assign(row, args.data);
        return { count: found.length };
      },
    },
  },
}));
vi.mock("@/lib/sentry-server", () => ({ captureServerError: vi.fn() }));

import { sweepAutoCloseEntries } from "@/lib/time/sweep";
import { AUTO_CLOSE_MS } from "@/lib/time/thresholds";

const STALE_AT = new Date(Date.now() - AUTO_CLOSE_MS - 60_000);

function entry(id: string, over: Partial<Row> = {}): Row {
  return {
    id,
    clockOutAt: null,
    deletedAt: null,
    lastActivityAt: STALE_AT,
    userId: "u_1",
    companyId: "c_1",
    autoClosed: false,
    company: { deletedAt: null },
    ...over,
  };
}

function byId(id: string): Row {
  return (H.rows as Row[]).filter((r) => r.id === id)[0];
}

beforeEach(() => {
  H.rows.length = 0;
  H.closeAfterRead.length = 0;
});

describe("data-integrity-007 — the sweep cannot overwrite a clock-out the user made", () => {
  it("leaves the user's own end time alone when they clock out mid-sweep", async () => {
    H.rows.push(entry("te_raced"));
    H.closeAfterRead.push("te_raced");

    await sweepAutoCloseEntries();

    // The whole finding. Before the fix this was STALE_AT — up to 12.5 hours
    // earlier than the moment the person actually stopped working.
    expect(byId("te_raced").clockOutAt).toBe(H.userClosedAt);
  });

  it("does not label a session the user ended as auto-closed", async () => {
    // Worse than the wrong timestamp: `autoClosed` is the column that says the
    // system ended the session because the person went away. It is the record an
    // hours-based invoice is defended with, and TimeEntry has no history column,
    // so nothing anywhere holds the value it replaced.
    H.rows.push(entry("te_raced"));
    H.closeAfterRead.push("te_raced");

    await sweepAutoCloseEntries();

    expect(byId("te_raced").autoClosed).toBe(false);
  });

  it("does not report losing the race as a failure — it is a normal night", async () => {
    // A sweep that 500s (or pages on-call) because a user clocked themselves out
    // would turn correct behaviour into an incident. `withCronCheckIn` and the
    // route's 500-on-failure contract both read `failed`.
    H.rows.push(entry("te_raced"));
    H.closeAfterRead.push("te_raced");

    const result = await sweepAutoCloseEntries();

    expect(result.failed).toEqual([]);
    expect(result.closed).toEqual([]);
  });

  it("still closes the entries nobody touched, in the same run", async () => {
    // The sweep must keep working: one raced row cannot stop the other 99.
    H.rows.push(entry("te_raced"), entry("te_untouched_1"), entry("te_untouched_2"));
    H.closeAfterRead.push("te_raced");

    const result = await sweepAutoCloseEntries();

    expect(result.closed.sort()).toEqual(["te_untouched_1", "te_untouched_2"]);
    expect(byId("te_untouched_1").clockOutAt).toBe(STALE_AT);
    expect(byId("te_untouched_1").autoClosed).toBe(true);
  });

  it("guard-the-guard: with nobody racing it, the sweep closes the row", async () => {
    // Without this, every assertion above would pass against a sweep that had
    // simply stopped writing anything at all.
    H.rows.push(entry("te_plain"));
    const result = await sweepAutoCloseEntries();
    expect(result.closed).toEqual(["te_plain"]);
    expect(byId("te_plain").clockOutAt).toBe(STALE_AT);
    expect(byId("te_plain").autoClosed).toBe(true);
  });
});
