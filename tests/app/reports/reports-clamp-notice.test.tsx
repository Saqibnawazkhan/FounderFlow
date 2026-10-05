// @vitest-environment jsdom
/**
 * rep-009, the reachability half: the clamp notice must actually RENDER.
 *
 * `reportWindow` sets `requestedStart` when it narrows a span, and
 * tests/app/reports/reports-custom-range-bounds.test.ts pins that decision as a
 * pure function. On its own that proves nothing a customer experiences — this
 * codebase's signature defect is complete, tested code with no caller, and an
 * "explanation" the user never sees would be exactly that: the page would still
 * silently redraw a narrower range, which is the part of this finding that
 * matters.
 *
 * So this drives the real component through a real click and asserts the sentence
 * is in the document, and that it is NOT there for an ordinary range.
 *
 * WHY THE "All time" PRESET rather than typing into the Custom inputs: it reaches
 * the same clamp through the path a user hits by accident rather than on purpose.
 * One transaction with a mistyped or corrupt year — a stored row, not typed input
 * — opens the all-time window a millennium back, and no date picker stands between
 * the customer and that.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/*
 * THE THREE CHARTS ARE STUBBED, and this is a FLAKE FIX, not a convenience.
 *
 * `reports-client.tsx` pulls each chart through `next/dynamic` with `ssr:false`,
 * so mounting it starts three async chunk loads that resolve into recharts. This
 * file drives the component with `userEvent` on REAL timers, so those loads race
 * every click: the suite caught this test failing once in six consecutive runs,
 * after 22.8 SECONDS in a file whose other case finishes in milliseconds. A test
 * that fails under load and passes when the machine is quiet is worse than no
 * test, because the next red run gets waved through as "that one again".
 *
 * Stubbing them changes nothing this file asserts — it is about whether a STATUS
 * MESSAGE renders, and the charts carry none of it. Its two sibling reports tests
 * already avoid the same cost.
 */
vi.mock("@/app/(app)/reports/reports-charts", () => ({
  CashFlowBarChart: () => null,
  CategoriesPieChart: () => null,
  FoundersHorizontalBar: () => null,
}));
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReportsClient } from "@/app/(app)/reports/reports-client";
import type { Company, Transaction, User } from "@/lib/types";

const company: Company = {
  id: "c1",
  name: "Nimbus Labs",
  industry: "SaaS",
  currency: "USD",
  createdAt: "2026-01-01T00:00:00.000Z",
  ownerId: "u1",
};

const users: User[] = [
  {
    id: "u1",
    name: "Ayesha Khan",
    email: "ayesha@nimbus.test",
    role: "admin",
    companyId: "c1",
    createdAt: "2026-01-01T00:00:00.000Z",
  } as User,
];

function txn(date: string, over: Partial<Transaction> = {}): Transaction {
  return {
    id: `t-${date}`,
    companyId: "c1",
    type: "expense",
    amount: 100,
    category: "Ops",
    description: "row",
    date,
    addedBy: "u1",
    addedByName: "Ayesha Khan",
    createdAt: date,
    ...over,
  } as Transaction;
}

/** This month, so "All time" has a recent end to clamp towards. */
function thisMonthIso(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15)).toISOString();
}

/*
 * THE CLOCK IS FROZEN, and that is not tidiness.
 *
 * `thisMonthIso()` below reads `new Date()`, so every fixture in this file was
 * dated relative to whenever the suite happened to run. The audit recorded this
 * exact shape as A55 and counted twelve files carrying it: "green all day and
 * red in one window". On 2026-10-05 this file failed once in a full-suite run
 * and passed on the next, with no code change between them.
 *
 * A fixed instant removes the window. Mid-month on purpose: the 15th is far
 * from both month boundaries, so a UTC-vs-local day difference (the suite pins
 * TZ=America/Bogota, five hours behind UTC) cannot move a fixture into or out
 * of the period being asserted.
 */
const FROZEN_NOW = new Date("2026-06-15T12:00:00.000Z");

/**
 * The CLAMP notices on screen, by their own copy — not every `role="status"`.
 *
 * `/reports` renders TWO polite live regions now: the range-clamp notice this
 * file is about (reports-client.tsx:1155, gated on `range.requestedStart`) and
 * the ledger-coverage notice RES-001 added afterwards (:1170, gated on
 * `coverageNote`). `queryByRole("status")` could not tell them apart, so this
 * test asserted "no status region anywhere" and would have failed the day any
 * unrelated live region appeared on the page — blaming the clamp for it.
 *
 * Matching the clamp's own wording is what makes the assertion mean what its
 * name says. The sibling test above pins that wording from the other side, so
 * the two cannot drift apart silently.
 */
function clampNotices(): string[] {
  return screen
    .queryAllByRole("status")
    .map((el) => el.textContent ?? "")
    .filter((t) => /cannot chart|most recent/i.test(t));
}

beforeAll(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(FROZEN_NOW);
});

afterAll(() => {
  vi.useRealTimers();
});

describe("rep-009 — the narrowed range explains itself on screen", () => {
  it("says so when a millennium-old row would open an absurd window", async () => {
    const user = userEvent.setup();
    render(
      <ReportsClient
        transactions={[txn("1000-01-01T00:00:00.000Z"), txn(thisMonthIso())]}
        users={users}
        company={company}
      />
    );
    // The window only widens once the reader asks for all time; the default is 6m.
    expect(screen.queryByRole("status")).toBeNull();
    await user.click(screen.getByRole("button", { name: "All time" }));
    const notice = screen.getByRole("status");
    expect(notice.textContent ?? "").toMatch(/cannot chart|most recent/i);
    // And the same helper the silence test relies on must SEE it here. Without
    // this line `clampNotices()` could return [] for any reason — a renamed
    // role, a reworded notice — and the silence assertion below would pass
    // while asserting nothing at all.
    expect(clampNotices(), "clampNotices() is blind to the notice it filters for").toHaveLength(1);
  });

  it("stays silent for an ordinary ledger, so the notice means something", async () => {
    // A warning that is always on screen is furniture. If this goes red, the clamp
    // is firing on ranges it should leave alone and every real report now carries
    // an apology.
    const user = userEvent.setup();
    render(<ReportsClient transactions={[txn(thisMonthIso())]} users={users} company={company} />);
    await user.click(screen.getByRole("button", { name: "All time" }));
    expect(clampNotices(), "the clamp notice fired on an ordinary ledger").toEqual([]);
    await user.click(screen.getByRole("button", { name: "1 year" }));
    expect(clampNotices(), "the clamp notice fired on an ordinary ledger").toEqual([]);
  });
});
