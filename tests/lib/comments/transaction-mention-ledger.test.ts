// @vitest-environment node

/**
 * "Ayesha mentioned you" on a SALE has to land on /revenue
 * (transactions-ledger-016, the notification half).
 *
 * WHY THIS FILE EXISTS NOW. Until transactions-ledger-016 the comment
 * affordance lived on /expenses alone, so every transaction comment was an
 * expense comment and `createCommentAction`'s hard-coded
 * `/expenses?transactionId=…` was right by accident. The moment /revenue and
 * /investments grew the same control, that link became the bug
 * tasks-and-comments-003 closed, reopened for the two new surfaces: the
 * mentioned reader is told someone is talking about one of their rows and then
 * dropped on a page whose island filters to `type === "expense"` and therefore
 * PROVABLY does not contain it — no scroll, no highlight, no row.
 *
 * `revalidatePath` carries the same mistake more quietly: revalidating
 * /expenses after a comment on an income row leaves the other ledger's cached
 * comment count stale.
 *
 * WHY THE FAKE PRISMA PROJECTS `select`. Same argument as
 * tests/lib/comments/mention-delivery.test.ts, and it is load-bearing here:
 * the property under test is whether the action ASKS the database for the row's
 * `type`. A fake that ignored `select` would hand it a `type` it never
 * requested, and the assertions below would pass against the bug.
 *
 * RESIDUAL, recorded so nobody reads a green file as more than it is: /revenue
 * and /investments do not yet READ `?transactionId=` — only
 * app/(app)/expenses/expenses-client.tsx scrolls to and flashes the row. So the
 * reader now lands on the ledger that holds their row rather than on one that
 * cannot, and has to find it in the list. Honouring the param on all three is
 * the remaining half, and it is a strictly smaller gap than landing on the
 * wrong page.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/* ───────────────────────── the fake Prisma client ───────────────────────── */

const prisma = vi.hoisted(() => {
  /** The transaction row the action is pointed at, as a FULL row. */
  const txn: Record<string, unknown> = {
    id: "tx_9",
    companyId: "c_nimbus",
    type: "income",
    deletedAt: null,
  };
  const author = { id: "u_author", name: "Ayesha Raza", handle: "ayesha", avatar: null };
  // Ali is a COFOUNDER, and that is load-bearing rather than decoration.
  // tasks-and-comments-016 added an audience filter to createCommentAction: a
  // mentioned person is only notified if they could actually OPEN the thread,
  // which for a transaction thread means `canSeeFinances` (admin or cofounder).
  // This row carried no `role` at all until 2026-10-05, so it read as a member,
  // the filter correctly refused the ping, and all four link assertions below
  // failed with `link was ""`.
  //
  // The fixture was the thing that was wrong, not the product — a roster where
  // nobody can read the thread is not a world this action ever sees. Cofounder
  // rather than admin on purpose: it proves the gate admits the non-admin
  // finance role, instead of only ever exercising the author's own.
  const roster: Record<string, unknown>[] = [
    author,
    { id: "u_ali", name: "Ali Khan", handle: "ali", avatar: null, role: "cofounder" },
  ];
  /** Every `select` the action passed, so a test can assert what it asked for. */
  const selects: unknown[] = [];

  /** Copy only the keys the caller's `select` asked for, like SQL would. */
  function project(row: Record<string, unknown>, select: unknown): Record<string, unknown> {
    if (!select || typeof select !== "object") return { ...row };
    const s = select as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    const keys = Object.keys(s);
    for (let i = 0; i < keys.length; i++) if (s[keys[i]] === true) out[keys[i]] = row[keys[i]];
    return out;
  }

  const db = {
    transaction: {
      findUnique: (args: { select?: unknown }) => {
        selects.push(args.select);
        return Promise.resolve(project(txn, args.select));
      },
    },
    user: {
      findUnique: () => Promise.resolve({ ...author }),
      findMany: (args: { select?: unknown }) =>
        Promise.resolve(roster.map((r) => project(r, args.select))),
    },
    comment: {
      create: () => Promise.resolve({ id: "cm_7", transactionId: "tx_9" }),
    },
  };

  return { txn, selects, db };
});

const notify = vi.hoisted(() => ({
  notifyUsers: vi.fn((_input: unknown) => Promise.resolve({ notified: 1 })),
}));
const cache = vi.hoisted(() => ({ revalidatePath: vi.fn((_path: string) => undefined) }));
const session = vi.hoisted(() => ({
  user: { id: "u_author", companyId: "c_nimbus", role: "admin" } as Record<string, unknown>,
}));

vi.mock("@/lib/db", () => ({ db: prisma.db }));
vi.mock("@/lib/auth", () => ({ auth: () => Promise.resolve({ user: session.user }) }));
vi.mock("@/lib/notify/fan-out", () => ({ notifyUsers: notify.notifyUsers }));
vi.mock("@/lib/sentry-server", () => ({ captureServerError: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: cache.revalidatePath }));

import { createCommentAction } from "@/lib/actions/comments";

/** The link `notifyUsers` was asked to deliver. */
function mentionLink(): string {
  const call = notify.notifyUsers.mock.calls[0];
  const input = call ? (call[0] as { link?: unknown }) : null;
  return String(input?.link ?? "");
}

beforeEach(() => {
  notify.notifyUsers.mockClear();
  cache.revalidatePath.mockClear();
  prisma.selects.length = 0;
  session.user = { id: "u_author", companyId: "c_nimbus", role: "admin" };
});

const LEDGERS = [
  { type: "income", path: "/revenue", label: "a sale" },
  { type: "investment", path: "/investments", label: "a capital injection" },
  { type: "expense", path: "/expenses", label: "an expense" },
];

describe("a transaction mention deep-links at the ledger the row lives on", () => {
  LEDGERS.forEach((ledger) => {
    it(`sends a mention on ${ledger.label} to ${ledger.path}`, async () => {
      prisma.txn.type = ledger.type;

      const res = await createCommentAction({
        body: "@ali why is this booked to Consulting?",
        transactionId: "tx_9",
      });
      expect(res.success).toBe(true);

      const link = mentionLink();
      expect(link.indexOf(ledger.path + "?") === 0, `link was "${link}"`).toBe(true);
      // Still carries both params: `transactionId=` is the one the ledger
      // islands read, `comment=` is what deleteCommentAction sweeps by.
      expect(link).toContain("transactionId=tx_9");
      expect(link).toContain("comment=cm_7");
    });

    it(`revalidates ${ledger.path} after a comment on ${ledger.label}`, async () => {
      prisma.txn.type = ledger.type;

      await createCommentAction({ body: "noted", transactionId: "tx_9" });

      const paths = cache.revalidatePath.mock.calls.map((c) => c[0]);
      expect(paths).toContain(ledger.path);
    });
  });

  it("asks the database for the row's type, rather than assuming one", async () => {
    // The whole point: without `type` in the select, Prisma returns undefined
    // and every ledger collapses back to the hard-coded /expenses.
    prisma.txn.type = "income";
    await createCommentAction({ body: "@ali look", transactionId: "tx_9" });

    const asked = JSON.stringify(prisma.selects);
    expect(asked.indexOf("type") !== -1, `selects were ${asked}`).toBe(true);
    // And the company check it already did is still there — this must not have
    // been traded for the type.
    expect(asked.indexOf("companyId") !== -1, `selects were ${asked}`).toBe(true);
  });

  it("falls back to /expenses for a type it does not recognise", async () => {
    // A row whose `type` is something the ledger map has never heard of must
    // still produce a usable link, not "/undefined?transactionId=…".
    prisma.txn.type = "barter";
    await createCommentAction({ body: "@ali odd one", transactionId: "tx_9" });

    expect(mentionLink().indexOf("/expenses?") === 0).toBe(true);
  });
});
