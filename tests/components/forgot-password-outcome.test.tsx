/**
 * prodready-005, the UI half — what /forgot-password tells a customer who
 * cannot sign in.
 *
 * ── THE TWO FACTS THIS PAGE HAS TO HOLD AT ONCE ────────────────────────────
 *
 * 1. THE SEND CAN FAIL, SILENTLY. `sendEmail` returns `{ delivered: false }`
 *    when there is no SMTP transport or Gmail rejects the message, and on a
 *    production deployment it deliberately withholds the body from the log
 *    (it contains a live reset token, and Vercel function logs are readable by
 *    the whole team and any log drain — lib/email/send.ts:87). CLAUDE.md lists
 *    GMAIL_USER / GMAIL_APP_PASSWORD as "reset emails silently never send" if
 *    missing. Password reset is the ONLY self-service recovery path in the
 *    product, so the person reading this page is already locked out.
 *
 *    The page used to answer every outcome with "we've sent a link to reset
 *    your password" and a single "Back to sign in" link. Under a dropped send
 *    that is a false statement followed by a dead end: nothing arrives, and the
 *    page offers no way to try again.
 *
 * 2. IT MUST STILL NOT SAY WHETHER THE ACCOUNT EXISTS.
 *    `requestPasswordResetAction` answers every outcome — never registered,
 *    tombstoned, live, and internally failed — with one envelope carrying no
 *    payload at all. It used to carry `dispatched`, which was `true` for a live
 *    account on any deployment with SMTP configured and `false` otherwise: an
 *    enumeration oracle in the response body, closed in the action by auth-010
 *    (see tests/lib/actions/password-reset-enumeration.test.ts).
 *
 *    That makes the page's half of the guarantee stronger, not redundant, and
 *    the first test below states it in the form that survives the field coming
 *    back: the rendering must be identical for the real empty envelope AND for
 *    one that carries a delivery flag, i.e. the page must read nothing out of
 *    `result.data` at all. Whoever adds a `deliveryBlocked` signal later — the
 *    follow-up this slice recorded — has to keep that true or fail here.
 *
 * WHAT IS THEREFORE ASSERTED: identical output for both outcomes, and a panel
 * that gives a locked-out customer somewhere to go — resend, or a different
 * address — plus a throttle refusal that stays on screen instead of vanishing
 * with a toast.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// next/font is a build-time transform; imported straight into vitest it throws.
vi.mock("@/components/landing/fonts", () => ({ display: { variable: "font-display" } }));

const H = vi.hoisted(() => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
  requestPasswordResetAction: vi.fn(),
}));

vi.mock("react-hot-toast", () => ({ default: H.toast }));
vi.mock("@/lib/actions/password-reset", () => ({
  requestPasswordResetAction: H.requestPasswordResetAction,
}));

const { toast: toastMock, requestPasswordResetAction } = H;

import ForgotPasswordPage from "@/app/forgot-password/page";

const LOCKED_OUT = "founder@nimbus.app";

async function submit(email = LOCKED_OUT) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/email/i), email);
  await user.click(screen.getByRole("button", { name: /send reset link/i }));
  return user;
}

beforeEach(() => {
  requestPasswordResetAction.mockReset();
  toastMock.error.mockReset();
  toastMock.success.mockReset();
});

describe("the confirmation cannot be used to probe for accounts", () => {
  it("renders byte-identically, and ignores any delivery flag it is handed", async () => {
    // The real contract since auth-010: one payload-free envelope for every
    // outcome, so the page has nothing to leak.
    requestPasswordResetAction.mockResolvedValue({ success: true, data: undefined });
    const uniform = render(<ForgotPasswordPage />);
    await submit();
    await screen.findByRole("status");
    const uniformHtml = uniform.container.innerHTML;
    uniform.unmount();

    // And the version that matters if the field ever returns: a body that says
    // outright that the send happened. "Dispatched" means "no such account" when
    // it is false and "this address is registered" when it is true, so a page
    // that renders either differently is the oracle the action just stopped
    // being. This must be the same HTML as above.
    requestPasswordResetAction.mockResolvedValue({ success: true, data: { dispatched: true } });
    const flagged = render(<ForgotPasswordPage />);
    await submit();
    await screen.findByRole("status");

    expect(flagged.container.innerHTML).toBe(uniformHtml);
  });
});

describe("a locked-out customer whose email never arrives has somewhere to go", () => {
  beforeEach(() => {
    requestPasswordResetAction.mockResolvedValue({ success: true, data: undefined });
  });

  it("announces the confirmation to a screen reader instead of only painting it", async () => {
    render(<ForgotPasswordPage />);
    await submit();

    expect(await screen.findByRole("status")).toBeInTheDocument();
  });

  it("tells them what to do when nothing arrives", async () => {
    render(<ForgotPasswordPage />);
    await submit();

    const panel = await screen.findByRole("status");
    // Spam first, because it is the likeliest cause and costs nothing to check.
    expect(panel.textContent).toMatch(/spam/i);
    // And the honest part: this page cannot confirm delivery, so it must not
    // leave "it was sent" as the customer's only information.
    expect(panel.textContent).toMatch(/can fail|couldn't|cannot confirm|didn't arrive/i);
  });

  it("offers a resend that asks the server again for the same address", async () => {
    render(<ForgotPasswordPage />);
    const user = await submit();
    await screen.findByRole("status");

    expect(requestPasswordResetAction).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: /resend|send it again/i }));

    await waitFor(() => expect(requestPasswordResetAction).toHaveBeenCalledTimes(2));
    expect(requestPasswordResetAction).toHaveBeenLastCalledWith({ email: LOCKED_OUT });
  });

  it("offers a way back to the form for a mistyped address", async () => {
    render(<ForgotPasswordPage />);
    const user = await submit();
    await screen.findByRole("status");

    await user.click(screen.getByRole("button", { name: /different (email|address)/i }));

    // Back on the form, ready to type — not a fresh navigation the user has to
    // find for themselves.
    expect(await screen.findByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

describe("a refusal stays on the screen", () => {
  it("shows a throttled request inline, not as a toast that disappears", async () => {
    // auth-007: this endpoint is enumeration-safe, so a rate-limit refusal is
    // the ONE message it can give — and a 4-second toast is not a message to
    // someone who cannot sign in.
    requestPasswordResetAction.mockResolvedValue({
      success: false,
      error: "Too many reset requests. Try again in 15 minutes.",
    });

    render(<ForgotPasswordPage />);
    await submit();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Too many reset requests");
    // And it must NOT claim success.
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("clears a previous refusal when the customer tries again", async () => {
    requestPasswordResetAction.mockResolvedValueOnce({
      success: false,
      error: "Too many reset requests. Try again in 15 minutes.",
    });
    requestPasswordResetAction.mockResolvedValueOnce({ success: true, data: undefined });

    render(<ForgotPasswordPage />);
    const user = await submit();
    await screen.findByRole("alert");

    await user.click(screen.getByRole("button", { name: /send reset link/i }));

    await screen.findByRole("status");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
