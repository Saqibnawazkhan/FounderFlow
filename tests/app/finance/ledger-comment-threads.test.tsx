/**
 * A ledger row has a conversation on it, whichever of the three ledgers it is
 * (transactions-ledger-016).
 *
 * WHAT WAS WRONG. `Comment.transactionId` is type-agnostic — the column points
 * at a Transaction, not at an expense — and the whole server half of the feature
 * already treats it that way: `createCommentAction` checks
 * `canSeeFinances(role)` plus "is this row in my company" and nothing about the
 * row's `type`, `mayReadTarget` in lib/queries/comments.ts mirrors exactly that
 * pair, and `getTransactions` computes `_count.comments` for EVERY row of all
 * three types. Only the UI disagreed: `expenses-client.tsx` was the single file
 * importing <CommentThreadModal>, so the per-row 💬 button — and the count the
 * query had already put on the wire — existed on /expenses alone.
 *
 * So "why is this 4.2M sale booked to Consulting?" had nowhere to live on the
 * page that shows the sale, while the identical question about a 4.2M expense
 * did. The conversation moves to Slack and the ledger stops being the record.
 *
 * WHAT THIS FILE PINS, from the reader's side rather than from the component's:
 *   1. Every row of every ledger has a comment control, with the count when
 *      there is one, in BOTH layouts — the md+ table and the phone card list.
 *   2. It is not gated on authorship. Discussing a figure is not editing it;
 *      every finance reader can comment (that is the only predicate the two
 *      server gates apply), so the control sits outside the
 *      "mine-or-admin" fence that wraps edit + delete.
 *   3. Clicking it opens the thread for THAT transaction id.
 *   4. The @-mention roster reaches the modal — and /revenue's Server Component
 *      actually fetches one. /investments already had `users` for its founder
 *      bars; /revenue had no roster at all, so a thread mounted there would have
 *      offered autocomplete over an empty list and resolved every `@name` to
 *      nobody. A prop the page never supplies is this repo's "shipped, tested,
 *      unreachable" shape, so point 4 is asserted against page.tsx too.
 *
 * WHAT IS MOCKED: the router, the store (useMoney / useNumberFormat read the
 * workspace currency and locale from it), and the leaf modals — including
 * <CommentThreadModal>, which is a recorder here: this file is about which rows
 * can open a thread and what the thread is told, not about the thread's own
 * rendering (tests/components cover that). The tables, the card lists and the
 * action cells are the real components.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TransactionWithCount } from "@/lib/queries/transactions";
import type { User } from "@/lib/types";

/* ───────────────────────────── mocks ─────────────────────────────────── */

/** Every set of props <CommentThreadModal> was mounted with, in order. */
const thread = vi.hoisted(() => ({
  opened: [] as {
    open: boolean;
    target: { transactionId?: string; taskId?: string };
    title: string;
    description?: string;
    companyUsers: { id: string; name: string }[];
  }[],
}));

vi.mock("@/components/comments/comment-thread-modal", () => ({
  CommentThreadModal: (props: {
    open: boolean;
    target: { transactionId?: string; taskId?: string };
    title: string;
    description?: string;
    companyUsers: { id: string; name: string }[];
  }) => {
    thread.opened.push(props);
    return null;
  },
}));

const nav = vi.hoisted(() => ({
  router: { refresh: vi.fn(), push: vi.fn() },
  params: new URLSearchParams(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => nav.router,
  useSearchParams: () => nav.params,
}));

// /expenses lazy-loads Recharts through next/dynamic. Chunk loads race every
// click on real timers, and the bar chart has nothing to say about which row
// can be commented on.
vi.mock("next/dynamic", () => ({ default: () => () => null }));

vi.mock("react-hot-toast", () => ({ default: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/lib/actions/transactions", () => ({
  deleteTransactionAction: vi.fn(async () => ({ success: true })),
}));
vi.mock("@/components/ui/confirm-dialog", () => ({ useConfirm: () => async () => true }));
vi.mock("@/components/transactions/transaction-form", () => ({ TransactionForm: () => null }));
vi.mock("@/components/transactions/import-transactions-modal", () => ({
  ImportTransactionsModal: () => null,
}));
// The real dictionary and the real formatters; only the store is faked, because
// that is where the currency and locale come from.
vi.mock("@/lib/store", () => ({
  useStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ locale: "en", currentCompany: { id: "c1", currency: "PKR" } }),
  useStoreHasHydrated: () => true,
}));

import { ExpensesClient } from "@/app/(app)/expenses/expenses-client";
import { RevenueClient } from "@/app/(app)/revenue/revenue-client";
import { InvestmentsClient } from "@/app/(app)/investments/investments-client";

/* ──────────────────────────── fixtures ───────────────────────────────── */

function row(over: Partial<TransactionWithCount>): TransactionWithCount {
  return {
    id: "tx_x",
    companyId: "c1",
    type: "expense",
    amount: 1200,
    category: "Office Rent",
    description: "A row",
    date: "2026-09-02T00:00:00.000Z",
    // Deliberately NOT the viewer below: the comment control must not be
    // fenced in with edit + delete.
    addedBy: "u_ayesha",
    addedByName: "Ayesha",
    createdAt: "2026-09-02T00:00:00.000Z",
    commentCount: 0,
    ...over,
  } as TransactionWithCount;
}

/** One quiet row and one with a conversation already on it, per type. */
const EXPENSE_QUIET = row({ id: "tx_e1", description: "September rent" });
const EXPENSE_TALKED = row({
  id: "tx_e2",
  description: "Figma annual seat",
  category: "Software",
  amount: 4800,
  commentCount: 3,
});
const INCOME_QUIET = row({
  id: "tx_r1",
  type: "income",
  category: "Product Sales",
  description: "Acme retainer",
  amount: 150_000,
});
const INCOME_TALKED = row({
  id: "tx_r2",
  type: "income",
  category: "Consulting",
  description: "Zenith platform build",
  amount: 4_200_000,
  commentCount: 2,
});
const CAPITAL_QUIET = row({
  id: "tx_i1",
  type: "investment",
  category: "Founder Capital",
  description: "Bilal top-up",
  amount: 500_000,
});
const CAPITAL_TALKED = row({
  id: "tx_i2",
  type: "investment",
  category: "Angel Investment",
  description: "Seed cheque — Hamza",
  amount: 9_000_000,
  commentCount: 1,
});

const USERS: User[] = [
  { id: "u_ayesha", name: "Ayesha Raza", role: "admin" } as User,
  { id: "u_bilal", name: "Bilal Ahmed", role: "cofounder" } as User,
];

/** The viewer: a co-founder who added NONE of the rows above. */
const VIEWER = { currentUserId: "u_bilal", currentUserRole: "cofounder" as const };

type Ledger = {
  label: string;
  path: string;
  /** The row with no comments yet, and the one with a count to show. */
  quiet: TransactionWithCount;
  talked: TransactionWithCount;
  render: () => void;
};

const LEDGERS: Ledger[] = [
  {
    label: "/expenses",
    path: "app/(app)/expenses/expenses-client.tsx",
    quiet: EXPENSE_QUIET,
    talked: EXPENSE_TALKED,
    render: () =>
      render(
        <ExpensesClient
          transactions={[EXPENSE_QUIET, EXPENSE_TALKED]}
          users={USERS}
          projects={[]}
          currency="PKR"
          {...VIEWER}
        />
      ),
  },
  {
    label: "/revenue",
    path: "app/(app)/revenue/revenue-client.tsx",
    quiet: INCOME_QUIET,
    talked: INCOME_TALKED,
    render: () =>
      render(
        <RevenueClient
          transactions={[INCOME_QUIET, INCOME_TALKED]}
          users={USERS}
          projects={[]}
          currency="PKR"
          rollups={{ income: { total: 4_350_000, count: 2 }, categories: [] }}
          {...VIEWER}
        />
      ),
  },
  {
    label: "/investments",
    path: "app/(app)/investments/investments-client.tsx",
    quiet: CAPITAL_QUIET,
    talked: CAPITAL_TALKED,
    render: () =>
      render(
        <InvestmentsClient
          transactions={[CAPITAL_QUIET, CAPITAL_TALKED]}
          users={USERS}
          projects={[]}
          currency="PKR"
          rollups={{ investment: { total: 9_500_000, count: 2 }, contributions: {} }}
          {...VIEWER}
        />
      ),
  },
];

beforeEach(() => {
  thread.opened.length = 0;
  nav.router.refresh.mockClear();
});

/* ═══════════════════════ the affordance exists ════════════════════════ */

describe("every ledger row can be discussed (transactions-ledger-016)", () => {
  LEDGERS.forEach((ledger) => {
    describe(ledger.label, () => {
      it("offers a comment control on a row nobody has commented on", () => {
        ledger.render();
        const buttons = screen.getAllByRole("button", {
          name: `Add a comment to ${ledger.quiet.description}`,
        });
        // Two nodes, not one: each ledger draws every row twice — a <tr> for
        // md+ and an <li> card for phones, one of which CSS hides. A control
        // added to the table alone is invisible on a phone.
        expect(buttons.length, `${ledger.label} draws the control in one layout only`).toBe(2);
      });

      it("shows the count on a row that already has a thread", () => {
        ledger.render();
        const buttons = screen.getAllByRole("button", {
          name: `Open comments (${ledger.talked.commentCount}) for ${ledger.talked.description}`,
        });
        expect(buttons.length).toBe(2);
        expect(buttons[0]).toHaveTextContent(String(ledger.talked.commentCount));
      });

      it("offers it on a row the viewer did not add, where edit and delete are refused", () => {
        ledger.render();
        // The fence that must NOT contain the comment control.
        expect(
          screen.queryAllByRole("button", { name: new RegExp(`^Delete .*${ledger.quiet.id}`) })
            .length
        ).toBe(0);
        expect(
          screen.queryAllByRole("button", { name: new RegExp("^Edit ") }).length,
          "the viewer added none of these rows, so no edit control should be here at all"
        ).toBe(0);
        expect(
          screen.getAllByRole("button", { name: `Add a comment to ${ledger.quiet.description}` })
            .length
        ).toBe(2);
      });

      it("opens the thread for that transaction, with the mention roster", async () => {
        const user = userEvent.setup();
        ledger.render();
        expect(thread.opened.length, "a thread is mounted before anything is clicked").toBe(0);

        await user.click(
          screen.getAllByRole("button", {
            name: `Open comments (${ledger.talked.commentCount}) for ${ledger.talked.description}`,
          })[0]
        );

        const last = thread.opened[thread.opened.length - 1];
        expect(last, `${ledger.label} mounted no comment thread`).toBeTruthy();
        expect(last.open).toBe(true);
        expect(last.target).toEqual({ transactionId: ledger.talked.id });
        // The row has to be identifiable in the modal header: a thread titled
        // "Comments" over a ledger of 400 rows says nothing.
        expect(last.title).toContain(ledger.talked.description);
        // @-mentions resolve against this list. Empty means every @name in the
        // thread resolves to nobody and no teammate is ever pinged.
        expect(last.companyUsers.map((u) => u.id)).toEqual(["u_ayesha", "u_bilal"]);
      });
    });
  });
});

/* ════════════ the roster /revenue hands down has to be real ═══════════ */

describe("the Server Components supply the roster their islands now need", () => {
  const source = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

  it("/revenue fetches the company roster and passes it to RevenueClient", () => {
    // Without this the prop above is one the page never supplies, and the
    // mention autocomplete on /revenue is an empty list in production while
    // this file is green.
    const code = source("app/(app)/revenue/page.tsx");
    expect(code.indexOf("getCompanyUsers") !== -1, "/revenue fetches no roster").toBe(true);
    expect(/users=\{/.test(code), "the roster is fetched but not passed down").toBe(true);
  });

  it("/investments and /expenses still pass theirs", () => {
    ["app/(app)/investments/page.tsx", "app/(app)/expenses/page.tsx"].forEach((rel) => {
      const code = source(rel);
      expect(code.indexOf("getCompanyUsers") !== -1, `${rel} fetches no roster`).toBe(true);
      expect(/users=\{/.test(code), `${rel} does not pass the roster down`).toBe(true);
    });
  });
});
