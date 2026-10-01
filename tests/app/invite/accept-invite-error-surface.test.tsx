/**
 * A47 — the fourth toast-only surface, and the one with the least around it.
 *
 * WHAT THE SERVER SENDS. `acceptInviteAction` (lib/actions/team.ts) refuses an
 * acceptance with sentences the reader has to act on, not verdicts they can
 * shrug at: "This invite has expired. Ask your admin to send a new one.",
 * "This workspace is no longer active. Ask whoever invited you for a new
 * invite.", "This email belongs to a FounderFlow account that was deactivated.
 * Ask whoever invited you to restore it — a fresh invite to the same address
 * cannot replace it.", the seat-cap sentence, and worst of all "Account created,
 * but auto-sign-in failed. Sign in manually." — where the account now EXISTS and
 * the only remaining instruction in the product is in that string.
 *
 * WHAT THE CLIENT DID WITH IT. `toast.error(res.error)` and nothing else, at the
 * toaster's 3500ms duration. The reader here is not a signed-in admin with a
 * roster behind the toast; they are an anonymous invitee on a page whose entire
 * content is a heading, their own email and a password field. When the toast
 * goes, the screen says nothing at all about what happened, and on the
 * auto-sign-in branch nothing anywhere else in the product will ever tell them
 * their account was created.
 *
 * WHAT THIS FILE PINS, and why it is the DOM. The pattern is the one
 * app/signup/page.tsx and app/forgot-password/page.tsx already use — persist the
 * message into state AND fire the toast, and render it with `role="alert"` — and
 * the assertions read the text off the rendered output rather than checking that
 * a variable was computed. A previous wave in this repo was caught asserting a
 * hint had been computed while never checking it reached the screen, so deleting
 * the JSX left the suite green. Deleting the rendered line here turns this red.
 *
 * `role="alert"`, matching both of those pages: this is a failure the reader just
 * caused by pressing the button, so interrupting them with it is correct.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/* ───────────────────────────── mocks ─────────────────────────────────── */

const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("react-hot-toast", () => ({
  default: Object.assign(vi.fn(), { error: toasts.error, success: toasts.success }),
}));

const actions = vi.hoisted(() => ({ acceptInviteAction: vi.fn() }));
vi.mock("@/lib/actions/team", () => ({
  acceptInviteAction: (input: unknown) => actions.acceptInviteAction(input),
}));

import { AcceptInviteClient } from "@/app/invite/[token]/accept-invite-client";

/* ──────────────────────────── fixtures ───────────────────────────────── */

/**
 * Two of the action's real refusals, transcribed. They are string literals in
 * `acceptInviteAction`, so transcribing them is a genuine cross-check rather
 * than a copy of today's output of an interpolation.
 */
const DEAD_WORKSPACE_REFUSAL =
  "This workspace is no longer active. Ask whoever invited you for a new invite.";

const SIGN_IN_FAILED_REFUSAL = "Account created, but auto-sign-in failed. Sign in manually.";

/** Satisfies PasswordSchema (8+, lower, upper, digit) so zod lets the submit through. */
const STRONG = "Nimbus2026!";

function renderForm() {
  return render(
    <AcceptInviteClient
      token="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
      inviteeName="Omar Farooq"
      inviteeEmail="omar@nimbus.app"
    />
  );
}

async function submitPassword(): Promise<void> {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/choose a password/i), STRONG);
  // The button is inert until `useHydrated` flips (A14), so wait for it rather
  // than clicking into the pre-hydration window this component deliberately has.
  const button = screen.getByRole("button", { name: /accept & sign in/i });
  await waitFor(() => expect(button).not.toBeDisabled());
  await user.click(button);
}

beforeEach(() => {
  toasts.error.mockClear();
  toasts.success.mockClear();
  actions.acceptInviteAction.mockReset();
});

/* ─────────────────────────── the assertions ──────────────────────────── */

describe("a refused invite acceptance leaves its instruction on the screen", () => {
  it("renders the dead-workspace instruction where it can be re-read", async () => {
    actions.acceptInviteAction.mockResolvedValue({
      success: false,
      error: DEAD_WORKSPACE_REFUSAL,
    });

    renderForm();
    await submitPassword();

    const alert = await screen.findByRole("alert");
    expect(
      alert.textContent,
      "The invitee's whole screen is a heading, their email and a password box. When the " +
        "3500ms toast goes there is nothing left saying what happened, or what to do."
    ).toContain(DEAD_WORKSPACE_REFUSAL);
  });

  it("renders the one refusal that means the account now EXISTS", async () => {
    // The worst of the set. The User row was written and the token burnt; the
    // only instruction anywhere in the product is this sentence, and re-submitting
    // the form cannot work because the token is used. Losing it strands them.
    actions.acceptInviteAction.mockResolvedValue({
      success: false,
      error: SIGN_IN_FAILED_REFUSAL,
    });

    renderForm();
    await submitPassword();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(SIGN_IN_FAILED_REFUSAL);
  });

  it("still fires the toast, which is what pulls the eye to it", async () => {
    actions.acceptInviteAction.mockResolvedValue({
      success: false,
      error: DEAD_WORKSPACE_REFUSAL,
    });

    renderForm();
    await submitPassword();

    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith(DEAD_WORKSPACE_REFUSAL));
  });

  it("surfaces a thrown action the same way, not only a returned refusal", async () => {
    // "We couldn't reach the server. Try again." is an instruction too, and the
    // button has gone back to reading "Accept & sign in" by the time the toast
    // expires — so a toast-only delivery leaves a form that looks unsubmitted.
    actions.acceptInviteAction.mockRejectedValue(new Error("fetch failed"));

    renderForm();
    await submitPassword();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/couldn't reach the server/i);
  });

  it("clears the refusal when the invitee submits again", async () => {
    // A stale reason next to a fresh attempt is its own bug: the reader cannot
    // tell whether the sentence belongs to this press or the last one.
    actions.acceptInviteAction.mockResolvedValue({
      success: false,
      error: DEAD_WORKSPACE_REFUSAL,
    });

    renderForm();
    await submitPassword();
    await screen.findByRole("alert");

    actions.acceptInviteAction.mockResolvedValue({ success: false, error: "" });
    await submitPassword();

    await waitFor(() => expect(screen.queryByText(DEAD_WORKSPACE_REFUSAL)).not.toBeInTheDocument());
  });

  it("says nothing before the invitee has submitted anything", async () => {
    // Guard-the-guard: an alert that is always in the DOM would make every
    // assertion above pass whatever the component does with `res.error`.
    renderForm();

    expect(screen.queryByRole("alert")).toBeNull();
  });
});
