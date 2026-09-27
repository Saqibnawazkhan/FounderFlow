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
import { act, fireEvent, render, screen } from "@testing-library/react";
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
