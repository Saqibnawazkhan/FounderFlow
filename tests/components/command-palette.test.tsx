/**
 * <CommandPalette> — the two clocks.
 *
 * Nav filtering is synchronous and local; workspace search is debounced and
 * remote. Almost every bug this component can have lives in the seam between
 * those two, and none of them is visible by reading the render: a stale
 * response painting over a fresh one, a one-character term firing five
 * workspace scans, the arrow keys resetting to zero when late results arrive.
 * Each of those looks like a flicker to a user and like nothing at all to a
 * reviewer, so each gets a test here.
 *
 * Fake timers throughout, because the debounce is the thing being tested. The
 * server action is mocked with promises this file resolves BY HAND, in an
 * order it chooses — a mock that resolves in call order would make the most
 * important test below pass no matter what the component did.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommandPalette } from "@/components/layout/command-palette";
import type { SearchGroup } from "@/lib/schemas/search";
import type { SearchHit, SearchResults } from "@/lib/queries/search";

// The palette calls the action directly; the query behind it is covered by
// tests/lib/queries/search-scoping.test.ts.
const searchAction = vi.fn();
vi.mock("@/lib/actions/search", () => ({
  searchAction: (input: unknown) => searchAction(input),
}));

// useRouter throws outside an App Router provider, and `push` is how "Enter
// opens it" is observable at all.
const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push,
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  }),
}));

// The real store persists to localStorage and seeds a demo workspace on init;
// all this component reads from it is the signed-in role (which nav rows to
// offer) and the locale (which `useT` resolves against).
const store = vi.hoisted(() => ({
  state: { currentUser: { role: "admin" }, locale: "en" } as {
    currentUser: { role: string } | null;
    locale: string;
  },
}));
vi.mock("@/lib/store", () => ({
  useStore: (selector: (s: unknown) => unknown) => selector(store.state),
}));

/** Comfortably past the palette's ~200ms debounce. */
const PAST_DEBOUNCE_MS = 250;

const onClose = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  searchAction.mockReset();
  push.mockReset();
  onClose.mockReset();
  store.state = { currentUser: { role: "admin" }, locale: "en" };
});

afterEach(() => {
  vi.useRealTimers();
});

function hit(group: SearchGroup, id: string, title: string, href: string): SearchHit {
  return { group, id, title, subtitle: null, href };
}

function answer(...groups: SearchResults["groups"]) {
  return { success: true as const, data: { groups } };
}

function openPalette() {
  render(<CommandPalette open onClose={onClose} />);
  return screen.getByRole("combobox");
}

/** Type a whole term at once — the debounce, not the keystrokes, is the subject. */
function typeTerm(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } });
}

/** Let the debounce fire and any settled promise flush into React. */
async function letTheDebounceFire(ms = PAST_DEBOUNCE_MS) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Every selectable row, in render order. Index === keyboard position. */
function options(): HTMLElement[] {
  return screen.queryAllByRole("option");
}

function selectedIndex(): number {
  return options().findIndex((o) => o.getAttribute("aria-selected") === "true");
}

async function pressKey(key: string) {
  await act(async () => {
    fireEvent.keyDown(window, { key });
  });
}

describe("CommandPalette (nav and workspace search on two clocks)", () => {
  /**
   * THE MOST VALUABLE TEST IN THIS FILE — it is Phase H's fifth acceptance
   * criterion, and the only one that cannot be checked by hand.
   *
   * Two requests are in flight (a pause mid-word fired "bud", typing resumed
   * and fired "budget") and nothing makes them return in order. Here the OLDER
   * one lands LAST, which is the case that breaks a palette with no request-id
   * guard: the user is looking at "budget" and the screen fills with answers to
   * a question they finished asking half a second ago. Resolving in call order
   * would let a broken component pass, so the resolution order is inverted on
   * purpose.
   */
  it("ignores a slow earlier response that lands after a newer one", async () => {
    const pending = new Map<string, (r: unknown) => void>();
    searchAction.mockImplementation(
      (input: { q: string }) => new Promise((resolve) => pending.set(input.q, resolve))
    );

    const input = openPalette();

    typeTerm(input, "bud");
    await letTheDebounceFire();
    expect(searchAction).toHaveBeenCalledWith({ q: "bud" });

    typeTerm(input, "budget");
    await letTheDebounceFire();
    expect(searchAction).toHaveBeenCalledWith({ q: "budget" });

    // The newer question is answered first…
    await act(async () => {
      pending.get("budget")!(
        answer({
          group: "task",
          hits: [hit("task", "t1", "Budget review", "/tasks?taskId=t1")],
        })
      );
    });

    // …and the older one limps in afterwards.
    await act(async () => {
      pending.get("bud")!(
        answer({
          group: "task",
          hits: [hit("task", "t9", "Budgie mock-up", "/tasks?taskId=t9")],
        })
      );
    });

    expect(screen.getByText("Budget review")).toBeInTheDocument();
    expect(screen.queryByText("Budgie mock-up")).toBeNull();
    // Iterated rather than spot-checked: the stale answer must not appear
    // anywhere in the list, not merely below the fresh one.
    for (const option of options()) {
      expect(option.textContent).not.toContain("Budgie");
    }
    // And the late arrival must not have re-armed the spinner belonging to a
    // request that already came back.
    expect(screen.queryByText("Searching…")).toBeNull();
  });

  it("does not ask the server for a one-character query", async () => {
    searchAction.mockResolvedValue(answer());

    const input = openPalette();
    typeTerm(input, "b");
    // Well past the debounce — the term is below the schema's floor, so there
    // is no request to wait for at any point.
    await letTheDebounceFire(2000);

    expect(searchAction).not.toHaveBeenCalled();
  });

  it("still filters navigation without waiting for the server", async () => {
    // Never settles: if nav rendering were waiting on the workspace half, this
    // test would time out instead of failing an assertion.
    searchAction.mockImplementation(() => new Promise(() => {}));

    const input = openPalette();
    typeTerm(input, "tasks");

    // No timer advance at all — nav is on the other clock.
    expect(searchAction).not.toHaveBeenCalled();
    const rows = options();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.textContent?.toLowerCase()).toContain("task");
    }
    expect(screen.queryByRole("option", { name: /dashboard/i })).toBeNull();
  });

  it("moves through navigation and workspace results as one sequence", async () => {
    searchAction.mockResolvedValue(
      answer(
        { group: "task", hits: [hit("task", "t1", "Budget review", "/tasks?taskId=t1")] },
        { group: "budget", hits: [hit("budget", "b1", "Infra", "/budgets")] }
      )
    );

    const input = openPalette();
    typeTerm(input, "budget");
    await letTheDebounceFire();

    // One nav row (/budgets) followed by two workspace hits in two sections.
    const rows = options();
    expect(rows.length).toBe(3);
    expect(rows[0].textContent).toContain("/budgets");
    expect(rows[1].textContent).toContain("Budget review");
    expect(rows[2].textContent).toContain("Infra");

    // Exactly one row is ever selected, and arrowing down walks straight out
    // of the nav rows into the first workspace hit — nobody arrowing down
    // thinks in sections, so a reset to zero at the boundary is the bug.
    const walked: number[] = [selectedIndex()];
    for (let step = 0; step < rows.length; step++) {
      await pressKey("ArrowDown");
      expect(options().filter((o) => o.getAttribute("aria-selected") === "true")).toHaveLength(1);
      walked.push(selectedIndex());
    }
    // Down the whole list and back round to the top.
    expect(walked).toEqual([0, 1, 2, 0]);

    await pressKey("ArrowUp");
    expect(selectedIndex()).toBe(rows.length - 1);
  });

  it("opens the highlighted workspace hit on Enter", async () => {
    searchAction.mockResolvedValue(
      answer({ group: "task", hits: [hit("task", "t1", "Budget review", "/tasks?taskId=t1")] })
    );

    const input = openPalette();
    typeTerm(input, "budget");
    await letTheDebounceFire();

    // Past the single nav row and onto the task hit.
    await pressKey("ArrowDown");
    expect(options()[selectedIndex()].textContent).toContain("Budget review");

    await pressKey("Enter");

    // The href the server sent, verbatim — the palette does not build its own.
    expect(push).toHaveBeenCalledWith("/tasks?taskId=t1");
    // Closed too: a palette left open over the page it just navigated to is
    // still swallowing every arrow key.
    expect(onClose).toHaveBeenCalled();
  });

  it("renders only the groups the server sent", async () => {
    // A member's palette is the finance gate's last mile: the server omits the
    // transaction and budget groups entirely, and the component must not
    // conjure a heading for a section it did not receive.
    store.state = { currentUser: { role: "member" }, locale: "en" };
    searchAction.mockResolvedValue(
      answer({ group: "task", hits: [hit("task", "t1", "Budget review", "/tasks?taskId=t1")] })
    );

    const input = openPalette();
    typeTerm(input, "budget");
    await letTheDebounceFire();

    const sections = screen.queryAllByRole("group").map((g) => g.getAttribute("aria-label"));
    expect(sections).toHaveLength(1);
    // Nothing offered a member may not have: no finance section, and no
    // finance nav row either.
    for (const row of options()) {
      expect(row.textContent).not.toContain("/budgets");
      expect(row.textContent).not.toContain("/expenses");
    }
  });
});

/**
 * a11y-006 — the palette declares `role="dialog" aria-modal="true"`, which is a
 * promise that nothing outside it is reachable. These are that promise stated
 * in the four terms a user actually feels: Tab cannot walk out of the sheet,
 * Shift-Tab cannot leave by the back door of the invisible full-viewport
 * backdrop, the page behind is gone from the accessibility tree while the
 * palette is open, and whatever opened the palette has focus again once it
 * closes.
 *
 * REAL TIMERS IN THIS BLOCK. `userEvent` schedules its own work on setTimeout,
 * so the fake clock the rest of this file needs would hang `user.tab()`.
 * Nothing here types, so the 200ms debounce never arms and there is no clock to
 * control.
 */
describe("CommandPalette (the modal dialog contract)", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  /**
   * The app shell the palette opens over: the control that opened it and a
   * background link, standing in for the sidebar's seventeen.
   */
  function Shell({ open }: { open: boolean }) {
    return (
      <>
        <div data-testid="shell">
          <button type="button" data-testid="trigger">
            Search
          </button>
          <a href="/dashboard">Dashboard</a>
        </div>
        <CommandPalette open={open} onClose={onClose} />
      </>
    );
  }

  it("keeps Tab inside the palette instead of walking into the page behind it", async () => {
    const user = userEvent.setup();
    render(<Shell open />);
    const dialog = screen.getByRole("dialog");
    screen.getByRole("combobox").focus();

    // Two presses more than there are rows: enough to walk off the end of the
    // list whatever the row count is, which is where focus used to escape.
    const presses = options().length + 2;
    for (let i = 0; i < presses; i++) {
      await user.tab();
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }
  });

  it("wraps Shift+Tab inside the sheet instead of onto the invisible backdrop", async () => {
    const user = userEvent.setup();
    render(<Shell open />);
    const input = screen.getByRole("combobox");
    input.focus();
    // Asserted, not assumed: from anywhere else — `document.body` included —
    // Shift-Tab reaches the input by the ordinary route and the assertion below
    // would pass without a trap existing at all.
    expect(input).toHaveFocus();

    await user.tab({ shift: true });

    // The backdrop is a full-viewport <button> that sits BEFORE the sheet in DOM
    // order, so an untrapped palette lands focus there: a control the user
    // cannot see, one more Shift-Tab from the page behind.
    expect(document.activeElement).toBe(input);
  });

  it("hides the page behind it from assistive tech, and gives it back on close", () => {
    const { rerender } = render(<Shell open />);
    const shell = screen.getByTestId("shell");

    expect(shell).toHaveAttribute("aria-hidden", "true");
    // The contract, not merely the attribute: role queries walk the
    // accessibility tree, so the link behind the overlay is gone from it while
    // the palette owns the screen.
    expect(screen.queryByRole("link", { name: "Dashboard" })).toBeNull();
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    rerender(<Shell open={false} />);
    expect(shell).not.toHaveAttribute("aria-hidden");
    expect(screen.getByRole("link", { name: "Dashboard" })).toBeInTheDocument();
  });

  it("returns focus to whatever opened it when Escape closes it", async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" data-testid="trigger" onClick={() => setOpen(true)}>
            Search
          </button>
          <CommandPalette open={open} onClose={() => setOpen(false)} />
        </>
      );
    }

    render(<Harness />);
    const trigger = screen.getByTestId("trigger");
    trigger.focus();
    fireEvent.click(trigger);

    // Waited for on purpose: the palette focuses its input on the next frame,
    // and without this the assertion below would also pass on a palette that
    // never moved focus anywhere in the first place.
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveFocus());

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(trigger).toHaveFocus();
  });

  it("keeps the result rows out of the tab order and announces them instead", () => {
    render(<Shell open />);
    const input = screen.getByRole("combobox");
    const rows = options();

    // A combobox with `aria-activedescendant` keeps DOM focus in the input and
    // points at the active row; rows that are their own tab stops make the
    // pointer a lie, because a screen reader announces the focused row instead.
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(row).toHaveAttribute("tabindex", "-1");
    }
    expect(input).toHaveAttribute("aria-activedescendant", rows[0].id);
  });
});
