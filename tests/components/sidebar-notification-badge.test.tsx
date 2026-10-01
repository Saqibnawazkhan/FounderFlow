/**
 * perf-004 — the unread badge, client half.
 *
 * `components/layout/sidebar.tsx` mounts in every authenticated tab and ran:
 *
 *     const res = await listNotificationsAction();
 *     setUnreadCount(res.data.filter((n) => !n.read).length);
 *     ...
 *     const id = setInterval(fetchCount, 30_000);
 *
 * Two separate faults, and this file asserts both because fixing either alone
 * leaves the customer paying for the other:
 *
 *   1. WHAT IT ASKS FOR. Up to 200 full notification rows — titles, message
 *      bodies, links — twice a minute, to render one integer.
 *   2. WHEN IT ASKS. There is no `document.hidden` gate, unlike the clock
 *      heartbeat at components/time/clock-widget.tsx:130 which has one. A
 *      backgrounded tab — the normal state of a tab someone left open on
 *      Friday — polls forever. It is the app's only background load, so it sets
 *      the floor on database connections at idle.
 *
 * The badge must still be CORRECT and still be LIVE: a tab that comes back into
 * focus after an hour cannot show an hour-old number, so returning to visible
 * has to refetch immediately rather than wait out the interval.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import type React from "react";

const H = vi.hoisted(() => ({
  listNotificationsAction: vi.fn(),
  unreadNotificationCountAction: vi.fn(),
  unreadChatCountAction: vi.fn(),
}));

// The two endpoints under test. `listNotificationsAction` is mocked rather than
// removed so the test can SEE the sidebar calling it — "it stopped calling the
// list" is the assertion, and a missing export would fail for the wrong reason.
vi.mock("@/lib/actions/notifications", () => ({
  listNotificationsAction: H.listNotificationsAction,
  unreadNotificationCountAction: H.unreadNotificationCountAction,
}));
// The Chat row's badge polls this. Mocked for the same reason the notifications
// endpoint above is: the real module is a "use server" file that pulls next-auth
// into jsdom, where there is no Next server runtime to pull.
vi.mock("@/lib/actions/chat", () => ({
  unreadChatCountAction: H.unreadChatCountAction,
}));

// next/link needs the App Router client runtime, which jsdom has none of.
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: { href: string; children: React.ReactNode } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/tasks",
}));

// framer-motion's AnimatePresence + motion.div are decoration here; the mobile
// overlay is not what this file is about.
vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, ...rest }: { children?: React.ReactNode } & Record<string, unknown>) => (
      <div {...rest}>{children}</div>
    ),
  },
}));

/** The Zustand slice the sidebar reads. `locale` is in here because the real
 *  `useT()` reads it from the same store — the dictionary stays real. */
const storeState = {
  mobileNavOpen: false,
  setMobileNavOpen: vi.fn(),
  sidebarCollapsed: false,
  toggleSidebarCollapsed: vi.fn(),
  financeNavOpen: false,
  setFinanceNavOpen: vi.fn(),
  currentUser: { id: "u-1", name: "Ada", role: "admin", companyId: "co-1" },
  companies: [] as unknown[],
  currentCompany: { id: "co-1", name: "Nimbus", industry: "SaaS" },
  locale: "en",
};

vi.mock("@/lib/store", () => ({
  useStore: (selector: (s: typeof storeState) => unknown) => selector(storeState),
  useStoreHasHydrated: () => true,
}));

import { Sidebar } from "@/components/layout/sidebar";

const POLL_MS = 30_000;

/** jsdom's `document.hidden` is a getter on the prototype; override it. */
function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => hidden,
  });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (hidden ? "hidden" : "visible"),
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  H.listNotificationsAction.mockReset();
  H.unreadNotificationCountAction.mockReset();
  H.listNotificationsAction.mockResolvedValue({
    success: true,
    data: [
      { id: "n-1", read: false },
      { id: "n-2", read: false },
      { id: "n-3", read: true },
    ],
  });
  H.unreadNotificationCountAction.mockResolvedValue({ success: true, data: { count: 2 } });
  H.unreadChatCountAction.mockReset();
  H.unreadChatCountAction.mockResolvedValue({ success: true, data: { count: 0 } });
  setHidden(false);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("perf-004 — the sidebar badge", () => {
  it("asks for the count, never for the notification list", async () => {
    render(<Sidebar />);
    await advance(0);

    expect(
      H.unreadNotificationCountAction,
      "the sidebar has no count endpoint to call"
    ).toHaveBeenCalled();
    expect(
      H.listNotificationsAction,
      "the sidebar is still downloading up to 200 full notification rows to render one integer"
    ).not.toHaveBeenCalled();
  });

  it("renders the number it was given", async () => {
    H.unreadNotificationCountAction.mockResolvedValue({ success: true, data: { count: 5 } });
    render(<Sidebar />);
    await advance(0);

    expect(screen.getByLabelText("5 unread notifications")).toHaveTextContent("5");
  });

  it("stops polling while the tab is hidden", async () => {
    render(<Sidebar />);
    await advance(0);
    const afterMount = H.unreadNotificationCountAction.mock.calls.length;
    expect(afterMount).toBe(1);

    setHidden(true);
    // Four poll intervals in a backgrounded tab — the normal state of a tab
    // left open overnight.
    await advance(POLL_MS * 4);

    expect(
      H.unreadNotificationCountAction.mock.calls.length,
      "a backgrounded tab is still polling forever — no document.hidden gate, unlike the clock heartbeat"
    ).toBe(afterMount);
  });

  it("still polls while the tab is visible", async () => {
    render(<Sidebar />);
    await advance(0);
    const afterMount = H.unreadNotificationCountAction.mock.calls.length;

    await advance(POLL_MS + 1);
    expect(H.unreadNotificationCountAction.mock.calls.length).toBe(afterMount + 1);
  });

  it("refreshes immediately when the tab comes back into focus", async () => {
    render(<Sidebar />);
    await advance(0);

    setHidden(true);
    await advance(POLL_MS * 3);
    const whileHidden = H.unreadNotificationCountAction.mock.calls.length;

    H.unreadNotificationCountAction.mockResolvedValue({ success: true, data: { count: 11 } });
    setHidden(false);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(
      H.unreadNotificationCountAction.mock.calls.length,
      "coming back to the tab must refetch — otherwise the badge shows an hour-old number"
    ).toBe(whileHidden + 1);
    expect(screen.getByLabelText("11 unread notifications")).toBeInTheDocument();
  });

  it("still refreshes on a push while the tab is visible", async () => {
    render(<Sidebar />);
    await advance(0);
    const before = H.unreadNotificationCountAction.mock.calls.length;

    await act(async () => {
      window.dispatchEvent(new Event("ff-notifications-changed"));
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(H.unreadNotificationCountAction.mock.calls.length).toBe(before + 1);
  });

  it("stops polling once unmounted", async () => {
    const view = render(<Sidebar />);
    await advance(0);
    const before = H.unreadNotificationCountAction.mock.calls.length;

    view.unmount();
    await advance(POLL_MS * 3);

    expect(H.unreadNotificationCountAction.mock.calls.length).toBe(before);
  });
});
