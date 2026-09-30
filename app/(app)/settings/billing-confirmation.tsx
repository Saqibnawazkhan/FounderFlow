"use client";

/**
 * bill-021 — what the customer sees in the ten seconds after they pay.
 *
 * LemonSqueezy's hosted checkout redirects to `/settings?billing=success`. The
 * plan column is written by the WEBHOOK, which is a separate HTTP delivery on
 * LemonSqueezy's schedule, so at the instant of that redirect the workspace is
 * still on the free plan more often than not.
 *
 * What the page used to do: one `router.refresh()`, fired in the same tick as a
 * toast reading "Payment received — your plan will update in a moment", with an
 * empty dependency array and an eslint-disable. Nothing ever looked again. So
 * the screen sat on "Solo (Free) — Up to 2 members" with an Upgrade button
 * underneath a toast claiming the payment had been received, which is the one
 * moment in this product that has to feel certain. The two failure modes were
 * also indistinguishable: a webhook that is merely slow looked exactly like a
 * webhook that never arrives at all (bill-008), so a real delivery failure was
 * invisible to the customer AND to us.
 *
 * What it does now: poll `router.refresh()` on a short interval for a bounded
 * window, stop the moment the server-rendered plan flips, and if it never flips
 * say so honestly with a route to a human. Three states, never two.
 *
 * WHY `router.refresh()` AND NOT A SERVER ACTION. The plan on this screen
 * arrives as an RSC prop (`billing` on SettingsClient, from
 * `lib/queries/billing.ts`). `router.refresh()` refetches that payload past the
 * client router cache, so the existing render path is the only path — there is
 * no second source of billing truth to keep in step with the first.
 *
 * WHY NOT `revalidatePath("/settings")` IN THE WEBHOOK, which the audit
 * suggested. `/settings` is a per-user authenticated page: it calls `auth()`, so
 * it is dynamic and nothing about it is cached across requests. There is no
 * entry for a webhook to invalidate, and adding the call would read as a
 * mechanism that does something when it does not.
 *
 * WHY IT LIVES IN ITS OWN FILE. `settings-client.tsx` is 1200 lines and pulls in
 * every settings modal; a test of this behaviour needs fake timers and a
 * re-render with a changed prop, and that is worth being able to do against a
 * module graph of four imports. See tests/app/settings/billing-confirmation.test.tsx.
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";
import { Loader2, MailQuestion } from "lucide-react";

/** How often to re-ask the server for the plan. */
export const CONFIRM_POLL_INTERVAL_MS = 2_000;

/**
 * How long to keep asking. Thirty seconds is chosen against the failure it has
 * to distinguish, not for comfort: LemonSqueezy delivers the subscription
 * webhook within a second or two of the charge on the happy path, so half a
 * minute of silence is already evidence of a problem rather than of latency.
 * Long enough to cover a cold start; short enough that the customer is told the
 * truth while they are still on the page to act on it.
 */
export const CONFIRM_TIMEOUT_MS = 30_000;

/** Bounded by a tick count, not by a wall clock — a suspended tab must not time out. */
export const MAX_CONFIRM_POLLS = Math.ceil(CONFIRM_TIMEOUT_MS / CONFIRM_POLL_INTERVAL_MS);

/**
 * Where a customer whose payment did not confirm is sent. The landing page uses
 * this same address (app/page.tsx), and the test for this file asserts that it
 * still does — a support pointer that names an unmonitored inbox is worse than
 * no pointer, and this is the screen where it would matter most.
 */
export const BILLING_SUPPORT_EMAIL = "sales@founderflow.app";

type Phase = "idle" | "confirming" | "timedOut";

/**
 * Reads the `billing` return parameter on mount and, when it says a payment
 * succeeded, waits for the plan to catch up.
 *
 * `plan` is the SERVER's answer, passed straight down from the RSC prop. That is
 * deliberate: this component holds no opinion about entitlement, so it cannot
 * disagree with the billing card it sits inside.
 */
export function BillingConfirmation({ plan }: { plan: string }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  /**
   * Bumped by "Check again" to restart the poll window. Keyed as state rather
   * than a ref because it has to re-run the effect.
   */
  const [attempt, setAttempt] = useState(0);
  /** Suppresses the "you're on Team" toast for someone who was already on Team. */
  const wasConfirming = useRef(false);

  useEffect(() => {
    const param = new URLSearchParams(window.location.search).get("billing");
    if (param !== "success" && param !== "cancelled") return;
    // Clear the parameter either way, so a reload — or the browser restoring
    // this tab tomorrow — does not re-announce a payment that is long settled.
    window.history.replaceState({}, "", "/settings");
    if (param === "cancelled") {
      toast("Checkout cancelled — no charge made.");
      return;
    }
    toast.success("Payment received — confirming with our payment provider…");
    setPhase("confirming");
    // Mount only: the return parameter is a one-shot fact about this navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (phase !== "confirming") return;

    // The server already agrees. Stop, and say so — the toast on arrival
    // promised a confirmation, so the confirmation has to actually arrive.
    if (plan === "team") {
      setPhase("idle");
      if (wasConfirming.current) toast.success("You're on the Team plan.");
      wasConfirming.current = false;
      return;
    }

    wasConfirming.current = true;
    let polls = 0;
    const id = setInterval(() => {
      polls += 1;
      if (polls > MAX_CONFIRM_POLLS) {
        clearInterval(id);
        setPhase("timedOut");
        return;
      }
      router.refresh();
    }, CONFIRM_POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [phase, plan, router, attempt]);

  if (phase === "confirming") {
    return (
      <p
        className="mt-2 flex items-center gap-2 text-xs text-fg-muted"
        role="status"
        aria-live="polite"
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        Payment received — confirming your plan with our payment provider…
      </p>
    );
  }

  if (phase === "timedOut") {
    return (
      <div
        className="mt-2 rounded-lg border border-warning/30 bg-warning/10 p-3"
        role="status"
        aria-live="polite"
      >
        <p className="flex items-start gap-2 text-xs text-warning">
          <MailQuestion className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>
            Payment received — we&apos;re still confirming it with our payment provider. Your card
            has been charged and nothing is lost; the plan here updates as soon as the confirmation
            lands. Don&apos;t pay again.
          </span>
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => {
              setPhase("confirming");
              setAttempt((n) => n + 1);
            }}
            className="rounded-md border border-warning/40 px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-warning"
          >
            Check again
          </button>
          <a
            href={`mailto:${BILLING_SUPPORT_EMAIL}?subject=Payment%20not%20confirmed`}
            className="text-[11px] font-semibold uppercase tracking-wider text-fg-muted underline"
          >
            Email {BILLING_SUPPORT_EMAIL}
          </a>
        </div>
      </div>
    );
  }

  return null;
}
