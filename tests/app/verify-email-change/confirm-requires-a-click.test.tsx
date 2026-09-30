/**
 * auth-015 — /verify-email-change must not apply the change on render.
 *
 * THE BUG. The page fired `confirmEmailChangeAction({ token })` from a mount
 * `useEffect`, guarded only against StrictMode's double-invoke by a ref. So
 * RENDERING the URL WAS the action. Outlook Safe Links, Proofpoint URL Defense
 * and similar gateways fetch — and sometimes render — linked pages before a
 * human ever sees the message, and this particular action moves the address
 * that /forgot-password delivers to. The customer's account recovery anchor
 * could move without them clicking anything.
 *
 * WHAT MAKES THE FIX REAL, AND WHY THESE ASSERTIONS. The token still proves
 * control of the destination inbox; the click proves a human. So the first test
 * below is the whole finding: after the page has rendered and settled, the
 * action must have been called ZERO times, and there must be a button to press.
 * Everything after it exists so the fix cannot be "delete the effect" — the
 * change must still complete, exactly once, on a real click, and the three
 * outcome panels the page already had (success / failure / expired) must
 * survive, with the failure staying on screen rather than passing through a
 * toast (a batch-3 decision: this page deliberately imports no toast at all).
 *
 * NOT ASSERTED, deliberately: that a mail scanner cannot press a button. That is
 * not testable in jsdom and does not need to be — a POST that no code path
 * issues until a click handler runs is the property, and it is the one above.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type ActionResult = { success: true; data: { email: string } } | { success: false; error: string };

const H = vi.hoisted(() => ({
  calls: [] as unknown[],
  /** Resolver for the pending action call, so the test drives the timing. */
  settle: null as null | ((r: unknown) => void),
  /** …and its reject, for the "the POST never landed" branch. */
  breakIt: null as null | ((e: unknown) => void),
  search: new URLSearchParams(),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => H.search,
}));

vi.mock("@/lib/actions/email-change", () => ({
  confirmEmailChangeAction: (input: unknown) => {
    H.calls.push(input);
    return new Promise((resolve, reject) => {
      H.settle = resolve;
      H.breakIt = reject;
    });
  },
}));

import VerifyEmailChangePage from "@/app/verify-email-change/page";

const NEW_EMAIL = "founder@newdomain.com";

/**
 * A structurally valid JWT whose payload says what we want it to say. Nothing
 * here verifies a signature — the page must not, and the server always does.
 */
function linkToken(payload: Record<string, unknown>): string {
  const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return [
    b64url(JSON.stringify({ alg: "HS256" })),
    b64url(JSON.stringify(payload)),
    "not-a-real-signature",
  ].join(".");
}

const TOKEN = linkToken({ sub: "u1", newEmail: NEW_EMAIL, purpose: "email-change", bv: "abc123" });

function settleWith(result: ActionResult): void {
  expect(H.settle, "the action was never called, so there is nothing to settle").not.toBeNull();
  H.settle!(result);
}

beforeEach(() => {
  H.calls.length = 0;
  H.settle = null;
  H.breakIt = null;
  H.search = new URLSearchParams(`token=${TOKEN}`);
});

describe("auth-015 — the confirm link needs a human", () => {
  it("does not call the action just because the page rendered", async () => {
    render(<VerifyEmailChangePage />);

    // Let every effect and microtask a mount can schedule run, so this is
    // "after the page has settled" and not "before the effect got its turn".
    await new Promise((r) => setTimeout(r, 25));

    expect(
      H.calls,
      "Rendering /verify-email-change applied the email change. A mail scanner that " +
        "fetches the link completes the change on the customer's behalf."
    ).toEqual([]);

    // …and there is something for the human to press instead.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /confirm/i })).toBeInTheDocument();
    });
  });

  it("shows the address that is about to become the login, before anything happens", async () => {
    render(<VerifyEmailChangePage />);

    await waitFor(() => {
      expect(screen.getByText(NEW_EMAIL)).toBeInTheDocument();
    });
    expect(H.calls).toEqual([]);
  });

  it("applies the change when the button is pressed, and passes the token", async () => {
    const user = userEvent.setup();
    render(<VerifyEmailChangePage />);

    await user.click(await screen.findByRole("button", { name: /confirm/i }));

    expect(H.calls).toEqual([{ token: TOKEN }]);
  });

  it("shows the success panel once the change lands", async () => {
    const user = userEvent.setup();
    render(<VerifyEmailChangePage />);

    await user.click(await screen.findByRole("button", { name: /confirm/i }));
    settleWith({ success: true, data: { email: NEW_EMAIL } });

    expect(await screen.findByRole("heading", { name: /email changed/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /dashboard/i })).toBeInTheDocument();
  });

  it("keeps the failure on screen instead of announcing it once", async () => {
    const user = userEvent.setup();
    render(<VerifyEmailChangePage />);

    await user.click(await screen.findByRole("button", { name: /confirm/i }));
    settleWith({
      success: false,
      error: "This confirmation link has expired. Request the change again.",
    });

    const panel = await screen.findByText(/this confirmation link has expired/i);
    expect(panel).toBeInTheDocument();
    // Still there after the queue drains — a toast would have gone by now.
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByText(/this confirmation link has expired/i)).toBeInTheDocument();
    // And the way back is offered, not just the bad news.
    expect(screen.getByRole("link", { name: /settings/i })).toBeInTheDocument();
  });

  it("offers no second submit, and ignores one that is forced", async () => {
    const user = userEvent.setup();
    render(<VerifyEmailChangePage />);

    const button = await screen.findByRole("button", { name: /confirm/i });
    await user.click(button);

    // The card the click produced has no button on it at all…
    expect(screen.queryByRole("button", { name: /confirm/i })).toBeNull();
    // …and a click event forced onto the original node changes nothing either.
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(
      H.calls,
      "A second submit redeems the token again. The first use bumps sessionVersion, " +
        "so the second is refused — and the customer's success turns into an error."
    ).toHaveLength(1);
  });

  /**
   * This branch did not exist before the fix, so it has no red-first history of
   * its own — it is here because a spinner that spins forever is how the OLD
   * page handled a dropped request (the mount effect had no catch at all), and a
   * fix that moves that failure to a dead button would be no better.
   */
  it("hands the button back when the request never landed", async () => {
    const user = userEvent.setup();
    render(<VerifyEmailChangePage />);

    await user.click(await screen.findByRole("button", { name: /confirm/i }));
    await act(async () => {
      H.breakIt!(new Error("Failed to fetch"));
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't reach founderflow/i);
    // Still retryable, and the retry really does reach the server again.
    await user.click(screen.getByRole("button", { name: /confirm/i }));
    expect(H.calls).toHaveLength(2);
  });

  it("never calls the action at all when the link carries no token", async () => {
    H.search = new URLSearchParams();
    render(<VerifyEmailChangePage />);

    expect(await screen.findByRole("heading", { name: /isn't valid/i })).toBeInTheDocument();
    expect(H.calls).toEqual([]);
    expect(screen.queryByRole("button", { name: /confirm/i })).toBeNull();
  });

  it("still renders the skip-link target while it waits for the click (a11y-008)", async () => {
    render(<VerifyEmailChangePage />);
    await screen.findByRole("button", { name: /confirm/i });

    const main = document.getElementById("main");
    expect(main).not.toBeNull();
    expect(main?.tagName.toLowerCase()).toBe("main");
    expect(main).toHaveAttribute("tabindex", "-1");
  });

  it("carries no toast import — the error panel is the error surface", () => {
    const src = readFileSync(join(process.cwd(), "app", "verify-email-change", "page.tsx"), "utf8");
    expect(src).not.toContain("react-hot-toast");
  });
});
