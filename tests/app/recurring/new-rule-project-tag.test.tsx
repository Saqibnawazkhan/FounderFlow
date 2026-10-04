/**
 * money-005 (the UI half) and money-002 (the client mirror), from the only place
 * a recurring rule is actually born: the New-rule modal on /recurring.
 *
 * ── WHY THE SERVER-SIDE TESTS DO NOT COVER THIS ──────────────────────────────
 * `tests/lib/actions/recurring-project-budget.test.ts`,
 * `tests/lib/cron/materialize-route.test.ts` and
 * `tests/lib/recurring/materialize.test.ts` already pin the whole server path:
 * the tag is parsed, persisted, carried onto the seed transaction and onto every
 * future posting, and `checkBudgetThresholdAfterExpense` is called with it. All
 * of them pass `projectId: "p1"` to the action DIRECTLY. Not one of them mounts
 * the form — so for as long as the form built its payload field by field and
 * never included `projectId`, every one of those tests was green while no rule
 * in the product could be tagged at all. Rent, salaries and subscriptions — the
 * spend a founder most wants a cap on — could not trip an 80%/100% alert, while
 * /budgets (lib/queries/budgets.ts) counted those same rows and went red in
 * silence.
 *
 * That is this repo's most productive defect shape ("shipped, tested,
 * unreachable", ~10 instances), so these tests assert THE PAYLOAD THE CLIENT
 * SENDS, not that a <select> renders. A picker whose value never reaches the
 * action would satisfy a render-only assertion and reproduce the bug exactly.
 *
 * The amount cases are here for the same reason: the form keeps a FLAT MIRROR of
 * `NewRecurringRuleSchema` (react-hook-form needs both day fields registered at
 * once), and a mirror that is missing the scale rule is the one place a 0.004
 * rule can still be typed and submitted.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const createRecurringRuleAction = vi.fn();
vi.mock("@/lib/actions/recurring", () => ({
  createRecurringRuleAction: (input: unknown) => createRecurringRuleAction(input),
  deleteRecurringRuleAction: vi.fn(async () => ({ success: true, data: undefined })),
  toggleRecurringRuleAction: vi.fn(async () => ({ success: true, data: undefined })),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

// Fire-and-forget; stubbed so no toast portal renders into these queries.
vi.mock("react-hot-toast", () => ({
  default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));

vi.mock("@/components/ui/confirm-dialog", () => ({
  useConfirm: () => async () => true,
}));

// The real formatters, only the store faked — that is where currency and locale
// come from (`useMoney`, `useCurrency`, `useNumberFormat`).
vi.mock("@/lib/store", () => ({
  useStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ locale: "en", currentCompany: { id: "c1", currency: "PKR" } }),
  useStoreHasHydrated: () => true,
}));

import { RecurringClient } from "@/app/(app)/recurring/recurring-client";

const PROJECTS = [
  { id: "p1", name: "Apollo" },
  { id: "p2", name: "Borealis" },
];

type User = ReturnType<typeof userEvent.setup>;

/** Mount /recurring's client and open the New-rule modal. */
async function openForm(user: User, projects = PROJECTS): Promise<void> {
  render(
    <RecurringClient rules={[]} currentUserId="u-1" currentUserRole="admin" projects={projects} />
  );
  // The header button, not the empty state's "Add first rule".
  await user.click(screen.getByRole("button", { name: /^New rule$/i }));
  await screen.findByRole("button", { name: /^Create rule$/i });
}

/** The project picker. Labelled "Project (optional)". */
function picker(): HTMLSelectElement {
  return screen.getByLabelText(/^Project/) as HTMLSelectElement;
}

async function fillAmount(user: User, amount: string): Promise<void> {
  await user.type(screen.getByLabelText("Amount (PKR)"), amount);
}

async function submit(user: User): Promise<void> {
  await user.click(screen.getByRole("button", { name: /^Create rule$/i }));
}

/** The payload of the Nth call to the action. */
function payload(n = 0): Record<string, unknown> {
  return createRecurringRuleAction.mock.calls[n][0] as Record<string, unknown>;
}

beforeEach(() => {
  createRecurringRuleAction.mockReset();
  createRecurringRuleAction.mockResolvedValue({ success: true, data: { ruleId: "r-new" } });
});

describe("New recurring rule — the project tag reaches the action (money-005)", () => {
  it("sends the project the founder picked", async () => {
    const user = userEvent.setup();
    await openForm(user);

    await fillAmount(user, "50000");
    await user.selectOptions(picker(), "p2");
    await submit(user);

    await waitFor(() => expect(createRecurringRuleAction).toHaveBeenCalledTimes(1));
    expect(
      payload().projectId,
      "the rule was filed with no project, so this recurring spend counts against " +
        "no budget and can never fire an over-budget alert"
    ).toBe("p2");
  });

  it("keeps an untagged rule legal, and sends no empty string for it", async () => {
    // `RecurringRule.projectId` is `String?` and an untagged rule is the legal,
    // company-global spend path — it must work exactly as it did before.
    //
    // `undefined` rather than `""` is load-bearing: `createRecurringRuleAction`
    // parses the tag off the RAW input with its own
    // `z.string().trim().min(1).nullish()` (lib/actions/recurring.ts:53), so a
    // literal "" from the "no project" option is rejected outright with "Invalid
    // project" and the customer cannot create an untagged rule at all.
    const user = userEvent.setup();
    await openForm(user);

    await fillAmount(user, "50000");
    await submit(user);

    await waitFor(() => expect(createRecurringRuleAction).toHaveBeenCalledTimes(1));
    expect(
      payload().projectId,
      'the "no project" option sent "" — the action refuses that as an invalid project'
    ).toBeUndefined();
  });

  it("defaults to no project rather than to the first one", async () => {
    const user = userEvent.setup();
    await openForm(user);

    expect(
      picker().value,
      "a pre-selected project silently files rent against a budget nobody chose"
    ).toBe("");
  });

  it("renders no picker in a workspace with no projects, and still creates the rule", async () => {
    const user = userEvent.setup();
    await openForm(user, []);

    expect(screen.queryByLabelText(/^Project/), "nothing to pick from").toBeNull();

    await fillAmount(user, "1200");
    await submit(user);

    await waitFor(() => expect(createRecurringRuleAction).toHaveBeenCalledTimes(1));
    expect(payload().projectId).toBeUndefined();
    expect(payload().amount).toBe(1200);
  });
});

describe("New recurring rule — the form's amount mirror (money-002)", () => {
  it("refuses an amount the column cannot hold, before the action is called", async () => {
    // 0.004 is positive, passes every other rule in the mirror, and is stored by
    // a `Decimal(12, 2)` column as 0.00 — creating a rule AND a seed expense
    // that both contribute nothing to any total, and then re-posting 0.00 every
    // month for as long as the rule lives.
    const user = userEvent.setup();
    await openForm(user);

    await fillAmount(user, "0.004");
    await submit(user);

    expect(
      await screen.findByText(/2 decimal places/),
      "the mirror let a 0.004 rule through; the server schema is not the form's resolver"
    ).toBeInTheDocument();
    expect(createRecurringRuleAction).not.toHaveBeenCalled();
  });

  it("still accepts a 2-place amount", async () => {
    const user = userEvent.setup();
    await openForm(user);

    await fillAmount(user, "1234.56");
    await submit(user);

    await waitFor(() => expect(createRecurringRuleAction).toHaveBeenCalledTimes(1));
    expect(payload().amount).toBe(1234.56);
  });
});

describe("/recurring wires the picker's options", () => {
  it("hands the client the project list its Server Component fetched", () => {
    // The component test above proves the value reaches the action; this proves
    // there is anything to pick. `projects` is a REQUIRED prop so `tsc` also
    // refuses a page that forgets it, but the page is where the list is fetched
    // and the fetch is the part a later edit can quietly drop.
    const page = readFileSync("app/(app)/recurring/page.tsx", "utf8");

    expect(
      page,
      "no project list is fetched, so the money-005 picker has nothing to offer"
    ).toContain("listProjectOptions");
    expect(page, "the fetched list never reaches the client").toMatch(/projects=\{/);
  });
});
