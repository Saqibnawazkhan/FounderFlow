/**
 * <ClockWidget> — what the topbar does when a heartbeat is REFUSED.
 *
 * time-015's server half closes a session that has been open past AUTO_CLOSE_MS
 * and answers the heartbeat with a failure (see `heartbeatAction`). That fix is
 * only half a fix if the widget ignores the answer: the client's `beat()` did
 *
 *     if (!cancelled && res.success) setEntry(...)
 *
 * and nothing at all on failure. So the row was closed in the database while the
 * pill kept ticking in every open tab, and stayed that way until the next full
 * navigation — a timer the user cannot stop, counting time that is no longer being
 * recorded. That is this repo's signature defect (a correct decision with no road
 * to it) one layer up, so it gets its own test rather than trusting the action's.
 *
 * A refused heartbeat is also the right trigger in general: it means this tab's
 * copy of the entry may be stale for any reason — the row was deleted, the cron
 * swept it, another tab clocked out — so the widget reconciles instead of guessing.
 *
 * Timers are faked because the heartbeat interval is HEARTBEAT_MS (5 min) and this
 * test is not willing to wait. `document.hidden` is false in jsdom, which is
 * exactly the case the finding is about: the heartbeat loop only runs on a VISIBLE
 * tab, and the visible tab was the unbounded one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { HEARTBEAT_MS } from "@/lib/time/thresholds";
import type { TimeEntryClient } from "@/lib/queries/time";

const openEntry: TimeEntryClient = {
  id: "e_marathon",
  companyId: "c_nimbus",
  userId: "u_admin",
  userName: "Ayesha",
  taskId: null,
  taskTitle: "Night deploy",
  note: null,
  // Friday afternoon, still running on Monday: 40 hours of a tab on a second
  // monitor, every one of which the heartbeat had been keeping alive.
  clockInAt: new Date(Date.now() - 40 * 3_600_000).toISOString(),
  clockOutAt: null,
  lastActivityAt: new Date(Date.now() - 60_000).toISOString(),
  autoClosed: false,
  editedBy: null,
  editedByName: null,
  editedAt: null,
  createdAt: new Date(Date.now() - 40 * 3_600_000).toISOString(),
};

const H = vi.hoisted(() => ({
  openEntry: { value: null as unknown },
  heartbeat: {
    result: { success: true } as { success: boolean; error?: string; data?: undefined },
  },
  getOpenEntryCalls: { n: 0 },
}));

vi.mock("@/lib/actions/time", () => ({
  getOpenEntryAction: async () => {
    H.getOpenEntryCalls.n += 1;
    return { success: true, data: { openEntry: H.openEntry.value, tasks: [] } };
  },
  heartbeatAction: async () => H.heartbeat.result,
  clockInAction: async () => ({ success: true, data: { entryId: "x" } }),
  clockOutAction: async () => ({ success: true, data: undefined }),
  autoCloseEntryAction: async () => ({ success: true, data: undefined }),
}));
// ONE router object, not a fresh one per render. `useRouter` is stable in Next,
// and the widget's heartbeat effect lists it as a dependency — a mock that
// returned a new object each render would tear the 5-minute interval down and
// rebuild it on every tick of the 1-second display ticker, so the heartbeat could
// never fire and this file would report a bug that only its own mock had.
const stableRouter = { refresh: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => stableRouter }));
vi.mock("@/lib/i18n/use-t", () => ({
  useNumberFormat: () => ({ number: (v: number) => String(v) }),
}));
vi.mock("react-hot-toast", () => {
  const toast = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });
  return { default: toast, toast };
});

import { ClockWidget } from "@/components/time/clock-widget";

beforeEach(() => {
  H.openEntry.value = openEntry;
  H.heartbeat.result = { success: true };
  H.getOpenEntryCalls.n = 0;
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

async function mounted() {
  render(<ClockWidget />);
  await waitFor(() => expect(screen.getByRole("button", { name: /Clocked in/i })).toBeTruthy());
}

describe("ClockWidget — a refused heartbeat", () => {
  it("stops showing a running timer once the server has closed the session", async () => {
    await mounted();

    // The server hits the elapsed-time bound and closes the row.
    H.heartbeat.result = {
      success: false,
      error: "Session passed the 13h limit and was closed.",
    };
    H.openEntry.value = null;

    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS + 1_000);

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Clock in" }),
        "the pill kept ticking a session the database had already closed"
      ).toBeTruthy()
    );
  });

  it("re-reads its state rather than trusting the stale copy", async () => {
    await mounted();
    const before = H.getOpenEntryCalls.n;

    H.heartbeat.result = { success: false, error: "Entry not found" };
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS + 1_000);

    await waitFor(() =>
      expect(
        H.getOpenEntryCalls.n,
        "a refused heartbeat means this tab's copy may be stale for any reason"
      ).toBeGreaterThan(before)
    );
  });

  it("leaves the running pill alone while heartbeats keep succeeding", async () => {
    // Guard-the-guard: the reconcile must not fire on the happy path, or every
    // tab re-reads its state every five minutes for nothing.
    await mounted();
    const before = H.getOpenEntryCalls.n;

    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS + 1_000);

    expect(screen.getByRole("button", { name: /Clocked in/i })).toBeTruthy();
    expect(H.getOpenEntryCalls.n).toBe(before);
  });
});
