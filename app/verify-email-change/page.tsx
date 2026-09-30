"use client";

import { Suspense, useCallback, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowRight, CheckCircle2, Loader2, MailCheck, ShieldAlert } from "lucide-react";
import { BrandMark } from "@/components/brand-mark";
import { confirmEmailChangeAction } from "@/lib/actions/email-change";
import { ThemeToggle } from "@/components/landing/theme-toggle";
import { useT } from "@/lib/i18n/use-t";

/**
 * /verify-email-change?token=… — landing page for the email-change
 * confirmation link. The token is self-authenticating, so no session is needed
 * and the link may be opened on a different device. Mirrors the /verify-email
 * shell.
 *
 * THE CHANGE IS APPLIED ON A CLICK, NOT ON RENDER (audit auth-015). This page
 * used to fire `confirmEmailChangeAction` from a mount effect, so rendering the
 * URL *was* the action. Corporate mail gateways — Outlook Safe Links, Proofpoint
 * URL Defense and friends — fetch and sometimes render linked pages before a
 * human ever opens the message, which meant the customer's login address could
 * move without them clicking anything. That address is the account's recovery
 * anchor: /forgot-password delivers to whatever the row holds.
 *
 * So the page now shows the proposed address and a button. The token still
 * proves control of the destination inbox; the button proves a human. Nothing
 * on this page issues a request until the click handler runs.
 *
 * /verify-email is deliberately NOT changed to match, and it is a different
 * case rather than an oversight: confirming an address only records that the
 * mailbox received our token, which stays true when a scanner in that mailbox's
 * own delivery path follows the link. It grants no capability and takes nothing
 * away, so an extra click there would cost every new signup a step to defend
 * against nothing. (It is also outside this change's ownership — see
 * app/verify-email/page.tsx.)
 */
export default function VerifyEmailChangePage() {
  return (
    <Suspense>
      <Inner />
    </Suspense>
  );
}

type State =
  /** Waiting for the human. `problem` is set only after a failed attempt that is worth retrying. */
  | { kind: "confirm"; problem?: string }
  | { kind: "applying" }
  | { kind: "success" }
  | { kind: "error"; message: string };

/**
 * Shown when the POST itself never reached us. English, like every other
 * message on this card: `state.message` is the server action's own error string
 * and those are not translated either, so this reads the same as its
 * neighbours rather than being the one localised sentence in an English panel.
 * Recoverable, so it lands on the confirm card next to a live button instead of
 * in the terminal error panel.
 */
const TRANSPORT_PROBLEM =
  "Couldn't reach FounderFlow to confirm the change. Check your connection and try again.";

/**
 * The address this link proposes, read out of the token's own payload, FOR
 * DISPLAY ONLY.
 *
 * Read the two halves of that sentence together, because the first one alone
 * would be a lie. A JWT payload is base64url, not encryption — anyone holding
 * this link can already read it, so printing it here discloses nothing that the
 * reader does not have in their address bar. And NOTHING IS VERIFIED HERE: the
 * signature is checked on the server by `confirmEmailChangeAction`, which is the
 * only code that can apply anything. A forged or edited token can therefore
 * change what this card DISPLAYS and nothing else — pressing the button on one
 * returns "This confirmation link is invalid."
 *
 * That is also why the value is shape-checked to a plain ASCII address and
 * otherwise dropped: the card should render without an address rather than
 * render arbitrary text that someone else chose. (React escapes it either way,
 * so it is text, never markup.)
 *
 * Returns null on anything unexpected; the caller then omits the line.
 */
function proposedEmailFromToken(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const payload: unknown = JSON.parse(atob(padded));
    if (typeof payload !== "object" || payload === null) return null;
    const value = (payload as { newEmail?: unknown }).newEmail;
    if (typeof value !== "string" || value.length > 254) return null;
    // Printable ASCII only: `atob` decodes bytes, not UTF-8, so an
    // internationalised address would arrive as mojibake and is better omitted
    // than shown wrong.
    if (/[^\x20-\x7e]/.test(value)) return null;
    // One @, a dot in the domain, and no whitespace, angle bracket or double
    // quote anywhere — the shape of an address, and nothing that reads as markup
    // if it ever reaches a sink less careful than JSX.
    //
    // `\x22` is the double quote, spelled that way on purpose: the structural
    // sweeps in tests/ (reachability, action-auth-gates, use-server-exports)
    // read this repo with a character-state scanner that treats a `"` inside a
    // regex literal as the start of a string, which silently blanks the rest of
    // the file — including the call to `confirmEmailChangeAction` below, which
    // reachability then reports as an action with no caller. Verified: with a
    // literal quote here, tests/lib/actions/reachability.test.ts fails.
    if (!/^[^\s<>\x22@]+@[^\s<>\x22@]+\.[^\s<>\x22@]+$/.test(value)) return null;
    return value;
  } catch {
    return null;
  }
}

function Inner() {
  const t = useT();
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [state, setState] = useState<State>({ kind: "confirm" });
  /** One redemption per page load: the first use of the token revokes it. */
  const submittingRef = useRef(false);

  const proposedEmail = useMemo(() => (token ? proposedEmailFromToken(token) : null), [token]);

  const onConfirm = useCallback(async () => {
    if (!token || submittingRef.current) return;
    submittingRef.current = true;
    setState({ kind: "applying" });
    try {
      const res = await confirmEmailChangeAction({ token });
      if (res.success) setState({ kind: "success" });
      else setState({ kind: "error", message: res.error });
    } catch {
      // The request never landed, so the token is almost certainly unspent:
      // hand the button back rather than declaring the link dead.
      submittingRef.current = false;
      setState({ kind: "confirm", problem: TRANSPORT_PROBLEM });
    }
  }, [token]);

  // A link with no token can never be confirmed, so it is the invalid panel
  // from the first paint — and it is derived rather than stored so it follows a
  // locale change, as the other panels do.
  const view: State = token ? state : { kind: "error", message: t.settings.changeEmailInvalidBody };

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-bg px-6 py-16">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top_left,rgb(var(--primary)/0.10),transparent_60%)]"
      />
      <div className="absolute end-6 top-6">
        <ThemeToggle size="sm" />
      </div>
      {/* <main> rather than <div> (a11y-008) — see app/forgot-password/page.tsx. */}
      <main id="main" tabIndex={-1} className="w-full max-w-md">
        <Link href="/" className="mb-10 inline-flex items-center gap-2.5">
          <BrandMark className="h-9 w-9" />
          <span className="text-base font-bold tracking-tight">FounderFlow</span>
        </Link>

        {view.kind === "confirm" && (
          <div className="rounded-2xl border border-glass/[0.10] bg-glass/[0.05] p-8 text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/15 text-primary-strong">
              <MailCheck className="h-6 w-6" aria-hidden="true" />
            </div>
            <h1 className="text-2xl font-bold tracking-tight">{t.settings.changeEmail}</h1>
            {proposedEmail !== null && (
              <>
                <p className="mt-5 text-xs font-semibold uppercase tracking-[0.18em] text-fg-muted">
                  {t.settings.newEmail}
                </p>
                <p className="mt-1 break-all text-sm font-semibold">{proposedEmail}</p>
              </>
            )}
            {view.problem !== undefined && (
              <p role="alert" className="mt-5 text-sm text-danger">
                {view.problem}
              </p>
            )}
            <button
              type="button"
              onClick={onConfirm}
              className="mt-8 inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-primary-fg transition-transform hover:scale-[1.02] active:scale-95"
            >
              {t.common.confirm}
              <ArrowRight className="h-4 w-4 rtl:rotate-180" aria-hidden="true" />
            </button>
          </div>
        )}

        {view.kind === "applying" && (
          <div className="rounded-2xl border border-glass/[0.10] bg-glass/[0.05] p-8 text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/15 text-primary-strong">
              <Loader2 className="h-6 w-6 animate-spin" aria-hidden="true" />
            </div>
            <h1 className="text-2xl font-bold tracking-tight">
              {t.settings.changeEmailConfirming}
            </h1>
          </div>
        )}

        {view.kind === "success" && (
          <div className="rounded-2xl border border-glass/[0.10] bg-glass/[0.05] p-8 text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/15 text-primary-strong">
              <CheckCircle2 className="h-6 w-6" aria-hidden="true" />
            </div>
            <h1 className="text-2xl font-bold tracking-tight">{t.settings.changeEmailDoneTitle}</h1>
            <p className="mt-3 text-sm text-fg-muted">{t.settings.changeEmailDoneBody}</p>
            <Link
              href="/dashboard"
              className="mt-8 inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-primary-fg transition-transform hover:scale-[1.02] active:scale-95"
            >
              {t.auth.verifiedCta}
              <ArrowRight className="h-4 w-4 rtl:rotate-180" aria-hidden="true" />
            </Link>
          </div>
        )}

        {/* The failure surface is this panel and nothing else — it stays on
            screen until the reader acts on it. This page imports no toast, on
            purpose: a message that disappears after four seconds is not how a
            customer learns their login address did not move. */}
        {view.kind === "error" && (
          <div className="rounded-2xl border border-danger/30 bg-danger/[0.06] p-8 text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-danger/15 text-danger">
              <ShieldAlert className="h-6 w-6" aria-hidden="true" />
            </div>
            <h1 className="text-2xl font-bold tracking-tight">
              {t.settings.changeEmailInvalidTitle}
            </h1>
            <p className="mt-3 text-sm text-fg-muted">{view.message}</p>
            <Link
              href="/settings"
              className="mt-8 inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-primary-fg transition-transform hover:scale-[1.02] active:scale-95"
            >
              {t.nav.settings}
              <ArrowRight className="h-4 w-4 rtl:rotate-180" aria-hidden="true" />
            </Link>
          </div>
        )}
      </main>
    </div>
  );
}
