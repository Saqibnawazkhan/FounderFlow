// @vitest-environment node

/**
 * lib/queries/time.ts — what the three reads ask for.
 *
 * TWO FINDINGS MEET HERE.
 *
 * time-010: `getEntries` is `take: 500` over `clockInAt desc`, and the /time
 * client then computes everything in memory from that array — the "Total tracked"
 * sum, the "N sessions" label and WeeklyTimesheet's per-day buckets. A real
 * customer crosses 500 entries inside a year (one per workday per person, and the
 * team scope counts everyone). After that, paging the Week view back renders
 * "No entries / 0m" for weeks that are populated in the database, which reads as
 * lost data, and the "N sessions" figure silently stops being a count of sessions.
 * The row cap is legitimate; presenting a capped array as a total is not. So the
 * query now reports whether it truncated, and how far back it actually reaches.
 *
 * THE SOFT-DELETE READ FILTER, which prisma/schema.prisma names this file for:
 * "READ FILTERS ARE PART OF THIS COLUMN, not a follow-up: every hours roll-up
 * (lib/queries/time.ts, …) sums rows without asking … A tombstone nobody filters
 * on does not hide a row, it duplicates it." None of the three reads filtered it.
 * The sharpest case is `getOpenEntry`: `deleteTimeEntryAction` tombstones, and
 * `clockInAction` already filters `deletedAt: null` when it checks for an existing
 * open entry — so a user who deleted their own RUNNING timer got a topbar pill
 * ticking a row that `findLiveEntry` refuses to clock out ("Entry not found"),
 * while `clockInAction` happily let them start a new one. The read and the write
 * disagreed about whether the session existed.
 *
 * No database: the assertions are about the QUESTION ASKED. A fake that answered
 * with rows would let a missing `where` clause pass.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScopedSession } from "@/lib/queries/session";

const H = vi.hoisted(() => ({
  calls: [] as { path: string; args: Record<string, unknown> }[],
  rows: { value: [] as Record<string, unknown>[] },
  session: {
    current: {
      userId: "u_admin",
      userName: "Ayesha",
      email: "ayesha@nimbus.app",
      companyId: "c_nimbus",
      role: "admin",
    } as ScopedSession,
  },
}));

vi.mock("@/lib/db", () => {
  const rec = (path: string, args: Record<string, unknown> | undefined) => {
    H.calls.push({ path, args: args ?? {} });
  };
  return {
    db: {
      timeEntry: {
        findMany: async (a: Record<string, unknown>) => {
          rec("timeEntry.findMany", a);
          return H.rows.value;
        },
        findFirst: async (a: Record<string, unknown>) => {
          rec("timeEntry.findFirst", a);
          return H.rows.value[0] ?? null;
        },
      },
    },
  };
});
vi.mock("@/lib/queries/session", () => ({
  requireScopedSession: async () => H.session.current,
}));

import { getClockedInPeers, getEntries, getOpenEntry } from "@/lib/queries/time";

function row(over: Record<string, unknown> = {}) {
  return {
    id: "e1",
    companyId: "c_nimbus",
    userId: "u_admin",
    userName: "Ayesha",
    taskId: null,
    taskTitle: null,
    note: null,
    clockInAt: new Date("2026-05-24T09:00:00.000Z"),
    clockOutAt: new Date("2026-05-24T11:00:00.000Z"),
    lastActivityAt: new Date("2026-05-24T11:00:00.000Z"),
    autoClosed: false,
    editedBy: null,
    editedByName: null,
    editedAt: null,
    createdAt: new Date("2026-05-24T09:00:00.000Z"),
    ...over,
  };
}

function whereOf(path: string): Record<string, unknown> {
  const call = H.calls.find((c) => c.path === path);
  expect(call, `no ${path} was issued`).toBeDefined();
  return (call!.args.where ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
  H.calls.length = 0;
  H.rows.value = [row()];
  H.session.current = {
    userId: "u_admin",
    userName: "Ayesha",
    email: "ayesha@nimbus.app",
    companyId: "c_nimbus",
    role: "admin",
  };
});

describe("a tombstoned time entry is gone from every read", () => {
  it("getOpenEntry does not resurrect a deleted running timer", async () => {
    await getOpenEntry();
    expect(
      whereOf("timeEntry.findFirst").deletedAt,
      "the topbar showed a pill for a row clockOutAction refuses to close"
    ).toBeNull();
  });

  it("getEntries hides tombstones from the list and its totals", async () => {
    await getEntries("mine");
    expect(whereOf("timeEntry.findMany").deletedAt).toBeNull();
  });

  it("getClockedInPeers does not count a deleted entry as somebody on the clock", async () => {
    await getClockedInPeers();
    expect(whereOf("timeEntry.findMany").deletedAt).toBeNull();
  });
});

describe("getEntries reports its own ceiling", () => {
  it("says nothing was truncated when the workspace is inside the cap", async () => {
    H.rows.value = [row({ id: "a" }), row({ id: "b" })];
    const page = await getEntries("mine");
    expect(page.entries).toHaveLength(2);
    expect(page.truncated).toBe(false);
  });

  it("truncates to the cap, drops the probe row, and says so", async () => {
    const many = Array.from({ length: 4_000 }, (_, i) =>
      row({ id: `e${i}`, clockInAt: new Date(Date.now() - i * 86_400_000) })
    );
    H.rows.value = many;

    const page = await getEntries("mine");
    const take = H.calls.find((c) => c.path === "timeEntry.findMany")!.args.take as number;

    expect(page.truncated, "a capped array presented as a total is the finding").toBe(true);
    expect(page.entries.length, "the has-more probe row must not reach the client").toBe(take - 1);
  });

  it("reports how far back the loaded window actually reaches", async () => {
    // This is what lets the Week view say "weeks before X aren't loaded" instead
    // of rendering seven empty cells and a "Week total 0m" for a week that has
    // rows in the database.
    const oldest = new Date("2025-01-02T08:00:00.000Z");
    H.rows.value = Array.from({ length: 4_000 }, (_, i) =>
      row({
        id: `e${i}`,
        clockInAt: new Date(oldest.getTime() + (4_000 - i) * 3_600_000),
      })
    );
    const page = await getEntries("mine");
    expect(page.truncated).toBe(true);
    expect(page.oldestLoadedAt, "the horizon has to be the oldest row SHOWN").toBe(
      page.entries[page.entries.length - 1].clockInAt
    );
  });

  it("has no horizon to report when nothing was truncated", async () => {
    H.rows.value = [row()];
    const page = await getEntries("mine");
    expect(page.oldestLoadedAt).toBeNull();
  });

  it("still refuses team scope to a member", async () => {
    // Guard-the-guard: the reshaped return value must not lose the existing
    // privilege check.
    H.session.current = { ...H.session.current, role: "member" };
    await getEntries("team");
    const where = whereOf("timeEntry.findMany");
    expect(where.userId).toBe("u_admin");
    expect(where.companyId).toBeUndefined();
  });
});
