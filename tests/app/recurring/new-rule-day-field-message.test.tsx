/**
 * finance-planning-016 — what the New-rule modal says when "Day of month" is
 * empty.
 *
 * ── WHY THIS IS A COMPONENT TEST AND NOT A SCHEMA TEST ───────────────────────
 * `tests/lib/schemas/recurring.test.ts` already pins the SERVER union, which has
 * carried `invalid_type_error: "Pick a day of the month"` all along. It passes
 * numbers to `NewRecurringRuleSchema` directly, so it can never see the message
 * a customer actually gets: the resolver their keystrokes meet is the FLAT
 * MIRROR declared in `app/(app)/recurring/recurring-client.tsx` (react-hook-form
 * keeps both day fields registered at once), and the mirror's restated copy of
 * `dayOfMonth` had drifted away from the twin it narrows into. The input is
 * `register("dayOfMonth", { valueAsNumber: true })`, so an empty box is `NaN`,
 * ZodNumber rejects `NaN` as an invalid type, and the field rendered Zod's
 * default "Expected number, received nan" under the label — two keystrokes from
 * a pre-filled field, on the create path of the feature.
 *
 * Same defect shape as money-002 on the amount field in the same mirror: a
 * restated rule drifts, and only a test that mounts the form can tell.
 *
 * So these assertions are about THE TEXT ON SCREEN, and one of them derives the
 * expected string from the server schema rather than hard-coding it, so the two
 * cannot drift apart again without this file going red.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
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
import { NewRecurringRuleSchema } from "@/lib/schemas/recurring";

type User = ReturnType<typeof userEvent.setup>;

/** Mount /recurring's client and open the New-rule modal. */
async function openForm(user: User): Promise<void> {
  // `serverNowMs` is the clock the cards' next-due dates are computed from
  // (finance-planning-020); no rules are rendered here, so any fixed instant does.
  render(
    <RecurringClient
      rules={[]}
      currentUserId="u-1"
      currentUserRole="admin"
      projects={[]}
      serverNowMs={Date.UTC(2026, 9, 3)}
    />
  );
  // The header button, not the empty state's "Add first rule".
  await user.click(screen.getByRole("button", { name: /^New rule$/i }));
  await screen.findByRole("button", { name: /^Create rule$/i });
}

function dayInput(): HTMLInputElement {
  return screen.getByLabelText("Day of month") as HTMLInputElement;
}

/**
 * The text rendered under the "Day of month" input, or "" when the field is
 * clean. The field's own <div> holds the static hint first and the error last,
 * so the last <p> is the message — read as text rather than matched, so a
 * failure quotes what the customer actually sees.
 */
function dayError(): string {
  const field = dayInput().closest("div");
  const paragraphs = Array.from(field ? field.querySelectorAll("p") : []);
  if (paragraphs.length < 2) return "";
  return paragraphs[paragraphs.length - 1].textContent ?? "";
}

async function fillAmount(user: User, amount: string): Promise<void> {
  await user.type(screen.getByLabelText("Amount (PKR)"), amount);
}

async function submit(user: User): Promise<void> {
  await user.click(screen.getByRole("button", { name: /^Create rule$/i }));
}

/**
 * What the server union says about the same value — the wording the form is
 * supposed to be a mirror of. Derived, never hard-coded, so this file fails if
 * either side is edited on its own.
 */
function serverMessageForDayOfMonth(value: unknown): string {
  const res = NewRecurringRuleSchema.safeParse({
    type: "expense",
    amount: 50000,
    category: "Office Rent",
    description: "",
    frequency: "monthly",
    dayOfMonth: value,
  });
  expect(res.success, "the server union accepted a day it should refuse").toBe(false);
  const issue = res.success ? undefined : res.error.issues.find((i) => i.path[0] === "dayOfMonth");
  expect(issue, "no dayOfMonth issue to compare the form against").toBeDefined();
  return issue!.message;
}

beforeEach(() => {
  createRecurringRuleAction.mockReset();
  createRecurringRuleAction.mockResolvedValue({ success: true, data: { ruleId: "r-new" } });
});

describe("New recurring rule — the empty day-of-month message (finance-planning-016)", () => {
  it("tells the founder what to do instead of printing Zod's type error", async () => {
    const user = userEvent.setup();
    await openForm(user);

    await fillAmount(user, "50000");
    await user.clear(dayInput());
    await submit(user);

    await waitFor(() => expect(dayError(), "nothing was said about the empty field").not.toBe(""));
    expect(
      dayError(),
      "the cleared day field gave the customer compiler-speak instead of an instruction"
    ).toBe("Pick a day of the month");
    expect(createRecurringRuleAction).not.toHaveBeenCalled();
  });

  it("says exactly what the server twin it narrows into says", async () => {
    const expected = serverMessageForDayOfMonth(Number.NaN);

    const user = userEvent.setup();
    await openForm(user);

    await fillAmount(user, "50000");
    await user.clear(dayInput());
    await submit(user);

    await waitFor(() => expect(dayError()).not.toBe(""));
    expect(
      dayError(),
      "the form's mirror and the server union disagree about the same empty field"
    ).toBe(expected);
  });

  it("is human about a fractional day too, not 'Expected integer, received float'", async () => {
    // Reachable by typing: the <form> is `noValidate`, so the input's own
    // `min`/`max`/implicit step never run and 1.5 reaches the resolver.
    const user = userEvent.setup();
    await openForm(user);

    await fillAmount(user, "50000");
    await user.clear(dayInput());
    await user.type(dayInput(), "1.5");
    await submit(user);

    await waitFor(() => expect(dayError()).not.toBe(""));
    expect(dayError(), "a fractional day printed Zod's raw float text").toBe(
      serverMessageForDayOfMonth(1.5)
    );
    expect(createRecurringRuleAction).not.toHaveBeenCalled();
  });

  it("still creates the rule on the day the founder picked", async () => {
    // The fix replaces the mirror's day fields; the happy path has to survive it.
    const user = userEvent.setup();
    await openForm(user);

    await fillAmount(user, "50000");
    await user.clear(dayInput());
    await user.type(dayInput(), "15");
    await submit(user);

    await waitFor(() => expect(createRecurringRuleAction).toHaveBeenCalledTimes(1));
    const payload = createRecurringRuleAction.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.dayOfMonth).toBe(15);
    expect(payload.frequency).toBe("monthly");
  });
});
