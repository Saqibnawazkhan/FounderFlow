/**
 * time-010, the half a customer sees: /time stops claiming totals it does not
 * have, and the Week view stops reporting weeks it did not fetch as empty.
 *
 * `getEntries` is capped (MAX_ENTRY_PAGE), and the client computed everything from
 * that array: the "Total tracked" sum, the "N sessions" label, and every WeeklyTimesheet
 * bucket. One entry per workday crosses the cap in two years for one person and in
 * about three months for a team of eight, and then two things happen, both silent:
 *
 *   • "N sessions" stops being a count of sessions, and disagrees with the
 *     lifetime total on /settings, which sums every row in SQL.
 *   • Paging the Week view past the loaded window renders seven "No entries" cells
 *     and "Week total 0m" for a week that is populated in the database. Empty cells
 *     where real work happened read as lost data — the worst thing a timesheet can
 *     say — and the user has no way to tell that apart from a week they took off.
 *
 * The cap is not the bug; presenting a window as a total is. So these tests assert
 * that the page says which window it is describing, and that a week outside that
 * window says so instead of reporting zero.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { WeeklyTimesheet } from "@/components/time/weekly-timesheet";
import type { TimeEntryClient } from "@/lib/queries/time";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-dialog", () => ({ useConfirm: () => async () => false }));
vi.mock("@/lib/i18n/use-t", () => ({
  useNumberFormat: () => ({ number: (v: number) => String(v) }),
}));
vi.mock("react-hot-toast", () => {
  const toast = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });
  return { default: toast, toast };
});
vi.mock("@/lib/actions/time", () => ({
  deleteTimeEntryAction: vi.fn(),
  updateTimeEntryAction: vi.fn(),
  createManualEntryAction: vi.fn(),
}));

import { TimeClient } from "@/app/(app)/time/time-client";

const RENDERED_AT = new Date(2026, 4, 27, 12, 0, 0);

function entry(over: Partial<TimeEntryClient> = {}): TimeEntryClient {
  return {
    id: "e1",
    companyId: "c_nimbus",
    userId: "u_admin",
    userName: "Ayesha",
    taskId: null,
    taskTitle: "Ship the invoice screen",
    note: null,
    clockInAt: new Date(2026, 4, 27, 9, 0).toISOString(),
    clockOutAt: new Date(2026, 4, 27, 11, 0).toISOString(),
    lastActivityAt: new Date(2026, 4, 27, 11, 0).toISOString(),
    autoClosed: false,
    editedBy: null,
    editedByName: null,
    editedAt: null,
    createdAt: new Date(2026, 4, 27, 9, 0).toISOString(),
    ...over,
  };
}

describe("WeeklyTimesheet — a week outside the loaded window", () => {
  it("says the week was not loaded instead of reporting it as empty", () => {
    // The loaded window starts on 25 May; the grid is showing the week of 11 May.
    render(
      <WeeklyTimesheet
        entries={[entry()]}
        showPerson={false}
        renderedAt={RENDERED_AT}
        initialWeekStart={new Date(2026, 4, 11)}
        loadedSince={new Date(2026, 4, 25, 8, 0)}
      />
    );

    expect(
      screen.queryByText(/Week total/i),
      "a total of 0m for a week nobody fetched is a claim, not a blank"
    ).toBeNull();
    expect(screen.getByText(/aren't loaded/i)).toBeTruthy();
    expect(screen.queryByText("No entries")).toBeNull();
  });

  it("draws the grid normally for a week inside the loaded window", () => {
    // Guard-the-guard: the notice must not swallow the ordinary case.
    render(
      <WeeklyTimesheet
        entries={[entry()]}
        showPerson={false}
        renderedAt={RENDERED_AT}
        initialWeekStart={new Date(2026, 4, 25)}
        loadedSince={new Date(2026, 4, 25, 8, 0)}
      />
    );
    expect(screen.getByText(/Week total/i)).toBeTruthy();
    expect(screen.queryByText(/aren't loaded/i)).toBeNull();
  });

  it("draws every week when nothing was truncated", () => {
    render(
      <WeeklyTimesheet
        entries={[entry()]}
        showPerson={false}
        renderedAt={RENDERED_AT}
        initialWeekStart={new Date(2020, 0, 6)}
        loadedSince={null}
      />
    );
    expect(screen.getByText(/Week total/i)).toBeTruthy();
    expect(screen.queryByText(/aren't loaded/i)).toBeNull();
  });
});

describe("TimeClient — the KPI names the window it describes", () => {
  function draw(truncated: boolean) {
    render(
      <TimeClient
        initialEntries={[entry()]}
        users={[]}
        tasks={[]}
        currentUserId="u_admin"
        currentUserRole="admin"
        canSeeTeam
        initialScope="mine"
        serverNowMs={RENDERED_AT.getTime()}
        entriesTruncated={truncated}
        oldestLoadedAt={truncated ? new Date(2026, 4, 25, 8, 0).toISOString() : null}
      />
    );
  }

  it("says the figure covers the most recent sessions when the read was capped", () => {
    draw(true);
    expect(
      screen.getByText(/most recent sessions/i),
      "'1 session' for a customer with thousands is a wrong number, not a short one"
    ).toBeTruthy();
  });

  it("says plain 'N sessions' when it really is all of them", () => {
    draw(false);
    expect(screen.getByText("1 session")).toBeTruthy();
    expect(screen.queryByText(/most recent sessions/i)).toBeNull();
  });
});
