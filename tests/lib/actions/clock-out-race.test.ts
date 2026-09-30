// @vitest-environment node

/**
 * data-integrity-006, the half that needs no schema change: a double clock-out
 * rewrites an already-closed entry's end time.
 *
 * `clockOutAction` read the row, checked `entry.clockOutAt`, and then called
 * `closeEntry`, which did `db.timeEntry.update({ where: { id } })` — the id and
 * nothing else. Two statements, no transaction, and no condition on the write. So
 * the guard held for a user clicking once and did nothing at all for two requests
 * that interleave between the read and the update: a double-click, a second tab,
 * or the idle-modal auto-close landing at the same moment as the person pressing
 * the button. The second write wins and the entry's `clockOutAt` becomes the later
 * instant, silently inflating the tracked hours — and for the auto-close path it
 * also flips `autoClosed`, so the record now claims the system ended a session the
 * user ended themselves.
 *
 * THE FIX IS THE CONDITION, NOT A LONGER CHECK. `updateMany({ where: { id,
 * clockOutAt: null } })` makes the guard and the write one statement, which is
 * the only version of this that is correct under concurrency. `count === 0` then
 * means "somebody else closed it", which is exactly the information the two
 * callers need — and they want OPPOSITE things with it: the person pressing the
 * button is told "Already clocked out", while the idle auto-close stays
 * idempotent and reports success, because its job is done either way and telling
 * a background timer off is noise.
 *
 * `deletedAt: null` is in the condition too. `deleteTimeEntryAction` tombstones
 * rather than hard-deletes (data-integrity-001), so without it a clock-out could
 * write an end time onto an entry the user had already deleted.
 *
 * WHAT THIS DOES NOT FIX, stated so nobody reads it as closing the finding.
 * The mirror race in `clockInAction` — read "am I clocked in", then create —
 * cannot be closed from application code. Two interleaved requests both see no
 * open entry and both insert, and no transaction helps at READ COMMITTED because
 * there is no row to lock. It needs
 * `CREATE UNIQUE INDEX "TimeEntry_one_open_per_user" ON "TimeEntry"("userId")
 * WHERE "clockOutAt" IS NULL` in a hand-written migration (Prisma has no syntax
 * for a partial unique index) plus a P2002 catch. That is a schema change and is
 * recorded, not made.
 *
 * The fake honours the `where` it is given. A fake that updated whatever it was
 * handed would pass against both versions of `closeEntry`.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

type Row = {
  id: string;
  userId: string;
  companyId: string;
  clockOutAt: Date | null;
  deletedAt: Date | null;
  lastActivityAt: Date;
  autoClosed: boolean;
};

const H = vi.hoisted(() => ({
  rows: [] as unknown[],
  session: { value: null as unknown },
  /**
   * Arms the interleaving. When set, the NEXT read hands the caller a snapshot of
   * the row as it was — open — and then closes the real row before returning, so
   * the caller proceeds on a read that was true when it was taken and false by
   * the time it writes. That is the actual race; a sequential double-click is
   * caught by the old read-then-check too, which is why a test built on one
   * passes against the bug.
   */
  raceAfterRead: { at: null as Date | null },
}));

function find(where: Record<string, unknown>): Row[] {
  const has = (k: string) => Object.prototype.hasOwnProperty.call(where, k);
  return (H.rows as Row[]).filter((r) => {
    if (has("id") && r.id !== where.id) return false;
    if (has("userId") && r.userId !== where.userId) return false;
    if (has("clockOutAt") && where.clockOutAt === null && r.clockOutAt !== null) return false;
    if (has("deletedAt") && where.deletedAt === null && r.deletedAt !== null) return false;
    return true;
  });
}

/**
 * One read. Returns a COPY, so the caller cannot observe a later mutation through
 * the object it was handed — which is the whole point of the interleaving below.
 */
function read(where: Record<string, unknown>): Row | null {
  const [row] = find(where);
  if (!row) return null;
  const snapshot = { ...row };
  if (H.raceAfterRead.at !== null) {
    row.clockOutAt = H.raceAfterRead.at;
    H.raceAfterRead.at = null;
  }
  return snapshot;
}

vi.mock("@/lib/db", () => ({
  db: {
    timeEntry: {
      findUnique: async (args: { where: Record<string, unknown> }) => read(args.where),
      findFirst: async (args: { where: Record<string, unknown> }) => read(args.where),
      update: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const [row] = find(args.where);
        if (!row) throw new Error("P2025: record not found");
        Object.assign(row, args.data);
        return row;
      },
      updateMany: async (args: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const matched = find(args.where);
        for (const row of matched) Object.assign(row, args.data);
        return { count: matched.length };
      },
    },
  },
}));
vi.mock("@/lib/auth", () => ({ auth: async () => H.session.value }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/sentry-server", () => ({ captureServerError: vi.fn() }));

import { clockOutAction, autoCloseEntryAction } from "@/lib/actions/time";

const T0 = new Date("2026-09-30T09:00:00Z");
const LAST_SEEN = new Date("2026-09-30T11:30:00Z");

type Result = { success: boolean; error?: string };

function entry(over: Partial<Row> = {}): Row {
  return {
    id: "te_1",
    userId: "u_ayesha",
    companyId: "c_nimbus",
    clockOutAt: null,
    deletedAt: null,
    lastActivityAt: LAST_SEEN,
    autoClosed: false,
    ...over,
  };
}

function row(): Row {
  return H.rows[0] as Row;
}

beforeEach(() => {
  H.rows.length = 0;
  H.raceAfterRead.at = null;
  H.session.value = { user: { id: "u_ayesha", companyId: "c_nimbus", role: "member" } };
});

describe("data-integrity-006 — a second clock-out cannot rewrite the first", () => {
  it("does not move the end time when the same entry is closed twice", async () => {
    H.rows.push(entry());
    const first = (await clockOutAction({ entryId: "te_1" })) as Result;
    expect(first.success).toBe(true);
    const closedAt = row().clockOutAt;
    expect(closedAt).not.toBeNull();

    const second = (await clockOutAction({ entryId: "te_1" })) as Result;
    expect(second.success).toBe(false);
    expect(second.error).toMatch(/already clocked out/i);
    // The load-bearing assertion: the stored end time is untouched. Before the
    // fix the second write landed and the tracked duration grew.
    expect(row().clockOutAt).toBe(closedAt);
  });

  it("the write itself carries the guard, so an interleaved request loses", async () => {
    // THE RACE, not a sequential double-click. The caller reads the row as open —
    // which it genuinely was — and the other request closes it before this one
    // writes. The old `update({ where: { id } })` then landed and moved the end
    // time; `updateMany({ where: { id, clockOutAt: null } })` matches nothing.
    H.rows.push(entry());
    H.raceAfterRead.at = T0;
    const result = (await clockOutAction({ entryId: "te_1" })) as Result;
    expect(row().clockOutAt).toBe(T0);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/already clocked out/i);
  });

  it("an interleaved AUTO-close cannot relabel an entry the user just closed", async () => {
    // Worse than a wrong timestamp: `autoClosed: true` is the column that says
    // "the system ended this session because you went away". Winning this race
    // put that claim on a session the person ended deliberately, and it is the
    // record an hours-based invoice is defended with.
    H.rows.push(entry());
    H.raceAfterRead.at = T0;
    const result = (await autoCloseEntryAction({ entryId: "te_1" })) as Result;
    expect(result.success).toBe(true); // idempotent for a background timer
    expect(row().clockOutAt).toBe(T0);
    expect(row().autoClosed).toBe(false);
  });

  it("does not let a clock-out write an end time onto a deleted entry", async () => {
    // `deleteTimeEntryAction` tombstones rather than hard-deletes, so the row is
    // still physically there to be updated.
    H.rows.push(entry({ deletedAt: new Date("2026-09-29T00:00:00Z") }));
    const result = (await clockOutAction({ entryId: "te_1" })) as Result;
    expect(result.success).toBe(false);
    expect(row().clockOutAt).toBeNull();
  });

  it("still closes an open entry on the first, honest click", async () => {
    H.rows.push(entry());
    const result = (await clockOutAction({
      entryId: "te_1",
      note: "shipped the invoice",
    })) as Result;
    expect(result.success).toBe(true);
    expect(row().clockOutAt).not.toBeNull();
    expect(row().autoClosed).toBe(false);
  });
});

describe("data-integrity-006 — the idle auto-close stays idempotent", () => {
  it("reports success without rewriting an entry the user already closed", async () => {
    // The two callers want OPPOSITE things from `count === 0`. A person pressing
    // the button wants to be told; a background timer finishing a job that is
    // already done is not an error, and it must not relabel the entry
    // `autoClosed` after the user closed it themselves.
    H.rows.push(entry({ clockOutAt: T0, autoClosed: false }));
    const result = (await autoCloseEntryAction({ entryId: "te_1" })) as Result;
    expect(result.success).toBe(true);
    expect(row().clockOutAt).toBe(T0);
    expect(row().autoClosed).toBe(false);
  });

  it("closes an open entry at the last heartbeat, not at now", async () => {
    H.rows.push(entry());
    const result = (await autoCloseEntryAction({ entryId: "te_1" })) as Result;
    expect(result.success).toBe(true);
    expect(row().clockOutAt).toBe(LAST_SEEN);
    expect(row().autoClosed).toBe(true);
  });
});
