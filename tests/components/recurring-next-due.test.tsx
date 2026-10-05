// @vitest-environment jsdom
/**
 * finance-planning-020, at the surface: a recurring rule card must say when it
 * will next charge.
 *
 * The page's own promise is "set them up once and they post on their own. A
 * daily job creates the next instance when it's due". The card listed Frequency,
 * Created, Generated N txns and "Last fired <date>" — nothing a customer could
 * check that promise against, and no way to tell a rule that double-posted
 * (finance-planning-004) from one whose author left (013) from one that missed a
 * month: all three render identically.
 *
 * AND THE ONE DATE IT DID SHOW WAS MISLABELLED. Since the 004 fix,
 * `seedStampFor` stamps `lastMaterializedAt` FORWARD past the current period's
 * due day, so a day-15 rule created on 3 October carries `2026-10-15` while its
 * only posted row is dated 3 October. The card rendered that under "Last fired".
 * Both halves are asserted here, because fixing the first and leaving the second
 * would put a correct date next to a false one.
 *
 * WHY THE CLOCK IS A PROP. `serverNowMs` follows time-011: a
 * `useMemo(() => new Date())` runs once on the server and again at hydration —
 * two different instants — and React logs a mismatch when they fall either side
 * of a UTC midnight. Passing the RSC's instant also makes this file able to
 * state a contract at all, since "today" is an input rather than the test
 * runner's wall clock.
 *
 * NO TIMERS AND NO CLICKS. Static renders: nothing here submits, so there is no
 * next/dynamic chunk load to race. The server actions are stubbed only so the
 * client module can be imported without reaching a server module.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("react-hot-toast", () => ({
  default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/components/ui/confirm-dialog", () => ({
  useConfirm: () => async () => true,
}));

vi.mock("@/lib/actions/recurring", () => ({
  createRecurringRuleAction: vi.fn(async () => ({ success: true, data: { ruleId: "r-new" } })),
  deleteRecurringRuleAction: vi.fn(async () => ({ success: true, data: undefined })),
  toggleRecurringRuleAction: vi.fn(async () => ({ success: true, data: undefined })),
}));

import { RecurringClient } from "@/app/(app)/recurring/recurring-client";
import type { RecurringRuleClient } from "@/lib/queries/recurring";

/** Monthly office rent on the 15th, created by the person looking at it. */
function rentRule(over: Partial<RecurringRuleClient> = {}): RecurringRuleClient {
  return {
    id: "r1",
    companyId: "c1",
    type: "expense",
    amount: 50000,
    category: "Office Rent",
    description: "Gulberg office",
    addedBy: "u-ayesha",
    addedByName: "Ayesha Khan",
    frequency: "monthly",
    dayOfMonth: 15,
    dayOfWeek: null,
    active: true,
    startDate: "2026-10-03T00:00:00.000Z",
    // What `seedStampFor` writes for a day-15 rule created on 3 October: the
    // seed transaction has paid for October, so the scheduler resumes in
    // November (tests/lib/recurring/seed-stamp.test.ts).
    lastMaterializedAt: "2026-10-15T00:00:00.000Z",
    createdAt: "2026-10-03T00:00:00.000Z",
    materializedCount: 1,
    authorRemoved: false,
    ...over,
  };
}

/** 3 October 2026, the day the rule above was created. */
const OCT_3 = Date.UTC(2026, 9, 3, 14, 30);

function renderCard(rule: RecurringRuleClient, nowMs: number = OCT_3) {
  return render(
    <RecurringClient
      rules={[rule]}
      currentUserId="u-ayesha"
      currentUserRole="admin"
      projects={[]}
      serverNowMs={nowMs}
    />
  );
}

describe("a healthy monthly rule", () => {
  it("says when it will next charge", () => {
    renderCard(rentRule());

    const line = screen.getByText(/next due/i);
    expect(line.textContent).toMatch(/Nov 15, 2026/);
  });

  it("does not label the forward-stamped date as a past firing", () => {
    // THE BUG, verbatim: `Last fired {lastMaterializedAt}` rendered 15 October
    // on a rule created on the 3rd, in the past tense, as the card's only date.
    renderCard(rentRule());

    expect(document.body.textContent).not.toMatch(/last fired/i);
    expect(screen.getByText(/covered through/i).textContent).toMatch(/Oct 15, 2026/);
  });

  it("renders the stored calendar day, not the viewer's (money-007)", () => {
    // The suite's TZ pin is America/Bogota, five hours west of UTC, so
    // `toLocaleDateString()` on a UTC-midnight date-only value renders the day
    // BEFORE — which is what the old "Last fired" line did, printing
    // `14/10/2026` for a stamp of `2026-10-15`. A next-due date a day out is a
    // date the scheduler will not honour, so both lines are asserted whole.
    renderCard(rentRule());

    expect(screen.getByText(/next due/i).textContent).toBe("Next due Nov 15, 2026");
    expect(screen.getByText(/covered through/i).textContent).toBe("Covered through Oct 15, 2026");
    expect(document.body.textContent).not.toMatch(/14\/10\/2026|Nov 14|Oct 14/);
  });

  it("shows the next occurrence of a weekly rule", () => {
    // 2026-10-05 is a Monday; the rule fired on it, so the next is the 12th.
    renderCard(
      rentRule({
        category: "Cleaning",
        frequency: "weekly",
        dayOfMonth: null,
        dayOfWeek: 1,
        lastMaterializedAt: "2026-10-05T00:00:00.000Z",
      }),
      Date.UTC(2026, 9, 5, 18, 0)
    );

    expect(screen.getByText(/next due/i).textContent).toMatch(/Oct 12, 2026/);
  });
});

describe("a rule the nightly job has missed", () => {
  it("shows the owed date rather than skipping to the next one", () => {
    // A rule running since January, last stamp 15 August, now 3 October:
    // September was never posted, and the next run will post September. This
    // card is the only place a founder can see that — the three invisible
    // defects of the filing (a double seed, a removed author, a missed month)
    // all rendered identically before it.
    //
    // The `startDate` matters and the first draft of this case got it wrong:
    // with the factory's 3 October start, `isRuleDueOn` correctly refuses to
    // fire on 15 September, so the honest answer there is 15 October. A rule
    // cannot carry a stamp from before it existed.
    renderCard(
      rentRule({
        startDate: "2026-01-01T00:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
        lastMaterializedAt: "2026-08-15T00:00:00.000Z",
        materializedCount: 8,
      })
    );

    expect(document.body.textContent).toMatch(/Sep 15, 2026/);
    expect(document.body.textContent).toMatch(/not posted yet/i);
    expect(document.body.textContent).not.toMatch(/Oct 15, 2026/);
  });
});

describe("a rule that will not post at all", () => {
  it("says nothing is scheduled while it is paused", () => {
    // Pause means nothing posts. A next-due date here would be a promise the
    // scheduler has been told not to keep.
    renderCard(rentRule({ active: false }));

    expect(screen.queryByText(/next due/i)).not.toBeInTheDocument();
    expect(document.body.textContent).toMatch(/paused . nothing scheduled/i);
  });

  it("promises no date on a rule suspended for a removed author", () => {
    // The materializer writes nothing at all for these (route.ts: "NOTHING IS
    // WRITTEN: no claim, no stamp"), so the schedule is dead even though
    // `active` is still true. finance-planning-013's notice explains it; this
    // asserts the card does not contradict that notice two lines above it.
    renderCard(rentRule({ authorRemoved: true, addedBy: "u-gone" }));

    expect(document.body.textContent).toMatch(/stopped posting/i);
    expect(screen.queryByText(/next due/i)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Nov 15, 2026/);
  });
});
