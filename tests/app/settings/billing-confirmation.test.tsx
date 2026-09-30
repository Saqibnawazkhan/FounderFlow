/**
 * bill-021 — the ten seconds after a customer pays.
 *
 * The old behaviour: `/settings?billing=success` fired one `router.refresh()` in
 * the same tick as a toast reading "Payment received — your plan will update in
 * a moment", with `[]` deps and an eslint-disable, and never looked again. The
 * webhook that writes the plan is a separate delivery on LemonSqueezy's
 * schedule, so the screen sat on "Solo (Free)" with an Upgrade button under a
 * toast claiming the payment had landed — and a webhook that never arrives
 * (bill-008) was indistinguishable from one that is merely slow.
 *
 * THE ASSERTIONS ARE ABOUT THE THREE THINGS A PAYING CUSTOMER EXPERIENCES:
 *
 *   1. the screen keeps asking until the plan flips — more than once, which is
 *      the entire bug;
 *   2. it stops asking the moment it flips, and stops asking at all after a
 *      bounded window (an unbounded poll on a page people leave open is a
 *      different bug, not a fix);
 *   3. when it never flips, it says so, tells them NOT to pay twice, and gives
 *      them a human — rather than leaving them looking at an Upgrade button.
 *
 * WHY THIS RENDERS RATHER THAN READING THE SOURCE. A source-text assertion
 * ("does this file contain setInterval?") passes on a poll that is written and
 * never started, which is this repo's most-repeated defect. So the load-bearing
 * number here is `router.refresh.mock.calls.length` under fake timers.
 *
 * THE GUARD-THE-GUARD CASE: the last test proves the timers are really driving
 * things by showing that ZERO refreshes happen without the return parameter. If
 * that case ever passes for the wrong reason — a stubbed interval, say — it
 * stops distinguishing anything and the count assertions above it are hollow.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";

const H = vi.hoisted(() => ({
  refresh: vi.fn(),
  toastSuccess: vi.fn(),
  toastPlain: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: H.refresh, push: vi.fn() }),
  usePathname: () => "/settings",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("react-hot-toast", () => ({
  default: Object.assign((...a: unknown[]) => H.toastPlain(...a), {
    success: (...a: unknown[]) => H.toastSuccess(...a),
    error: vi.fn(),
  }),
}));

import {
  BillingConfirmation,
  CONFIRM_POLL_INTERVAL_MS,
  MAX_CONFIRM_POLLS,
  BILLING_SUPPORT_EMAIL,
} from "@/app/(app)/settings/billing-confirmation";

/** Put the browser where LemonSqueezy's redirect puts it. */
function arriveFromCheckout(param: "success" | "cancelled" | null): void {
  const search = param ? `?billing=${param}` : "";
  window.history.replaceState({}, "", `/settings${search}`);
}

/** Advance the clock by n poll intervals, flushing React work each time. */
async function tick(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await act(async () => {
      vi.advanceTimersByTime(CONFIRM_POLL_INTERVAL_MS);
    });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  H.refresh.mockClear();
  H.toastSuccess.mockClear();
  H.toastPlain.mockClear();
  arriveFromCheckout(null);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("bill-021 — the plan on screen catches up after a payment", () => {
  it("keeps asking the server, not once", async () => {
    arriveFromCheckout("success");
    render(<BillingConfirmation plan="free" />);
    expect(H.toastSuccess).toHaveBeenCalled();

    await tick(4);
    // The whole finding in one number: the old code could only ever reach 1.
    expect(H.refresh.mock.calls.length).toBeGreaterThan(1);
    expect(H.refresh.mock.calls.length).toBe(4);
  });

  it("tells the customer it is still confirming, instead of showing them Free", async () => {
    arriveFromCheckout("success");
    render(<BillingConfirmation plan="free" />);
    await tick(1);
    expect(screen.getByRole("status").textContent).toMatch(/confirming/i);
  });

  it("stops the moment the server says Team, and confirms it", async () => {
    arriveFromCheckout("success");
    const view = render(<BillingConfirmation plan="free" />);
    await tick(3);
    const before = H.refresh.mock.calls.length;

    // The webhook landed; the next refresh brings a new RSC prop.
    await act(async () => {
      view.rerender(<BillingConfirmation plan="team" />);
    });
    await tick(5);
    expect(H.refresh.mock.calls.length).toBe(before);
    expect(H.toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/Team plan/i));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("gives up after a bounded window rather than polling a page left open", async () => {
    arriveFromCheckout("success");
    render(<BillingConfirmation plan="free" />);
    await tick(MAX_CONFIRM_POLLS + 1);
    const atTimeout = H.refresh.mock.calls.length;
    expect(atTimeout).toBeLessThanOrEqual(MAX_CONFIRM_POLLS);

    await tick(50);
    expect(H.refresh.mock.calls.length).toBe(atTimeout);
  });

  it("says so honestly when it never confirms, and says do not pay again", async () => {
    arriveFromCheckout("success");
    render(<BillingConfirmation plan="free" />);
    await tick(MAX_CONFIRM_POLLS + 1);

    const notice = screen.getByRole("status").textContent ?? "";
    expect(notice).toMatch(/still confirming/i);
    // The sentence that stops the duplicate charge the finding predicts.
    expect(notice).toMatch(/pay again/i);
    expect(screen.getByRole("link").getAttribute("href")).toContain(BILLING_SUPPORT_EMAIL);
    expect(screen.getByRole("button", { name: /check again/i })).toBeTruthy();
  });

  it("resumes polling when the customer clicks Check again", async () => {
    arriveFromCheckout("success");
    render(<BillingConfirmation plan="free" />);
    await tick(MAX_CONFIRM_POLLS + 1);
    const atTimeout = H.refresh.mock.calls.length;

    const button = screen.getByRole("button", { name: /check again/i });
    await act(async () => {
      button.click();
    });
    await tick(2);
    expect(H.refresh.mock.calls.length).toBeGreaterThan(atTimeout);
  });

  it("says nothing about a plan when the customer cancelled the checkout", async () => {
    arriveFromCheckout("cancelled");
    render(<BillingConfirmation plan="free" />);
    await tick(5);
    expect(H.toastPlain).toHaveBeenCalledWith(expect.stringMatching(/cancelled/i));
    expect(H.refresh).not.toHaveBeenCalled();
  });

  it("clears the return parameter so a reload does not re-announce the payment", async () => {
    arriveFromCheckout("success");
    render(<BillingConfirmation plan="free" />);
    expect(window.location.search).toBe("");
  });

  it("does nothing at all on an ordinary visit to Settings — the guard-the-guard", async () => {
    arriveFromCheckout(null);
    render(<BillingConfirmation plan="free" />);
    await tick(MAX_CONFIRM_POLLS + 5);
    expect(H.refresh).not.toHaveBeenCalled();
    expect(H.toastSuccess).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("bill-021 — the support pointer names an address the product really uses", () => {
  it("matches the contact address on the landing page", () => {
    // A support pointer on the one screen where money has just moved must not
    // name an inbox nobody reads. The landing page is the only other place in
    // the product that publishes a human address; if that one is changed, this
    // test fails and the two are re-reconciled deliberately.
    const landing = readFileSync(path.join(process.cwd(), "app", "page.tsx"), "utf8");
    expect(landing).toContain(`mailto:${BILLING_SUPPORT_EMAIL}`);
  });
});

describe("bill-021 — the settings page actually renders the confirmation", () => {
  it("wires BillingConfirmation into the billing card", () => {
    // The reachability half. A component that polls correctly and is never
    // rendered closes nothing — this repo has shipped that six times. Asserted
    // against the source because rendering all of settings-client.tsx to learn
    // one fact costs more than it proves; the behaviour above is the real test.
    const src = readFileSync(
      path.join(process.cwd(), "app", "(app)", "settings", "settings-client.tsx"),
      "utf8"
    );
    expect(src).toContain("BillingConfirmation");
    expect(src).toMatch(/<BillingConfirmation\s+plan=\{billing\.plan\}\s*\/>/);
  });

  it("no longer carries the dead-end single refresh it replaced", () => {
    // The old effect and its copy in one assertion. "your plan will update in a
    // moment" was a promise nothing kept; leaving it beside a working poll would
    // give the next reader two mechanisms and no way to tell which one runs.
    const src = readFileSync(
      path.join(process.cwd(), "app", "(app)", "settings", "settings-client.tsx"),
      "utf8"
    );
    expect(src).not.toContain("your plan will update in a moment");
    expect(src).not.toContain("billing=success");
  });
});
