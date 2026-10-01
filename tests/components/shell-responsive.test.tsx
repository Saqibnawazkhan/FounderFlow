/**
 * resp-001 + resp-002 — the app shell on a 375px phone.
 *
 * Two findings, one surface, and both of them are things a browser decides and
 * jsdom cannot. Per HOUSE-RULES rule 15 this file therefore does two different
 * kinds of assertion, and never pretends to be a third:
 *
 *   - REAL DOM BEHAVIOUR, driven by user-event: where focus goes when the
 *     mobile drawer opens and closes. That is genuine, observable behaviour in
 *     jsdom and it is asserted as such.
 *   - THE CLASS CONTRACT, parsed out of the rendered className. jsdom resolves
 *     no Tailwind and computes no box, so `getComputedStyle(panel).width` here
 *     would answer the same thing whatever we shipped. What IS checkable is the
 *     input the browser lays out from — which utilities apply, at which
 *     breakpoint — and, crucially, whether the utilities that only work as a
 *     PAIR are still paired. That is the shape of bug both findings are.
 *
 * There is deliberately no `getComputedStyle` and no pixel measurement here.
 *
 * ---------------------------------------------------------------------------
 * resp-001: the drawer that is off-screen but still in the tab order.
 *
 * `<aside aria-label="Primary">` is always rendered. Below `lg` and closed it is
 * only TRANSFORMED off the reading-start edge. `transform` moves paint; it does
 * not remove an element from the tab order or from the accessibility tree. So
 * Tab from the top of a phone page walked ~17 navigation links — brand, close,
 * fourteen NavRows, the collapse toggle, the settings link — every one of them
 * painting its focus ring at a negative x coordinate, before reaching anything
 * the user can see.
 *
 * The contract: whatever hides the closed drawer must be a mechanism that
 * removes focusability (`visibility: hidden`, `display: none` or `inert`), and
 * it must be scoped to EXACTLY the breakpoint the off-screen transform is
 * scoped to. Half of that pair is worse than neither: hide it at the wrong
 * breakpoint and the permanent desktop rail disappears.
 *
 * And once the drawer is genuinely hidden, focus has to be managed, because the
 * drawer precedes the topbar in the DOM: opening it from the burger otherwise
 * leaves the caret AFTER every one of those links, so Tab walks away from the
 * thing that just opened, and closing it while focus is inside strands focus on
 * an element the browser has just made unfocusable.
 *
 * ---------------------------------------------------------------------------
 * resp-002: the panel that is wider than the space it hangs in.
 *
 * `components/layout/topbar.tsx` anchored both dropdowns with `absolute end-0`
 * inside the 36px trigger's own `relative` wrapper, at a fixed `w-80` (320px).
 * On a 375px viewport the notifications trigger's trailing edge sits at x≈307
 * (16px container padding + 48px profile button + 4px gap), so a 320px panel
 * anchored there starts at x≈-13. Every ancestor is `overflow-hidden` — the
 * app-shell root at `app/(app)/layout.tsx` is `flex h-dvh overflow-hidden` and
 * `<main>` is `overflow-x-hidden` — and none is `overflow-x: auto`, so the
 * missing strip cannot be scrolled to at all. It is simply gone.
 *
 * The contract is a budget, and it is computed here rather than eyeballed: a
 * fixed panel width only applies from some breakpoint upward, so
 *
 *     panel width + chrome between the panel and the viewport edge
 *       <= the narrowest viewport at which that width applies
 *
 * must hold for every width the panel declares. At the narrowest supported
 * width there is no room for any fixed width at all, so the panel must instead
 * stretch between both inset edges — which in turn requires its containing
 * block to stop being the 36px button. Those two are a pair in the same way the
 * drawer's are: stretch the panel while its containing block is still the
 * button and it collapses to the button's width.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";

const H = vi.hoisted(() => ({
  listNotificationsAction: vi.fn(),
  markAllNotificationsReadAction: vi.fn(),
  markNotificationReadAction: vi.fn(),
  unreadNotificationCountAction: vi.fn(),
  unreadChatCountAction: vi.fn(),
  logoutAction: vi.fn(),
  updateAppearanceAction: vi.fn(),
}));

vi.mock("@/lib/actions/notifications", () => ({
  listNotificationsAction: H.listNotificationsAction,
  markAllNotificationsReadAction: H.markAllNotificationsReadAction,
  markNotificationReadAction: H.markNotificationReadAction,
  unreadNotificationCountAction: H.unreadNotificationCountAction,
}));

// The sidebar's Chat badge polls this. Mocked for the same reason as the
// notification endpoints above: the real module is "use server" and drags
// next-auth into jsdom.
vi.mock("@/lib/actions/chat", () => ({
  unreadChatCountAction: H.unreadChatCountAction,
}));

vi.mock("@/lib/actions/auth", () => ({ logoutAction: H.logoutAction }));
vi.mock("@/lib/actions/appearance", () => ({ updateAppearanceAction: H.updateAppearanceAction }));
vi.mock("react-hot-toast", () => ({ default: { success: vi.fn(), error: vi.fn() } }));

// Neither the clock pill nor the command palette is under test, and the palette
// installs a focus trap that would fight the drawer's focus assertions.
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

vi.mock("next/navigation", () => ({ usePathname: () => "/tasks" }));

/**
 * framer-motion passthrough. Animation props are stripped rather than spread so
 * React does not warn about unknown DOM attributes; `id`, `className` and every
 * `aria-*` survive, and `className` is the whole point of this file.
 */
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

/** The Zustand slice both the sidebar and the topbar read. `locale` is real so
 *  `useT()` resolves the real dictionary. */
const storeState = {
  mobileNavOpen: false,
  setMobileNavOpen: vi.fn(),
  sidebarCollapsed: false,
  toggleSidebarCollapsed: vi.fn(),
  financeNavOpen: false,
  setFinanceNavOpen: vi.fn(),
  currentUser: {
    id: "u-1",
    name: "Ada",
    email: "ada@nimbus.test",
    role: "admin",
    companyId: "co-1",
  },
  companies: [] as unknown[],
  currentCompany: { id: "co-1", name: "Nimbus", industry: "SaaS" },
  theme: "light",
  toggleTheme: vi.fn(),
  locale: "en",
  setLocale: vi.fn(),
  logout: vi.fn(),
};

vi.mock("@/lib/store", () => ({
  useStore: (selector: (s: typeof storeState) => unknown) => selector(storeState),
  useStoreHasHydrated: () => true,
}));

import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";

/* ===========================================================================
 * A tiny Tailwind class-string parser.
 *
 * Utilities are `variant:variant:utility`, and an arbitrary value may itself
 * contain characters we split on, so bracket runs are masked before the split.
 * Written with index loops and arrays rather than `matchAll` / `Set` spreads:
 * tsconfig sets no `target`, so `tsc` compiles to ES5 and those are typecheck
 * errors vitest would happily let through (HOUSE-RULES rule 4).
 * =========================================================================== */

type Token = { raw: string; utility: string; variants: string[] };

function splitToken(raw: string): Token {
  const masked = raw.replace(/\[[^\]]*\]/g, (m) => new Array(m.length + 1).join("#"));
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < masked.length; i++) {
    if (masked.charAt(i) === ":") {
      parts.push(raw.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(raw.slice(start));
  return { raw, utility: parts[parts.length - 1], variants: parts.slice(0, parts.length - 1) };
}

function tokensOf(className: string | null | undefined): Token[] {
  const out: Token[] = [];
  (className || "")
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .forEach((raw) => out.push(splitToken(raw)));
  return out;
}

const BREAKPOINT = /^(?:max-)?(?:sm|md|lg|xl|2xl)$/;

/** The breakpoint variants on a token, e.g. `max-lg:rtl:invisible` -> ["max-lg"]. */
function breakpointsOf(token: Token): string[] {
  return token.variants.filter((v) => BREAKPOINT.test(v));
}

/** Sorted, de-duplicated breakpoint variants across every token matching `pred`. */
function breakpointsWhere(tokens: Token[], pred: (t: Token) => boolean): string[] {
  const seen: string[] = [];
  tokens.filter(pred).forEach((token) => {
    const bps = breakpointsOf(token);
    // A token with no breakpoint variant at all is recorded as "" — "applies
    // from zero width up" — because that is precisely the state both findings
    // are about and it must not vanish from the comparison.
    const keys = bps.length > 0 ? bps : [""];
    keys.forEach((k) => {
      if (seen.indexOf(k) === -1) seen.push(k);
    });
  });
  return seen.sort();
}

/* ===========================================================================
 * resp-001 — the closed drawer
 * =========================================================================== */

function drawer(): HTMLElement {
  return screen.getByRole("complementary", { name: "Primary" });
}

/** Utilities that actually remove an element from the tab order. `translate`,
 *  `opacity` and `pointer-events-none` are not among them. */
const FOCUS_REMOVING = ["invisible", "hidden"];

beforeEach(() => {
  storeState.mobileNavOpen = false;
  H.unreadNotificationCountAction.mockReset();
  H.unreadNotificationCountAction.mockResolvedValue({ success: true, data: { count: 0 } });
  // Primed, not just wired. A bare vi.fn() returns undefined, and the sidebar's poll
  // does `unreadChatCountAction().catch(...)` — so an unprimed mock throws while the
  // Promise.all array is still being built, taking the notification half down with it.
  // Every test still reported green above six unhandled TypeErrors, and `npm test`
  // exited 1. Both sibling sidebar tests prime it; this file wired the mock and did not.
  H.unreadChatCountAction.mockReset();
  H.unreadChatCountAction.mockResolvedValue({ success: true, data: { count: 0 } });
  H.listNotificationsAction.mockReset();
  H.listNotificationsAction.mockResolvedValue({ success: true, data: [] });
  H.markNotificationReadAction.mockResolvedValue({ success: true, data: null });
  H.markAllNotificationsReadAction.mockResolvedValue({ success: true, data: null });
  H.updateAppearanceAction.mockResolvedValue({ success: true, data: null });
  H.logoutAction.mockResolvedValue({ success: true, data: null });
});

describe("resp-001 — the closed mobile drawer is out of the tab order", () => {
  it("hides the closed drawer with something that removes focusability, not just a transform", () => {
    render(<Sidebar />);
    const tokens = tokensOf(drawer().className);

    const removers = tokens.filter((t) => FOCUS_REMOVING.indexOf(t.utility) !== -1);

    expect(
      removers.map((t) => t.raw),
      "The closed drawer is only translated off-screen. `transform` moves paint and nothing else: " +
        "all ~17 nav links are still tabbable and still in the accessibility tree at 375px, so Tab " +
        "from the top of a phone page walks them all with no visible focus anywhere on screen."
    ).not.toEqual([]);
  });

  it("scopes the hiding to exactly the breakpoint the off-screen transform is scoped to", () => {
    // The pair that must not drift. `max-lg:-translate-x-full` parks the drawer
    // off-screen only below `lg`; hiding it at any other breakpoint either
    // leaves the off-screen copy tabbable (too narrow) or deletes the permanent
    // desktop rail (too wide).
    render(<Sidebar />);
    const tokens = tokensOf(drawer().className);

    const parked = breakpointsWhere(tokens, (t) => /translate-x/.test(t.utility));
    const hidden = breakpointsWhere(tokens, (t) => FOCUS_REMOVING.indexOf(t.utility) !== -1);

    expect(
      hidden,
      `The drawer is parked off-screen at [${parked.join(", ")}] but hidden from focus at ` +
        `[${hidden.join(", ")}]. Those have to be the same breakpoint or one of the two is wrong.`
    ).toEqual(parked);
  });

  it("does not hide the drawer while it is open", () => {
    storeState.mobileNavOpen = true;
    render(<Sidebar />);
    const tokens = tokensOf(drawer().className);

    expect(
      tokens.filter((t) => FOCUS_REMOVING.indexOf(t.utility) !== -1).map((t) => t.raw),
      "An open drawer that is hidden from focus is a drawer nobody can use."
    ).toEqual([]);
  });

  it("transitions visibility with the slide, so closing is not cut short", () => {
    // `visibility` interpolates discretely: going visible -> hidden it stays
    // visible for the whole duration and flips at the end, which is exactly the
    // slide-out. Leave it out of the transition list and the drawer vanishes on
    // the first frame instead of sliding away.
    render(<Sidebar />);
    const transition = tokensOf(drawer().className).filter((t) => /^transition-\[/.test(t.utility));

    expect(transition.length, "the drawer no longer declares an explicit transition list").toBe(1);
    expect(
      transition[0].utility,
      "`visibility` is not in the transition property list, so the drawer will disappear on the " +
        "first frame of closing instead of sliding out."
    ).toMatch(/visibility/);
  });

  it("moves focus into the drawer when it opens", () => {
    // The drawer precedes the topbar in the DOM, so focus left on the burger is
    // focus AFTER every link in the drawer: Tab walks away from the thing that
    // just opened, and the only way in is ~17 Shift-Tabs.
    const opener = document.createElement("button");
    opener.textContent = "Open menu";
    document.body.appendChild(opener);
    opener.focus();

    const view = render(<Sidebar />);
    storeState.mobileNavOpen = true;
    view.rerender(<Sidebar />);

    expect(
      document.activeElement,
      "opening the drawer left focus outside it, before every one of its links"
    ).toBe(screen.getByRole("button", { name: "Close navigation menu" }));

    document.body.removeChild(opener);
  });

  it("returns focus to whatever opened it when it closes", async () => {
    const opener = document.createElement("button");
    opener.textContent = "Open menu";
    document.body.appendChild(opener);
    opener.focus();

    const view = render(<Sidebar />);
    storeState.mobileNavOpen = true;
    view.rerender(<Sidebar />);

    // Focus is deliberately put INSIDE the drawer first — a user who has tabbed
    // to a nav row and then pressed Escape. Without this the assertion below
    // would pass on the unfixed code simply because nothing ever moved focus,
    // which is this repo's most recurrent defect (HOUSE-RULES rule 3).
    const inside = screen.getByRole("link", { name: "FounderFlow home" });
    inside.focus();
    expect(document.activeElement, "focus did not land inside the drawer").toBe(inside);

    storeState.mobileNavOpen = false;
    view.rerender(<Sidebar />);

    expect(
      document.activeElement,
      "closing the drawer stranded focus on an element the browser has just made unfocusable, " +
        "so the next Tab starts again from the top of the document"
    ).toBe(opener);

    document.body.removeChild(opener);
  });
});

/* ===========================================================================
 * resp-002 — the dropdown panels
 * =========================================================================== */

/**
 * The narrowest viewport at which a utility carrying each breakpoint variant
 * can apply. The unprefixed group applies from zero width up, so it is measured
 * against the narrowest phone the product supports.
 */
const VIEWPORT_FLOOR_PX: Record<string, number> = {
  "": 375,
  sm: 640,
  md: 768,
  lg: 1024,
};

/**
 * Horizontal space between an `end`-anchored panel's trailing edge and the
 * START edge of the viewport that is NOT available to the panel, measured on
 * the notifications trigger at 375px: 16px of container padding (`px-4`), the
 * 48px profile button, the 4px `gap-1` between them, and a 16px gutter so the
 * panel does not sit flush against the viewport edge.
 *
 * It is the worst case of the two triggers (the account trigger is last in the
 * cluster, so only the padding and the gutter are ahead of it), and it is
 * applied to both — a budget that is right for the tighter of two identical
 * constructions is the useful one.
 */
const TRAILING_CHROME_PX = 16 + 48 + 4 + 16;

/** `w-80` -> 320. Tailwind's spacing scale is n/4 rem at a 16px root. */
function fixedWidthPx(token: Token): number | null {
  const m = /^w-(\d+(?:\.\d+)?)$/.exec(token.utility);
  if (!m) return null;
  return (parseFloat(m[1]) / 4) * 16;
}

const bell = () => screen.getByRole("button", { name: /^Notifications/ });
const avatar = () => screen.getByRole("button", { name: "Account menu" });

/** Open a disclosure and hand back its panel plus the element that is its
 *  positioning ancestor in the markup. */
async function openPanel(trigger: HTMLElement) {
  await userEvent.click(trigger);
  const id = trigger.getAttribute("aria-controls");
  expect(id, "the trigger names no panel").toBeTruthy();
  const panel = document.getElementById(id as string);
  expect(panel, `no element with id ${id}`).toBeTruthy();
  return {
    panel: panel as HTMLElement,
    wrapper: (panel as HTMLElement).parentElement as HTMLElement,
  };
}

/** Both dropdowns, named the way the audit names them. */
const PANELS: { name: string; trigger: () => HTMLElement }[] = [
  { name: "notifications", trigger: bell },
  { name: "account", trigger: avatar },
];

describe("resp-002 — the dropdown panels fit the viewport they open in", () => {
  PANELS.forEach(({ name, trigger }) => {
    it(`${name}: every fixed width fits the narrowest viewport it applies at`, async () => {
      render(<Topbar />);
      const { panel } = await openPanel(trigger());

      const overflowing: string[] = [];
      tokensOf(panel.className).forEach((token) => {
        const width = fixedWidthPx(token);
        if (width === null) return;
        const bps = breakpointsOf(token);
        const key = bps.length > 0 ? bps[0] : "";
        const floor = VIEWPORT_FLOOR_PX[key];
        if (floor === undefined) return;
        if (width + TRAILING_CHROME_PX > floor) {
          overflowing.push(
            `${token.raw} = ${width}px + ${TRAILING_CHROME_PX}px of chrome = ` +
              `${width + TRAILING_CHROME_PX}px, but it applies from ${floor}px wide`
          );
        }
      });

      expect(
        overflowing,
        `The ${name} panel is wider than the space it hangs in, and every ancestor is ` +
          `overflow-hidden (app/(app)/layout.tsx is 'flex h-dvh overflow-hidden'), so the strip ` +
          `that falls outside cannot be scrolled to at all:\n${overflowing.join("\n")}`
      ).toEqual([]);
    });

    it(`${name}: stretches between both inset edges at the narrowest width`, async () => {
      render(<Topbar />);
      const { panel } = await openPanel(trigger());
      const tokens = tokensOf(panel.className);

      const unprefixed = (pred: (t: Token) => boolean) =>
        tokens.filter((t) => pred(t) && breakpointsOf(t).length === 0).map((t) => t.raw);

      const starts = unprefixed((t) => /^-?start-/.test(t.utility));
      const ends = unprefixed((t) => /^-?end-/.test(t.utility));

      expect(
        ends,
        `The ${name} panel does not anchor its trailing edge at the narrowest width.`
      ).not.toEqual([]);
      expect(
        starts,
        `The ${name} panel anchors only its trailing edge (${ends.join(", ")}) and then takes a ` +
          `fixed width, so on a 375px phone its leading edge lands outside the viewport. Below the ` +
          `first breakpoint it has to span from one inset edge to the other instead.`
      ).not.toEqual([]);
    });

    it(`${name}: releases the stretch and the containing block at the same breakpoint`, async () => {
      // The pair. The panel can only stretch across the viewport if its
      // containing block IS the viewport-wide topbar; while the 36px trigger
      // wrapper is `relative`, `start-4 end-4` resolves against 36px of button
      // and the panel collapses to a sliver. Convert one half and the fix is
      // worse than the bug — the same shape as HOUSE-RULES rule 23.
      render(<Topbar />);
      const { panel, wrapper } = await openPanel(trigger());

      const released = breakpointsWhere(
        tokensOf(panel.className),
        (t) => t.utility === "start-auto"
      );
      const positioned = breakpointsWhere(
        tokensOf(wrapper.className),
        (t) => t.utility === "relative"
      );

      expect(
        released,
        `The ${name} panel never releases its leading inset, so it can never take a fixed width.`
      ).not.toEqual([]);
      expect(
        positioned,
        `The ${name} panel stops stretching at [${released.join(", ")}] but its containing block ` +
          `becomes the trigger wrapper at [${positioned.join(", ")}]. Those have to be the same ` +
          `breakpoint: while the wrapper is positioned, the panel's insets resolve against a 36px ` +
          `button, not the topbar.`
      ).toEqual(released);
    });
  });

  it("keeps the disclosure contract the last batch landed", async () => {
    // Not a duplicate of tests/components/topbar-menus.test.tsx — it is the
    // hook this file finds the panel by, so if it changes, the assertions above
    // would start silently testing nothing.
    render(<Topbar />);
    const { panel } = await openPanel(bell());
    expect(panel.id).toBe("topbar-notifications-panel");
    expect(bell()).toHaveAttribute("aria-expanded", "true");
    expect(panel).not.toHaveAttribute("role", "menu");
  });
});
