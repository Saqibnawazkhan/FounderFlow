// @vitest-environment node

/**
 * cron-010 — the nightly auto-close sweep was editing rows inside workspaces
 * that had been deleted and were still inside their 90-day recovery window, and
 * rows that had been individually deleted.
 *
 * `sweepAutoCloseEntries`'s query was `{ clockOutAt: null, lastActivityAt: { lt:
 * cutoff } }` and nothing else. Two things were missing from it:
 *
 *   1. `company: { deletedAt: null }`. The materializer next door takes the
 *      opposite line DELIBERATELY and says why at
 *      app/api/cron/materialize-recurring/route.ts: "Without the company filter
 *      a tombstoned workspace keeps minting brand-new LIVE transactions every
 *      night … resurrecting 'deleted' data." So for the whole retention window
 *      the sweep wrote `clockOutAt` and `autoClosed: true` into rows an operator
 *      may still restore, and a restored workspace came back with timesheets
 *      closed after the deletion, at times nobody chose. For a workspace whose
 *      time data feeds invoicing that is a billing discrepancy, and the two
 *      background jobs disagreeing about the same rule is how the third one
 *      gets it wrong too.
 *
 *   2. `deletedAt: null` ON THE ENTRY. Not in the filing, and worse in one
 *      respect: `TimeEntry` became a soft-delete table on 2026-09-29, and
 *      `deleteTimeEntryAction` now writes a tombstone precisely so that a
 *      member's mis-click no longer destroys billable hours and their
 *      editedBy/editedAt audit trail. The sweep then reached straight past that
 *      tombstone and rewrote the row's clock-out anyway, so the recovered entry
 *      would not match what was deleted.
 *
 * WHAT IS DELIBERATELY NOT ADDED, against the filing's own suggestion:
 * `user: { deletedAt: null }`. A deactivated person in a LIVE workspace cannot
 * log in to stop their own timer, so filtering them out leaves an entry running
 * for ever — which is worse data than an honest `autoClosed: true` stamped at
 * their last heartbeat, and it is not pending anybody's restoration. The
 * whole-workspace case is already covered, because `softDeleteWorkspace`
 * tombstones the User rows along with the Company. See the note in
 * lib/cron/live-scope.ts.
 *
 * THE FAKE HONOURS `where`. That is the whole precision of this file: it applies
 * a clause only when the query actually asks for it, so every assertion below
 * fails against the unfixed sweep and passes against the fixed one. A fake that
 * returned a canned list would pass either way — the vacuous shape this repo
 * keeps re-finding.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

type Row = {
  id: string;
  clockOutAt: Date | null;
  deletedAt: Date | null;
  lastActivityAt: Date;
  userId: string;
  companyId: string;
  company: { deletedAt: Date | null };
  user: { deletedAt: Date | null };
};

const H = vi.hoisted(() => ({
  rows: [] as unknown[],
  updates: [] as string[],
  /** Every `where` the sweep issued, so a test can assert on the query itself. */
  queries: [] as unknown[],
}));

vi.mock("@/lib/db", () => ({
  db: {
    timeEntry: {
      findMany: async (args: { where?: Record<string, unknown> }) => {
        H.queries.push(args?.where);
        const where = (args?.where ?? {}) as Record<string, unknown>;
        const has = (k: string) => Object.prototype.hasOwnProperty.call(where, k);
        return (H.rows as Row[]).filter((r) => {
          if (has("clockOutAt") && where.clockOutAt === null && r.clockOutAt !== null) return false;
          if (has("deletedAt") && where.deletedAt === null && r.deletedAt !== null) return false;
          if (has("lastActivityAt")) {
            const lt = (where.lastActivityAt as { lt?: Date }).lt;
            if (lt && !(r.lastActivityAt.getTime() < lt.getTime())) return false;
          }
          if (has("company")) {
            const c = where.company as { deletedAt?: unknown };
            if (c.deletedAt === null && r.company.deletedAt !== null) return false;
          }
          if (has("user")) {
            const u = where.user as { deletedAt?: unknown };
            if (u.deletedAt === null && r.user.deletedAt !== null) return false;
          }
          return true;
        });
      },
      update: async (args: { where: { id: string } }) => {
        H.updates.push(args.where.id);
        return {};
      },
      // data-integrity-007 moved the write to `updateMany` so the "is it still
      // open" guard lives in the statement. It honours the same `where` the read
      // does, so a row this fake would not have returned is not updated either.
      updateMany: async (args: { where: Record<string, unknown> }) => {
        const id = args.where.id;
        const row = (H.rows as Row[]).filter((r) => r.id === id)[0];
        const stillOpen = Boolean(row) && row.clockOutAt === null && row.deletedAt === null;
        if (!stillOpen) return { count: 0 };
        H.updates.push(String(id));
        return { count: 1 };
      },
    },
  },
}));
vi.mock("@/lib/sentry-server", () => ({ captureServerError: vi.fn() }));

import { sweepAutoCloseEntries } from "@/lib/time/sweep";
import { AUTO_CLOSE_MS } from "@/lib/time/thresholds";

const STALE = new Date(Date.now() - AUTO_CLOSE_MS - 60_000);
const TOMBSTONE = new Date("2026-08-01T00:00:00Z");

function entry(id: string, over: Partial<Row> = {}): Row {
  return {
    id,
    clockOutAt: null,
    deletedAt: null,
    lastActivityAt: STALE,
    userId: "u_1",
    companyId: "c_1",
    company: { deletedAt: null },
    user: { deletedAt: null },
    ...over,
  };
}

beforeEach(() => {
  H.rows.length = 0;
  H.updates.length = 0;
  H.queries.length = 0;
});

describe("cron-010 — the sweep leaves deleted data alone", () => {
  it("does not close a stale entry inside a tombstoned workspace", () => {
    H.rows.push(entry("e_deleted_ws", { company: { deletedAt: TOMBSTONE } }));
    return sweepAutoCloseEntries().then((result) => {
      expect(H.updates).toEqual([]);
      expect(result.attempted).toBe(0);
    });
  });

  it("does not rewrite the clock-out of a soft-deleted entry", () => {
    H.rows.push(entry("e_tombstoned", { deletedAt: TOMBSTONE }));
    return sweepAutoCloseEntries().then(() => {
      expect(H.updates).toEqual([]);
    });
  });

  it("still closes a stale entry in a live workspace — the job must keep working", () => {
    H.rows.push(entry("e_live"));
    return sweepAutoCloseEntries().then((result) => {
      expect(H.updates).toEqual(["e_live"]);
      expect(result.closed).toEqual(["e_live"]);
    });
  });

  it("still closes a DEACTIVATED person's stale timer in a live workspace", () => {
    // The deliberate non-change. Nobody can stop this timer from the product, so
    // refusing to close it leaves it running for ever.
    H.rows.push(entry("e_deactivated", { user: { deletedAt: TOMBSTONE } }));
    return sweepAutoCloseEntries().then(() => {
      expect(H.updates).toEqual(["e_deactivated"]);
    });
  });

  it("sorts a mixed night correctly rather than all-or-nothing", () => {
    H.rows.push(
      entry("e_live_1"),
      entry("e_deleted_ws", { company: { deletedAt: TOMBSTONE } }),
      entry("e_tombstoned", { deletedAt: TOMBSTONE }),
      entry("e_live_2"),
      // Not stale: still heartbeating, so out of scope for a different reason.
      entry("e_fresh", { lastActivityAt: new Date() })
    );
    return sweepAutoCloseEntries().then((result) => {
      expect(H.updates.sort()).toEqual(["e_live_1", "e_live_2"]);
      expect(result.attempted).toBe(2);
    });
  });

  it("asks the database for the scope, rather than filtering afterwards", () => {
    // A post-hoc filter would read every open entry in every deleted workspace
    // into memory every night. The scope belongs in the query.
    H.rows.push(entry("e_live"));
    return sweepAutoCloseEntries().then(() => {
      expect(H.queries[0]).toMatchObject({
        clockOutAt: null,
        deletedAt: null,
        company: { deletedAt: null },
      });
    });
  });
});
