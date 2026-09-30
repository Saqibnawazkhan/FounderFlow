/**
 * acct-016 on /signup — the one place the reader has nothing else to look at.
 *
 * `signupAction` answers an address that belongs to a tombstoned account with
 * "That email belongs to a FounderFlow account that was deleted. Contact support
 * to restore it, or sign up with a different email address."
 * (lib/actions/auth.ts:228). The page delivered it with
 * `toast.error(result.error || t.auth.signupFailedToast)` and nothing else, at a
 * toaster duration of 3500ms (components/providers.tsx:186).
 *
 * WHY THIS SITE IS WORSE THAN THE /team ONE. The person reading it is a
 * prospective customer, unauthenticated, two steps into a form, and the message
 * asks them to pick between contacting support and using another address. There
 * is no notification bell, no settings page, no session — nothing else on the
 * screen carries any trace of what just happened. They press the button again,
 * get the same 3.5 seconds, and leave.
 *
 * WHAT IS PINNED HERE. The rendered DOM, not a state variable: the previous wave
 * shipped a hint that was computed, asserted and never rendered, and 18 tests
 * stayed green while the JSX line was missing. So every assertion below mounts
 * the real page, drives the real failing submit, and reads the text off the
 * screen. Deleting the rendered line in app/signup/page.tsx turns this file red.
 *
 * The copy is never retyped as an expectation — each test feeds the action's own
 * sentence in and looks for that same sentence out, so this file pins the
 * SURFACE and cannot drift when the wording changes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/* ───────────────────────────── mocks ─────────────────────────────────── */

// next/font is a build-time transform; imported straight into vitest it throws.
vi.mock("@/components/landing/fonts", () => ({ display: { variable: "font-display" } }));

const actions = vi.hoisted(() => ({ signupAction: vi.fn() }));
vi.mock("@/lib/actions/auth", () => ({
  signupAction: (input: unknown) => actions.signupAction(input),
}));

const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("react-hot-toast", () => ({
  default: Object.assign(vi.fn(), { error: toasts.error, success: toasts.success }),
}));

// The real dictionary; only the store is faked, because that is where the
// locale comes from.
vi.mock("@/lib/store", () => ({
  useStore: (selector: (s: Record<string, unknown>) => unknown) => selector({ locale: "en" }),
  useStoreHasHydrated: () => true,
}));

import SignupPage from "@/app/signup/page";
import { en } from "@/lib/i18n/strings";

/* ──────────────────────────── fixtures ───────────────────────────────── */

/** The refusal acct-016 added, spelled as lib/actions/auth.ts:228 returns it. */
const DELETED_ACCOUNT_REFUSAL =
  "That email belongs to a FounderFlow account that was deleted. " +
  "Contact support to restore it, or sign up with a different email address.";

/** Drive both steps of the form and press Create workspace. */
async function submitSignup(user: ReturnType<typeof userEvent.setup>, email = "ghost@example.com") {
  await user.type(screen.getByLabelText(en.auth.fullName), "Ghost Founder");
  await user.type(screen.getByLabelText(en.auth.workEmail), email);
  await user.type(screen.getByLabelText(en.auth.password), "Hunter2Hunter2");
  await user.click(screen.getByRole("button", { name: en.auth.continue }));
  await user.type(await screen.findByLabelText(en.auth.companyName), "Nimbus Labs");
  await user.click(screen.getByRole("button", { name: en.auth.createWorkspaceCta }));
}

/* ─────────────────────────────── tests ───────────────────────────────── */

describe("a refused signup leaves its instruction on the screen", () => {
  beforeEach(() => {
    actions.signupAction.mockReset();
    toasts.error.mockReset();
    toasts.success.mockReset();
  });

  it("renders the deleted-account remedy where it can be re-read", async () => {
    actions.signupAction.mockResolvedValue({ success: false, error: DELETED_ACCOUNT_REFUSAL });

    const user = userEvent.setup();
    render(<SignupPage />);
    await submitSignup(user);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(DELETED_ACCOUNT_REFUSAL);
  });

  it("keeps the address that caused it, so the remedy is one edit away", async () => {
    actions.signupAction.mockResolvedValue({ success: false, error: DELETED_ACCOUNT_REFUSAL });

    const user = userEvent.setup();
    render(<SignupPage />);
    await submitSignup(user, "ghost@example.com");

    await screen.findByRole("alert");
    expect(screen.getByLabelText(en.auth.workEmail)).toHaveValue("ghost@example.com");
  });

  it("survives pressing Back to step 1, where the remedy is acted on", async () => {
    // THE HEADLINE CLAIM, FINALLY EXERCISED. The remedy for this refusal is
    // "sign up with a different email address", and that field is back on step
    // 1 — so the whole point of placing the alert outside both step wrappers is
    // that pressing Back does not take the reason with it. Until now nothing
    // clicked Back: the nearest case only checked the email input kept its
    // value, which was never at risk, because both steps stay mounted and RHF
    // holds the value regardless of where the alert lives.
    actions.signupAction.mockResolvedValue({ success: false, error: DELETED_ACCOUNT_REFUSAL });

    const user = userEvent.setup();
    const { container } = render(<SignupPage />);
    await submitSignup(user);
    await screen.findByRole("alert");

    await user.click(screen.getByRole("button", { name: en.auth.back }));

    // Back to step 1, and the reason is still readable.
    expect(await screen.findByLabelText(en.auth.workEmail)).toBeVisible();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(DELETED_ACCOUNT_REFUSAL);

    // AND IT IS NOT INSIDE THE STEP THAT IS NOW PUT AWAY. This is the assertion
    // that makes the test real rather than decorative. app/signup/page.tsx hides
    // the inactive step with Tailwind's `hidden` class, which has no COMPUTED
    // effect in jsdom — no stylesheets — so `toBeVisible()` alone cannot tell a
    // correctly-placed alert from one nested inside the put-away step, and
    // moving the JSX into the step-2 wrapper would leave every other case here
    // green while destroying the behaviour. The class attribute IS in the DOM
    // though, so ancestry answers the question that visibility cannot: an alert
    // inside a `.hidden` subtree is invisible to a real browser, whatever jsdom
    // reports. Checked in both directions below, so it holds on either step.
    container.querySelectorAll(".hidden").forEach((putAway) => {
      expect(
        putAway.contains(alert),
        "the refusal is nested inside the step wrapper that is currently hidden, so a " +
          "real browser shows the reader nothing — it must live outside both wrappers"
      ).toBe(false);
    });
    // GUARD THE GUARD: if the wrappers ever stop using `hidden`, the loop above
    // iterates nothing and passes without checking anything. This line is what
    // makes that a failure instead of a silent hole.
    expect(container.querySelectorAll(".hidden").length).toBeGreaterThan(0);
  });

  it("falls back to the generic sentence when the server sends no reason", async () => {
    // `result.error` is typed as present, but the toast already had a `||`
    // fallback for it and the persistent line must not be the one surface that
    // silently renders nothing.
    actions.signupAction.mockResolvedValue({ success: false, error: "" });

    const user = userEvent.setup();
    render(<SignupPage />);
    await submitSignup(user);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(en.auth.signupFailedToast);
  });

  it("surfaces a thrown action the same way, instead of a dead Creating… button", async () => {
    // A server action that throws means a DB or env-var problem. The page
    // already knew to say something; it said it for 3.5 seconds.
    actions.signupAction.mockRejectedValue(new Error("boom"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const user = userEvent.setup();
    render(<SignupPage />);
    await submitSignup(user);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(en.auth.networkErrorToast);
    consoleError.mockRestore();
  });

  it("clears the previous refusal the moment a new attempt starts", async () => {
    // A stale instruction sitting under an in-flight retry reads as a second
    // failure for the same reason. The second call never settles on purpose, so
    // what is asserted is the clear-on-submit, not a clear-on-success.
    actions.signupAction.mockResolvedValue({ success: false, error: DELETED_ACCOUNT_REFUSAL });

    const user = userEvent.setup();
    render(<SignupPage />);
    await submitSignup(user);
    await screen.findByRole("alert");

    actions.signupAction.mockReturnValue(new Promise(() => {}));
    await user.click(screen.getByRole("button", { name: en.auth.createWorkspaceCta }));

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("still fires the toast, which is what catches the eye in the first place", async () => {
    actions.signupAction.mockResolvedValue({ success: false, error: DELETED_ACCOUNT_REFUSAL });

    const user = userEvent.setup();
    render(<SignupPage />);
    await submitSignup(user);

    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith(DELETED_ACCOUNT_REFUSAL));
  });
});

describe("the signup refusal outlives the toast", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is still on screen long after 3500ms would have taken the toast away", async () => {
    // `shouldAdvanceTime` leaves React's and RHF's own timers running in real
    // time so the form still works; the explicit jump is what proves nothing
    // clears the line.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    actions.signupAction.mockReset();
    actions.signupAction.mockResolvedValue({ success: false, error: DELETED_ACCOUNT_REFUSAL });

    render(<SignupPage />);
    await submitSignup(user);
    await screen.findByRole("alert");

    vi.advanceTimersByTime(30_000);

    expect(screen.getByRole("alert")).toHaveTextContent(DELETED_ACCOUNT_REFUSAL);
  });
});
