/**
 * The Chat row's unread badge — client half.
 *
 * WHAT WAS WRONG. A message arriving in #general, in a private channel the
 * reader belongs to, or in a DM changed nothing in the sidebar. Chat's only way
 * of announcing itself was to write a notification row, so a direct message
 * appeared under the bell beside budget alerts and role changes, and the word
 * "Chat" never moved. The per-channel badges inside /chat were right and were
 * tested; nothing carried that signal to the nav, which is the only part of the
 * app visible from every other page.
 *
 * WHAT THIS FILE PINS is the wiring and the honesty of the number, not the
 * counting — the rules live in `unreadChatTotal` and are tested against the
 * query in tests/lib/queries/chat-unread-total.test.ts.
 *
 * On the shared poll: the Chat count deliberately rides the SAME interval and
 * the same `document.hidden` gate as the notification count (perf-004 —
 * tests/components/sidebar-notification-badge.test.tsx is the argument). A
 * second poller would double the app's only background load for one integer, so
 * "both counts, one round trip" is asserted here rather than left to drift.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import type React from "react";

const H = vi.hoisted(() => ({
  unreadNotificationCountAction: vi.fn(),
  unreadChatCountAction: vi.fn(),
}));

vi.mock("@/lib/actions/notifications", () => ({
  listNotificationsAction: vi.fn(),
  unreadNotificationCountAction: H.unreadNotificationCountAction,
}));

vi.mock("@/lib/actions/chat", () => ({
  unreadChatCountAction: H.unreadChatCountAction,
}));

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

vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, ...rest }: { children?: React.ReactNode } & Record<string, unknown>) => (
      <div {...rest}>{children}</div>
    ),
  },
}));

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

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
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

/** The badge on one nav row, found by the noun in its accessible name. */
function badge(noun: "messages" | "notifications") {
  return screen.queryByLabelText(new RegExp(`unread ${noun}$`));
}

beforeEach(() => {
  vi.useFakeTimers();
  H.unreadNotificationCountAction.mockReset();
  H.unreadChatCountAction.mockReset();
  H.unreadNotificationCountAction.mockResolvedValue({ success: true, data: { count: 0 } });
  H.unreadChatCountAction.mockResolvedValue({ success: true, data: { count: 0 } });
  setHidden(false);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the Chat row badges unread messages", () => {
  it("asks the server for a chat count at all", async () => {
    render(<Sidebar />);
    await advance(0);

    expect(
      H.unreadChatCountAction,
      "nothing polls for unread messages, so the Chat row can never show a number"
    ).toHaveBeenCalled();
  });

  it("renders the number on the Chat row", async () => {
    H.unreadChatCountAction.mockResolvedValue({ success: true, data: { count: 3 } });

    render(<Sidebar />);
    await advance(0);

    const el = badge("messages");
    expect(el).not.toBeNull();
    expect(el!.textContent).toBe("3");
    const row = el!.closest("a");
    expect(row?.getAttribute("href"), "the badge must sit on Chat, not on some other row").toBe(
      "/chat"
    );
  });

  it("says MESSAGES, not notifications", async () => {
    // The badge is shared markup with the notifications row, whose accessible
    // name was hardcoded to "unread notifications". Announcing "3 unread
    // notifications" on the Chat row would send a screen-reader user to the
    // wrong page, and there is no visual difference to correct them with.
    H.unreadChatCountAction.mockResolvedValue({ success: true, data: { count: 3 } });
    H.unreadNotificationCountAction.mockResolvedValue({ success: true, data: { count: 0 } });

    render(<Sidebar />);
    await advance(0);

    expect(screen.queryByLabelText("3 unread messages")).not.toBeNull();
    expect(screen.queryByLabelText("3 unread notifications")).toBeNull();
  });

  it("shows nothing at zero", async () => {
    render(<Sidebar />);
    await advance(0);

    expect(badge("messages"), "a badge reading 0 is noise on every page of the app").toBeNull();
  });

  it("renders 99+ at the cap, rather than a flat 99", async () => {
    // `unreadChatTotal` caps at 99, so 99 arriving here means "99 or more".
    H.unreadChatCountAction.mockResolvedValue({ success: true, data: { count: 99 } });

    render(<Sidebar />);
    await advance(0);

    expect(badge("messages")!.textContent).toBe("99+");
  });

  it("leaves the notification badge alone", async () => {
    H.unreadChatCountAction.mockResolvedValue({ success: true, data: { count: 3 } });
    H.unreadNotificationCountAction.mockResolvedValue({ success: true, data: { count: 5 } });

    render(<Sidebar />);
    await advance(0);

    expect(badge("notifications")!.textContent).toBe("5");
    expect(badge("messages")!.textContent).toBe("3");
  });

  it("rides the notification poll instead of adding a second one", async () => {
    render(<Sidebar />);
    await advance(0);
    const afterMount = H.unreadChatCountAction.mock.calls.length;

    await advance(POLL_MS);

    expect(H.unreadChatCountAction.mock.calls.length).toBe(afterMount + 1);
    expect(
      H.unreadNotificationCountAction.mock.calls.length,
      "the two counts must come back on the same tick, or a tab pays two round trips for two integers"
    ).toBe(H.unreadChatCountAction.mock.calls.length);
  });

  it("does not poll a hidden tab", async () => {
    render(<Sidebar />);
    await advance(0);
    const afterMount = H.unreadChatCountAction.mock.calls.length;

    setHidden(true);
    await advance(POLL_MS * 3);

    expect(
      H.unreadChatCountAction.mock.calls.length,
      "a tab left open on Friday would poll all weekend"
    ).toBe(afterMount);
  });

  it("refreshes as soon as a channel is read, not 30 seconds later", async () => {
    // components/chat/message-list.tsx fires this after markChannelReadAction
    // succeeds. Without it the pill goes on claiming unread messages the reader
    // is looking at — the same failure chat-007 fixed one surface down, in the
    // channel rail.
    render(<Sidebar />);
    await advance(0);
    const afterMount = H.unreadChatCountAction.mock.calls.length;

    await act(async () => {
      window.dispatchEvent(new CustomEvent("ff-chat-read"));
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(H.unreadChatCountAction.mock.calls.length).toBe(afterMount + 1);
  });

  it("keeps the last good number when a poll fails", async () => {
    H.unreadChatCountAction.mockResolvedValue({ success: true, data: { count: 4 } });
    render(<Sidebar />);
    await advance(0);
    expect(badge("messages")!.textContent).toBe("4");

    H.unreadChatCountAction.mockResolvedValue({ success: false, error: "nope" });
    await advance(POLL_MS);

    expect(
      badge("messages")!.textContent,
      "blinking to zero on a dropped request tells the reader they are caught up when they are not"
    ).toBe("4");
  });

  it("a failing chat poll does not freeze the notification badge", async () => {
    // The two share one `Promise.all`, so a rejection that is not caught per
    // request takes the other answer down with it.
    H.unreadNotificationCountAction.mockResolvedValue({ success: true, data: { count: 1 } });
    H.unreadChatCountAction.mockRejectedValue(new Error("network"));

    render(<Sidebar />);
    await advance(0);

    expect(badge("notifications")?.textContent).toBe("1");
  });
});
