/**
 * "Bilal mentioned you" on an EXPENSE must land on that expense.
 *
 * FINDING tasks-and-comments-003, the finance half. `createCommentAction`
 * builds the mention notification's link for a comment on an EXPENSE as
 * `/expenses?transactionId=<id>&comment=<id>` and has done since the tasks half
 * was fixed. (Since transactions-ledger-016 it reads the row's `type` and sends
 * an income row's mention to /revenue and a capital row's to /investments —
 * neither of those islands honours the param yet, which is why this file still
 * only covers /expenses.) `/tasks?taskId=` is honoured —
 * tasks-client.tsx scrolls the card into view and flashes it — but
 * expenses-client.tsx contained no `useSearchParams` at all, so the finance
 * mention resolved to a bare /expenses: no scroll, no highlight, nothing on
 * screen to say which of a workspace's rows the conversation was about. The
 * finding was recorded as closed after the tasks half landed. It was half
 * closed.
 *
 * WHY THE FILTER CASE IS IN HERE. The notification bell is rendered on
 * /expenses too, so the common way to follow one of these links is a CLIENT-SIDE
 * navigation from /expenses to /expenses?transactionId=…. The island never
 * unmounts, so whatever search text or category filter the reader had typed is
 * still applied — and if it excludes the target, the deep link scrolls to a row
 * that is not in the DOM and the user sees a filtered list that provably does
 * not contain the expense they were mentioned on. That is the same failure the
 * tasks half was fixed for, arrived at from the other direction.
 *
 * WHAT IS MOCKED: the router, the store (useMoney / useNumberFormat read the
 * workspace currency and locale from it), and the leaf modals, which are not
 * what this file is about. The table, the list, the filters and the deep-link
 * effect are the real component.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TransactionWithCount } from "@/lib/queries/transactions";
import type { User } from "@/lib/types";

/* ───────────────────────────── mocks ─────────────────────────────────── */

const nav = vi.hoisted(() => ({
  router: { refresh: vi.fn(), push: vi.fn() },
  /** The current query string, as the component's `useSearchParams` sees it. */
  params: new URLSearchParams(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => nav.router,
  useSearchParams: () => nav.params,
}));

// Recharts behind next/dynamic: ~200KB of SVG machinery with nothing to say
// about which row is highlighted.
vi.mock("next/dynamic", () => ({ default: () => () => null }));

vi.mock("react-hot-toast", () => ({
  default: { error: vi.fn(), success: vi.fn() },
}));
vi.mock("@/lib/actions/transactions", () => ({
  deleteTransactionAction: vi.fn(async () => ({ success: true })),
}));
vi.mock("@/components/ui/confirm-dialog", () => ({
  useConfirm: () => async () => true,
}));
vi.mock("@/components/transactions/transaction-form", () => ({
  TransactionForm: () => null,
}));
vi.mock("@/components/transactions/import-transactions-modal", () => ({
  ImportTransactionsModal: () => null,
}));
vi.mock("@/components/comments/comment-thread-modal", () => ({
  CommentThreadModal: () => null,
}));
// The real dictionary and the real formatters; only the store is faked, because
// that is where the currency and locale come from.
vi.mock("@/lib/store", () => ({
  useStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ locale: "en", currentCompany: { id: "c1", currency: "PKR" } }),
  useStoreHasHydrated: () => true,
}));

import { ExpensesClient } from "@/app/(app)/expenses/expenses-client";

/* ──────────────────────────── fixtures ───────────────────────────────── */

function expense(over: Partial<TransactionWithCount> = {}): TransactionWithCount {
  return {
    id: "tx_1",
    companyId: "c1",
    type: "expense",
    amount: 1200,
    category: "Office Rent",
    description: "September rent",
    date: "2026-09-02T00:00:00.000Z",
    addedBy: "u1",
    addedByName: "Ayesha",
    createdAt: "2026-09-02T00:00:00.000Z",
    commentCount: 0,
    ...over,
  } as TransactionWithCount;
}

/** The row the mention points at, deliberately not the first in the list. */
const MENTIONED = expense({
  id: "tx_9",
  category: "Software",
  description: "Figma annual seat",
  amount: 4800,
  commentCount: 2,
});

const ROWS: TransactionWithCount[] = [
  expense(),
  expense({ id: "tx_2", category: "Salaries", description: "June payroll", amount: 250000 }),
  MENTIONED,
];

const USERS: User[] = [{ id: "u1", name: "Ayesha" } as User];

function renderExpenses() {
  return render(
    <ExpensesClient
      transactions={ROWS}
      users={USERS}
      projects={[]}
      currentUserId="u1"
      currentUserRole="admin"
      currency="PKR"
    />
  );
}

/**
 * Every node that renders the mentioned expense. /expenses draws the SAME row
 * twice — a `<tr>` for md+ and an `<li>` card for phones, one of which CSS
 * hides — so "the row" is a set, not an element. jsdom lays nothing out, so
 * both are present here, which is precisely the shape that makes a naive
 * id→element map scroll to the hidden one.
 */
function nodesForMentionedRow(): HTMLElement[] {
  const hits: HTMLElement[] = [];
  screen.getAllByText(MENTIONED.description).forEach((el) => {
    const row = el.closest("tr,li");
    if (row) hits.push(row as HTMLElement);
  });
  return hits;
}

beforeEach(() => {
  nav.params = new URLSearchParams();
  nav.router.refresh.mockClear();
  vi.restoreAllMocks();
});

/* ───────────────────────────── the contract ──────────────────────────── */

describe("tasks-and-comments-003 (finance half) — /expenses?transactionId=", () => {
  it("scrolls the mentioned expense into view", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView =
      scrollIntoView as unknown as typeof Element.prototype.scrollIntoView;
    nav.params = new URLSearchParams("transactionId=tx_9&comment=cm_4");

    renderExpenses();

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    // The element it scrolled to must be a row for THIS expense — a scroll to
    // the top of the table is not a scroll to the row.
    const scrolledTo = scrollIntoView.mock.instances[0] as HTMLElement;
    expect(
      nodesForMentionedRow().indexOf(scrolledTo),
      "scrollIntoView was called on something that is not the mentioned row"
    ).toBeGreaterThan(-1);
  });

  it("flashes the mentioned expense so the eye can find it", async () => {
    nav.params = new URLSearchParams("transactionId=tx_9&comment=cm_4");
    renderExpenses();

    // The same highlight the tasks list row uses, so the two surfaces answer a
    // mention the same way.
    await waitFor(() => {
      const highlighted = nodesForMentionedRow().filter(
        (el) => el.className.indexOf("bg-primary/[0.08]") !== -1
      );
      expect(highlighted.length, "no row carries the highlight").toBeGreaterThan(0);
    });

    // And nothing else is flashed.
    screen.getAllByText("June payroll").forEach((el) => {
      const row = el.closest("tr,li") as HTMLElement | null;
      expect(row?.className.indexOf("bg-primary/[0.08]")).toBe(-1);
    });
  });

  it("does not flash anything when the page is opened normally", async () => {
    renderExpenses();
    await waitFor(() => expect(screen.getAllByText("June payroll").length).toBeGreaterThan(0));
    nodesForMentionedRow().forEach((el) => {
      expect(el.className.indexOf("bg-primary/[0.08]")).toBe(-1);
    });
  });

  it("lands on the row even when the reader's own filter would hide it", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView =
      scrollIntoView as unknown as typeof Element.prototype.scrollIntoView;
    const user = userEvent.setup();
    const { rerender } = renderExpenses();

    // The reader was already on /expenses, looking at something else.
    await user.type(screen.getByLabelText("Search expenses"), "payroll");
    expect(screen.queryAllByText(MENTIONED.description)).toHaveLength(0);

    // Now they click the bell. Same route, same island, new query string.
    nav.params = new URLSearchParams("transactionId=tx_9&comment=cm_4");
    rerender(
      <ExpensesClient
        transactions={ROWS}
        users={USERS}
        projects={[]}
        currentUserId="u1"
        currentUserRole="admin"
        currency="PKR"
      />
    );

    await waitFor(() => expect(nodesForMentionedRow().length).toBeGreaterThan(0));
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
  });
});
