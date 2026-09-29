/**
 * a11y-007 — the topbar dropdowns are DISCLOSURES, not ARIA menus.
 *
 * `components/layout/topbar.tsx` shipped two `<motion.div role="menu">` panels
 * behind triggers carrying `aria-haspopup="menu"`, and kept none of the promises
 * those two attributes make:
 *
 *   - `role="menu"` is only valid when it owns `menuitem` / `menuitemradio` /
 *     `menuitemcheckbox` / `group` / `separator` children (axe-core
 *     `aria-required-children`). The notifications panel owns an `<h3>`, a
 *     "Mark all read" button and a scrolling list of multi-line links; the
 *     account panel owns a name/email block and three controls. None of them
 *     carried `role="menuitem"`.
 *   - `aria-haspopup="menu"` tells a screen-reader user the ARIA menu keyboard
 *     contract is available: Down Arrow opens, focus moves into the menu,
 *     Arrow/Home/End move between items, first-letter typeahead jumps. The
 *     file implements none of it.
 *
 * The fix chosen is to stop claiming a menu rather than to build one: a panel
 * with a heading, a scroll region and prose timestamps is not a list of
 * commands, so the menu pattern is the wrong pattern for it (and ARIA's own
 * guidance is not to use `role="menu"` for navigation, which is what 2 of the
 * account panel's 3 items are). What a disclosure owes instead is asserted
 * here: `aria-expanded`, `aria-controls` pointing at the panel it opens, plain
 * roles on the children, Tab reaching them in visual order, and Escape closing
 * the panel AND returning focus to the trigger it came from.
 *
 * Per HOUSE-RULES rule 15(b) this is a DOM-contract + keyboard test driven by
 * user-event. It asserts no colour and no computed style.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";

const H = vi.hoisted(() => ({
  listNotificationsAction: vi.fn(),
  markAllNotificationsReadAction: vi.fn(),
  markNotificationReadAction: vi.fn(),
  logoutAction: vi.fn(),
  updateAppearanceAction: vi.fn(),
}));

vi.mock("@/lib/actions/notifications", () => ({
  listNotificationsAction: H.listNotificationsAction,
  markAllNotificationsReadAction: H.markAllNotificationsReadAction,
  markNotificationReadAction: H.markNotificationReadAction,
}));

vi.mock("@/lib/actions/auth", () => ({ logoutAction: H.logoutAction }));
vi.mock("@/lib/actions/appearance", () => ({ updateAppearanceAction: H.updateAppearanceAction }));
vi.mock("react-hot-toast", () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

// The clock pill and the command palette are separate surfaces with their own
// timers / Radix dialog. Neither is what this file is about, and the palette
// would otherwise put a focus trap in the way of the Tab assertions.
vi.mock("@/components/time/clock-widget", () => ({ ClockWidget: () => null }));
vi.mock("@/components/layout/command-palette", () => ({ CommandPalette: () => null }));

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

// framer-motion passthrough. The animation props are stripped rather than
// spread so React doesn't warn about unknown DOM attributes; `role`, `id`,
// `aria-*` and `className` survive, which is exactly what is under test.
// (Reduced motion in this file is a11y-009 / agent b4's finding, not this one.)
vi.mock("framer-motion", () => {
  type AnyProps = Record<string, unknown> & { children?: React.ReactNode };
  const MOTION_ONLY = [
    "initial",
    "animate",
    "exit",
    "transition",
    "variants",
    "layout",
    "layoutId",
    "whileHover",
    "whileTap",
    "whileFocus",
    "whileInView",
  ];
  const strip = (props: AnyProps) => {
    const rest: AnyProps = {};
    for (const key of Object.keys(props)) {
      if (MOTION_ONLY.indexOf(key) === -1) rest[key] = props[key];
    }
    return rest;
  };
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    motion: {
      div: (props: AnyProps) => <div {...(strip(props) as React.HTMLAttributes<HTMLDivElement>)} />,
    },
  };
});

/** The Zustand slice the topbar reads. `locale` is real so `useT()` is real. */
const storeState = {
  currentUser: {
    id: "u-1",
    name: "Ada",
    email: "ada@nimbus.test",
    role: "admin",
    companyId: "co-1",
  },
  theme: "light",
  toggleTheme: vi.fn(),
  locale: "en",
  setLocale: vi.fn(),
  logout: vi.fn(),
  setMobileNavOpen: vi.fn(),
};

vi.mock("@/lib/store", () => ({
  useStore: (selector: (s: typeof storeState) => unknown) => selector(storeState),
  useStoreHasHydrated: () => true,
}));

import { Topbar } from "@/components/layout/topbar";

const NOTIFS = [
  {
    id: "n-1",
    title: "Invoice overdue",
    message: "Acme's invoice is 14 days overdue",
    type: "warning",
    read: false,
    link: "/finance/transactions",
    createdAt: new Date("2026-09-29T09:00:00Z").toISOString(),
  },
  {
    id: "n-2",
    title: "Task assigned",
    message: "Ada assigned you “Ship the migration”",
    type: "info",
    read: true,
    link: "/tasks",
    createdAt: new Date("2026-09-28T09:00:00Z").toISOString(),
  },
];

beforeEach(() => {
  H.listNotificationsAction.mockReset();
  H.listNotificationsAction.mockResolvedValue({ success: true, data: NOTIFS });
  H.markNotificationReadAction.mockResolvedValue({ success: true, data: null });
  H.markAllNotificationsReadAction.mockResolvedValue({ success: true, data: null });
  H.updateAppearanceAction.mockResolvedValue({ success: true, data: null });
});

/** The bell. Its label gains ", <n>" when there are unread rows. */
const bell = () => screen.getByRole("button", { name: /^Notifications/ });
const avatar = () => screen.getByRole("button", { name: "Account menu" });

/** The panel a trigger says it controls. Fails loudly if it says nothing. */
function controlledPanel(trigger: HTMLElement): HTMLElement {
  const id = trigger.getAttribute("aria-controls");
  expect(
    id,
    "the trigger carries no aria-controls, so nothing in the markup connects it to the panel it opens"
  ).toBeTruthy();
  const panel = document.getElementById(id as string);
  expect(panel, `aria-controls="${id}" points at no element in the document`).not.toBeNull();
  return panel as HTMLElement;
}

describe("a11y-007 — the topbar dropdowns claim only what the keyboard delivers", () => {
  it("the notifications trigger is a disclosure: expanded + controls, never haspopup=menu", async () => {
    const user = userEvent.setup();
    render(<Topbar />);
    await screen.findByRole("button", { name: /^Notifications/ });

    expect(bell()).toHaveAttribute("aria-expanded", "false");
    expect(
      bell(),
      'aria-haspopup="menu" advertises the ARIA menu keyboard contract (Down Arrow opens, arrows move between items, typeahead) — none of which this panel implements'
    ).not.toHaveAttribute("aria-haspopup");

    await user.click(bell());
    expect(bell()).toHaveAttribute("aria-expanded", "true");

    const panel = controlledPanel(bell());
    expect(within(panel).getByRole("heading", { name: "Notifications" })).toBeInTheDocument();
  });

  it("the account trigger is a disclosure: expanded + controls, never haspopup=menu", async () => {
    const user = userEvent.setup();
    render(<Topbar />);
    await screen.findByRole("button", { name: "Account menu" });

    expect(avatar()).toHaveAttribute("aria-expanded", "false");
    expect(
      avatar(),
      'aria-haspopup="menu" advertises a keyboard contract the account panel does not implement'
    ).not.toHaveAttribute("aria-haspopup");

    await user.click(avatar());
    expect(avatar()).toHaveAttribute("aria-expanded", "true");

    const panel = controlledPanel(avatar());
    expect(within(panel).getByRole("link", { name: /Profile & settings/ })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: /Sign out/ })).toBeInTheDocument();
  });

  it("no open panel claims role=menu, because neither is a list of commands", async () => {
    const user = userEvent.setup();
    render(<Topbar />);
    await screen.findByRole("button", { name: /^Notifications/ });

    await user.click(bell());
    expect(
      document.querySelectorAll('[role="menu"]').length,
      'the notifications panel still declares role="menu" while owning an <h3>, a "Mark all read" button and a scrolling list — invalid ARIA (aria-required-children) and no menuitem in sight'
    ).toBe(0);
    expect(screen.queryAllByRole("menuitem")).toHaveLength(0);

    await user.keyboard("{Escape}");
    await user.click(avatar());
    expect(
      document.querySelectorAll('[role="menu"]').length,
      'the account panel still declares role="menu" while owning a non-interactive name/email block and two navigation links'
    ).toBe(0);
    expect(screen.queryAllByRole("menuitem")).toHaveLength(0);
  });

  it("the notifications panel keeps its real semantics: a heading, a list of links, not menu items", async () => {
    const user = userEvent.setup();
    render(<Topbar />);
    await screen.findByRole("button", { name: /^Notifications/ });
    await user.click(bell());

    const panel = controlledPanel(bell());
    // Heading navigation (NVDA `h`, JAWS `h`) has to find this. Inside a
    // role="menu" it is an invalid child and gets no heading semantics.
    expect(within(panel).getByRole("heading", { name: "Notifications" })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Mark all read" })).toBeInTheDocument();
    expect(within(panel).getByRole("link", { name: /Invoice overdue/ })).toBeInTheDocument();
    expect(within(panel).getByRole("link", { name: /View all notifications/ })).toBeInTheDocument();
  });

  it("Tab from the account trigger walks the panel's three controls in visual order", async () => {
    const user = userEvent.setup();
    render(<Topbar />);
    await screen.findByRole("button", { name: "Account menu" });

    await user.click(avatar());
    expect(document.activeElement).toBe(avatar());

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("link", { name: /Profile & settings/ }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("link", { name: /Team management/ }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Sign out/ }));
  });

  it("Escape from inside the account panel closes it and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    render(<Topbar />);
    await screen.findByRole("button", { name: "Account menu" });

    await user.click(avatar());
    await user.tab();
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Sign out/ }));

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("button", { name: /Sign out/ })).not.toBeInTheDocument();
    expect(avatar()).toHaveAttribute("aria-expanded", "false");
    expect(
      document.activeElement,
      "Escape unmounted the panel with focus still inside it, so focus fell to <body> — the keyboard user loses their place and must Tab from the top of the page"
    ).toBe(avatar());
  });

  it("Escape from inside the notifications panel closes it and returns focus to the bell", async () => {
    const user = userEvent.setup();
    render(<Topbar />);
    await screen.findByRole("button", { name: /^Notifications/ });

    await user.click(bell());
    await user.tab();
    expect(controlledPanel(bell()).contains(document.activeElement)).toBe(true);

    await user.keyboard("{Escape}");

    expect(bell()).toHaveAttribute("aria-expanded", "false");
    expect(
      document.activeElement,
      "Escape dropped focus to <body> instead of returning it to the bell"
    ).toBe(bell());
  });

  it("Escape with no panel open leaves focus exactly where the user had it", async () => {
    const user = userEvent.setup();
    render(<Topbar />);
    const themeToggle = await screen.findByRole("button", { name: /Switch to dark theme/ });

    themeToggle.focus();
    await user.keyboard("{Escape}");

    expect(
      document.activeElement,
      "the document-level Escape handler yanked focus to a topbar trigger even though no panel was open"
    ).toBe(themeToggle);
  });

  it("Escape from outside an open panel closes it without stealing focus", async () => {
    const user = userEvent.setup();
    render(<Topbar />);
    await screen.findByRole("button", { name: /^Notifications/ });

    await user.click(bell());
    const themeToggle = screen.getByRole("button", { name: /Switch to dark theme/ });
    themeToggle.focus();

    await user.keyboard("{Escape}");

    expect(bell()).toHaveAttribute("aria-expanded", "false");
    expect(
      document.activeElement,
      "focus was outside the panel, so Escape must only close it — moving focus to the bell would teleport the user backwards"
    ).toBe(themeToggle);
  });

  it("opening one panel closes the other, so only one disclosure is ever expanded", async () => {
    const user = userEvent.setup();
    render(<Topbar />);
    await screen.findByRole("button", { name: /^Notifications/ });

    // Keyboard-only open: no mousedown fires, so the outside-click handler that
    // normally closes the sibling panel never runs.
    bell().focus();
    await user.keyboard("{Enter}");
    expect(bell()).toHaveAttribute("aria-expanded", "true");

    avatar().focus();
    await user.keyboard("{Enter}");

    expect(avatar()).toHaveAttribute("aria-expanded", "true");
    expect(
      bell(),
      "both dropdowns are expanded at once — they overlap visually and Escape has no unambiguous trigger to return focus to"
    ).toHaveAttribute("aria-expanded", "false");
  });
});
