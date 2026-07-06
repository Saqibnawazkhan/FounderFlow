"use client";

/**
 * "Confirm your email" banner. Rendered once in the authenticated app shell.
 *
 * Why a live fetch instead of a JWT claim: verification status changes the
 * instant the user clicks their link, but a JWT claim would stay stale until
 * the next sign-in. Reading the DB value on mount means the banner vanishes
 * as soon as they come back from verifying, without a re-login. The (app)
 * layout persists across navigation, so this mounts once per session, not
 * once per page.
 *
 * Dismissal is per-session (sessionStorage): an X hides it for the current
 * tab session, but it returns next session until the email is actually
 * verified — a soft nudge, not a nag on every page load.
 */

import { useEffect, useState } from "react";
import { MailWarning, X } from "lucide-react";
import toast from "react-hot-toast";
import {
  getEmailVerificationStatusAction,
  resendVerificationEmailAction,
} from "@/lib/actions/email-verification";
import { useT } from "@/lib/i18n/use-t";

const DISMISS_KEY = "ff.verifyEmail.dismissed";

export function VerifyEmailBanner() {
  const t = useT();
  const [show, setShow] = useState(false);
  const [email, setEmail] = useState("");
  const [resending, setResending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Respect a prior dismissal for this tab session before we even ask.
    try {
      if (sessionStorage.getItem(DISMISS_KEY) === "1") return;
    } catch {
      /* private-mode Safari — fall through and just show it */
    }
    getEmailVerificationStatusAction().then((res) => {
      if (cancelled) return;
      if (res.success && !res.data.verified) {
        setEmail(res.data.email);
        setShow(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleResend() {
    setResending(true);
    const res = await resendVerificationEmailAction();
    setResending(false);
    if (!res.success) {
      toast.error(res.error);
      return;
    }
    if (res.data.alreadyVerified) {
      // Verified in another tab since the banner loaded — just retire it.
      setShow(false);
      toast.success(t.auth.verifyAlreadyDone);
      return;
    }
    toast.success(t.auth.verifyResendToast);
  }

  function dismiss() {
    try {
      sessionStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* ignore */
    }
    setShow(false);
  }

  if (!show) return null;

  return (
    <div
      role="status"
      className="flex flex-col gap-3 border-b border-warning/30 bg-warning/[0.08] px-4 py-3 sm:flex-row sm:items-center sm:justify-between md:px-6 lg:px-8"
    >
      <div className="flex items-start gap-3">
        <MailWarning className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
        <p className="text-sm text-fg">
          <span className="font-semibold">{t.auth.verifyBannerTitle}</span>{" "}
          <span className="text-fg-muted">{t.auth.verifyBannerBody.replace("{email}", email)}</span>
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2 pl-7 sm:pl-0">
        <button
          type="button"
          onClick={handleResend}
          disabled={resending}
          className="inline-flex items-center gap-1.5 rounded-full border border-warning/40 bg-warning/10 px-3 py-1.5 text-xs font-bold text-warning-strong transition-colors hover:bg-warning/20 disabled:opacity-60"
        >
          {resending ? t.auth.verifyResending : t.auth.verifyResend}
        </button>
        <button
          type="button"
          onClick={dismiss}
          aria-label={t.auth.verifyDismiss}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-fg-muted transition-colors hover:bg-glass/[0.08] hover:text-fg"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
