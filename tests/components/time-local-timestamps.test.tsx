/**
 * time-011 — /time renders every timestamp in the SERVER's timezone on first
 * paint.
 *
 * `<TimeClient>` carries `"use client"` but is still server-rendered, and it
 * formatted with `format(startedAt, "MMM dd · HH:mm")` — date-fns against the HOST
 * clock. On Vercel the host is UTC; in the browser it is the viewer's zone. This
 * product is built for a PKT (UTC+5) market, so a customer's 2pm session was
 * listed as 09:00 until hydration finished, and then silently changed. React also
 * logs a hydration mismatch for the differing text, which in production makes it
 * throw the subtree away and re-render it client-side — the "flash the empty
 * state" behaviour the finding describes. `renderedAt = useMemo(() => new Date())`
 * had the same shape: computed twice, two different instants, so an open entry's
 * duration disagreed between the two renders too.
 *
 * HOW THIS IS TESTED WITHOUT TWO TIMEZONES. One vitest process has one TZ, so
 * "render on the server in UTC, hydrate in PKT and compare" cannot be staged here
 * — and a test that rendered twice in the same zone would pass against the bug,
 * which is the failure mode this repo keeps producing. So these tests assert the
 * MECHANISM that makes the mismatch impossible instead of staging the mismatch:
 *
 *   `renderToStaticMarkup` runs no effects, so it is the server render. If the
 *   server render contains no wall-clock time at all, there is nothing for the
 *   client's zone to disagree with. The formatted value appears after mount, in
 *   the viewer's own zone, once — which is also why the first client render has to
 *   match the server's rather than being "corrected" during hydration.
 *
 * The machine-readable value is not gated: `<time dateTime="…">` carries the ISO
 * instant in both renders, so the markup is never actually missing the timestamp.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TimeEntryClient } from "@/lib/queries/time";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-dialog", () => ({
  useConfirm: () => async () => false,
}));
vi.mock("@/lib/i18n/use-t", () => ({
  useNumberFormat: () => ({ number: (v: number) => String(v) }),
}));
vi.mock("react-hot-toast", () => {
  const toast = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });
  return { default: toast, toast };
});
// `@/lib/actions/time` is `"use server"` and pulls next-auth (and therefore
// `next/server`) into the module graph, which does not load in this environment.
// Nothing here presses a button, so the stub only has to exist.
vi.mock("@/lib/actions/time", () => ({
  deleteTimeEntryAction: vi.fn(),
  updateTimeEntryAction: vi.fn(),
  createManualEntryAction: vi.fn(),
}));

import { LocalTime } from "@/components/time/local-time";
import { TimeClient } from "@/app/(app)/time/time-client";

/** 2026-05-24 19:30 UTC — 14:30 in Bogota (the pinned test TZ), 00:30 the NEXT
 *  day in Karachi. Any host-timezone formatting shows a different wall clock and
 *  in Karachi's case a different calendar day. */
const INSTANT = "2026-05-24T19:30:00.000Z";
const CLOCK = /\d{1,2}:\d{2}/;

/** Visible text only. The ISO instant lives in a `dateTime` ATTRIBUTE and is
 *  supposed to be there in both renders, so matching the raw markup for a clock
 *  would match that attribute and pass whatever the cells render. */
function visible(html: string): string {
  return html.replace(/<[^>]*>/g, " ");
}

const entry: TimeEntryClient = {
  id: "e1",
  companyId: "c_nimbus",
  userId: "u_admin",
  userName: "Ayesha",
  taskId: null,
  taskTitle: "Ship the invoice screen",
  note: null,
  clockInAt: INSTANT,
  clockOutAt: "2026-05-24T21:00:00.000Z",
  lastActivityAt: "2026-05-24T21:00:00.000Z",
  autoClosed: false,
  editedBy: null,
  editedByName: null,
  editedAt: null,
  createdAt: INSTANT,
};

function timeClient() {
  return (
    <TimeClient
      initialEntries={[entry]}
      users={[]}
      tasks={[]}
      currentUserId="u_admin"
      currentUserRole="admin"
      canSeeTeam
      initialScope="mine"
      serverNowMs={Date.parse("2026-05-24T21:30:00.000Z")}
      entriesTruncated={false}
      oldestLoadedAt={null}
    />
  );
}

describe("LocalTime", () => {
  it("prints no wall clock in the server render", () => {
    const html = renderToStaticMarkup(<LocalTime value={INSTANT} pattern="MMM dd · HH:mm" />);
    expect(
      visible(html),
      "a server-rendered wall clock is a wall clock in the wrong zone"
    ).not.toMatch(CLOCK);
  });

  it("still carries the machine-readable instant in the server render", () => {
    const html = renderToStaticMarkup(<LocalTime value={INSTANT} pattern="MMM dd · HH:mm" />);
    // React 18 writes the attribute as `dateTime`; HTML attribute names are
    // case-insensitive, so the assertion is too.
    expect(html.toLowerCase()).toContain(`datetime="${INSTANT.toLowerCase()}"`);
  });

  it("prints the viewer's local time once mounted", () => {
    render(<LocalTime value={INSTANT} pattern="MMM dd · HH:mm" />);
    // TZ=America/Bogota is pinned by `npm test`; 19:30Z is 14:30 there.
    expect(screen.getByText("May 24 · 14:30")).toBeTruthy();
  });
});

describe("TimeClient — first paint carries no timezone-dependent clock", () => {
  it("server-renders the entry row without a wall-clock time", () => {
    // The reachability half: LocalTime being correct proves nothing if the table
    // still calls `format()` itself. This is the assertion that fails today.
    const html = renderToStaticMarkup(timeClient());
    expect(html).toContain("Ship the invoice screen");
    expect(
      visible(html),
      "the row's Started/Ended cells still formatted against the host clock"
    ).not.toMatch(CLOCK);
  });

  it("shows the local time after hydration", () => {
    render(timeClient());
    // Two cells (desktop table + mobile card list) render the same start time.
    expect(screen.getAllByText("May 24 · 14:30").length).toBeGreaterThan(0);
  });

  it("takes its clock from the server, so both renders agree on a duration", () => {
    // `renderedAt` was `useMemo(() => new Date())`, i.e. a different instant on
    // each side of the boundary. An open entry's duration therefore differed
    // between the server HTML and the first client render. Passing the server's
    // instant down makes the two renders identical by construction; the test for
    // it is that a duration computed from a server clock 2h after the clock-in
    // renders as 2h, not as "now minus clock-in".
    const open = { ...entry, id: "e_open", clockOutAt: null };
    const html = renderToStaticMarkup(
      <TimeClient
        initialEntries={[open]}
        users={[]}
        tasks={[]}
        currentUserId="u_admin"
        currentUserRole="admin"
        canSeeTeam
        initialScope="mine"
        serverNowMs={Date.parse("2026-05-24T21:30:00.000Z")}
        entriesTruncated={false}
        oldestLoadedAt={null}
      />
    );
    expect(html, "the duration was measured against the renderer's own clock").toContain("2h 00m");
  });
});
