"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowRight, MailCheck } from "lucide-react";
import { BrandMark } from "@/components/brand-mark";
import toast from "react-hot-toast";
import { requestPasswordResetAction } from "@/lib/actions/password-reset";
import {
  RequestPasswordResetSchema,
  type RequestPasswordResetInput,
} from "@/lib/schemas/password-reset";
import { SectionLabel } from "@/components/landing/section-label";
import { display } from "@/components/landing/fonts";
import { MarketingThemeToggle } from "@/components/landing/marketing-theme-toggle";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/use-t";
import { useHydrated } from "@/lib/hooks/use-hydrated";

/**
 * prodready-005, the UI half.
 *
 * Copy is inline rather than in `lib/i18n/strings.ts` ONLY because `Strings =
 * typeof en` makes every new key a required Urdu translation too, and that file
 * belongs to another slice of this wave. The keys are specified in this agent's
 * hand-off; moving these four strings there is a mechanical follow-up and
 * changes no behaviour.
 */
const COPY = {
  requested: (email: string) =>
    `We've requested a reset link for ${email}. If an account matches that address, the email usually arrives within a couple of minutes, and the link expires 15 minutes after it is sent.`,
  notArrivedTitle: "Nothing after a few minutes?",
  notArrivedBody:
    "Check your spam folder first. Email delivery can fail, and this page cannot confirm whether the message left our server — so if a second attempt doesn't arrive either, ask a workspace admin to reset your password for you.",
  resend: "Send it again",
  resending: "Sending…",
  resent: "Requested again.",
  differentEmail: "Use a different email address",
};

export default function ForgotPasswordPage() {
  const t = useT();
  /**
   * FaultsAudit A14. Full argument: lib/hooks/use-hydrated.ts.
   *
   * This form carries no password, so what leaks is quieter — but it leaks
   * more easily. Exactly one field here blocks implicit submission, so a
   * native submit needed no click at all: pressing Enter in the email box was
   * enough, and with no `method` that wrote `GET /forgot-password?email=…`
   * into the access log, browser history and the `Referer` of whatever loaded
   * next. (Login is the one auth form Enter could NOT fire, because two fields
   * block implicit submission there; reset and invite share this one's
   * exposure.)
   *
   * An address is not a secret, but a log line saying this address asked to
   * reset a password is exactly what the rest of this flow works hard not to
   * emit — see the enumeration posture in lib/actions/password-reset.ts.
   */
  const hydrated = useHydrated();
  const emailId = useId();
  const [submitted, setSubmitted] = useState(false);
  /** The address the confirmation is about, so "send it again" needs no retype. */
  const [sentTo, setSentTo] = useState("");
  /**
   * A refusal the customer can still read a minute later.
   *
   * This endpoint is enumeration-safe, so a rate-limit refusal (auth-007) is
   * the ONLY thing it can actually tell someone — and it was being told in a
   * toast that clears itself after a few seconds, to a person who cannot sign
   * in and may well be on a phone. The toast stays as well; this is the copy
   * that survives.
   */
  const [formError, setFormError] = useState<string | null>(null);
  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<RequestPasswordResetInput>({
    resolver: zodResolver(RequestPasswordResetSchema),
    mode: "onSubmit",
    reValidateMode: "onChange",
    defaultValues: { email: "" },
  });

  async function onSubmit(data: RequestPasswordResetInput) {
    setFormError(null);
    const result = await requestPasswordResetAction(data);
    if (!result.success) {
      setFormError(result.error);
      toast.error(result.error);
      return;
    }
    /**
     * `result.data` is deliberately NOT read here, and nothing below branches on
     * it — there is nothing in it to read.
     *
     * The action used to return `dispatched`, and this comment used to explain
     * why the page ignored it: `false` meant three different things (never
     * registered, tombstoned, send failed) and on a healthy deployment only the
     * first two are common, so rendering anything differently on it would tell an
     * attacker whether an address has an account. What the careful reading here
     * could not fix is that the flag was still IN the POST response body, which
     * is read with curl and not with eyes. auth-010 removed it from the contract
     * (`ActionResult<void>`), so all three outcomes now serialise identically.
     *
     * This page therefore needs no change and keeps no branch — and
     * tests/components/forgot-password-outcome.test.tsx pins the rendering as
     * identical even when it is handed a payload carrying a delivery flag, so
     * re-introducing one cannot quietly reopen the oracle here.
     *
     * The real outcome a locked-out customer needs is surfaced without any of
     * it: the panel stops asserting that an email was sent, and gives them a
     * retry and an escalation instead. Naming a transport failure out loud needs
     * a signal that does not depend on the address existing — see this slice's
     * hand-off for the `deliveryBlocked` follow-up.
     */
    setSentTo(data.email);
    setResent(false);
    setSubmitted(true);
  }

  /** Ask again for the same address. Goes through the same limiter, which is
   *  keyed on the submitted address precisely so this is uniform. */
  async function resend() {
    if (!sentTo || resending) return;
    setResending(true);
    setFormError(null);
    const result = await requestPasswordResetAction({ email: sentTo });
    setResending(false);
    if (!result.success) {
      setFormError(result.error);
      return;
    }
    setResent(true);
  }

  function useDifferentEmail() {
    setSubmitted(false);
    setSentTo("");
    setResent(false);
    setFormError(null);
  }

  return (
    <div
      data-marketing
      data-theme="light"
      className={cn(
        display.variable,
        "relative flex min-h-screen items-center justify-center bg-bg px-6 py-16"
      )}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top_left,rgb(var(--primary)/0.10),transparent_60%)]"
      />

      <div className="absolute end-6 top-6">
        <MarketingThemeToggle size="sm" />
      </div>

      {/* <main> rather than <div> (a11y-008): the root layout renders "Skip to
          main content" here too, and its `#main` target only ever existed in the
          authenticated shell. `tabIndex={-1}` makes the fragment jump focus it. */}
      <main id="main" tabIndex={-1} className="w-full max-w-md">
        <Link href="/" className="mb-10 inline-flex items-center gap-2.5">
          <BrandMark className="h-9 w-9" />
          <span className="text-base font-bold tracking-tight">FounderFlow</span>
        </Link>

        {submitted ? (
          /* role="status" + aria-live: the panel replaces the form in place, so
             a screen-reader user otherwise gets no indication anything
             happened. Nothing inside it varies with the outcome of the request —
             see onSubmit, and tests/components/forgot-password-outcome.test.tsx,
             which pins the renderings as byte-identical. */
          <div
            role="status"
            aria-live="polite"
            className="rounded-2xl border border-border bg-surface p-8 text-center"
          >
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/15 text-primary-strong">
              <MailCheck className="h-6 w-6" aria-hidden="true" />
            </div>
            <h1 className="text-2xl font-bold tracking-tight">{t.auth.resetLinkSentTitle}</h1>
            <p className="mt-3 text-sm text-fg-muted">{COPY.requested(sentTo)}</p>

            <div className="mt-6 rounded-xl border border-border bg-bg p-4 text-start">
              <p className="text-xs font-bold text-fg">{COPY.notArrivedTitle}</p>
              <p className="mt-1.5 text-xs leading-relaxed text-fg-muted">{COPY.notArrivedBody}</p>
            </div>

            {formError && (
              <p role="alert" className="mt-4 text-xs font-medium text-danger">
                {formError}
              </p>
            )}
            {resent && !formError && (
              <p className="mt-4 text-xs font-medium text-fg-muted">{COPY.resent}</p>
            )}

            <div className="mt-6 flex flex-col gap-2">
              <button
                type="button"
                onClick={resend}
                disabled={resending}
                className="inline-flex w-full items-center justify-center rounded-xl border border-border px-5 py-2.5 text-sm font-semibold text-fg transition-colors hover:border-primary/40 hover:text-primary-strong disabled:opacity-60"
              >
                {resending ? COPY.resending : COPY.resend}
              </button>
              <button
                type="button"
                onClick={useDifferentEmail}
                className="inline-flex w-full items-center justify-center rounded-xl px-5 py-2.5 text-sm font-medium text-fg-muted transition-colors hover:text-fg"
              >
                {COPY.differentEmail}
              </button>
            </div>

            <Link
              href="/login"
              className="mt-6 inline-flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-bold text-primary-fg transition-transform hover:scale-[1.02] active:scale-[0.98]"
            >
              {t.auth.backToSignIn}
              <ArrowRight className="h-4 w-4 rtl:rotate-180" aria-hidden="true" />
            </Link>
          </div>
        ) : (
          <>
            <SectionLabel>{t.auth.forgotPassword}</SectionLabel>
            <h1 className="mt-5 text-4xl font-bold tracking-tight md:text-5xl">
              {t.auth.forgotPasswordTitle}
            </h1>
            <p className="mt-3 text-sm text-fg-muted">{t.auth.forgotPasswordTagline}</p>

            {/* method="post" is load-bearing — see lib/hooks/use-hydrated.ts. */}
            <form
              method="post"
              onSubmit={handleSubmit(onSubmit)}
              className="mt-10 space-y-5"
              noValidate
            >
              <div>
                <label htmlFor={emailId} className="mb-2 block text-sm font-medium text-fg">
                  {t.auth.email}
                </label>
                <input
                  id={emailId}
                  type="email"
                  inputMode="email"
                  placeholder={t.auth.emailPlaceholder}
                  autoComplete="email"
                  // eslint-disable-next-line jsx-a11y/no-autofocus -- single-input landing from an email link; Tab-order would land here anyway
                  autoFocus
                  aria-invalid={errors.email ? true : undefined}
                  aria-describedby={errors.email ? `${emailId}-err` : undefined}
                  {...register("email")}
                  className={cn(
                    "w-full rounded-2xl border bg-surface px-4 py-3 text-sm text-fg transition-colors placeholder:text-fg-muted focus:bg-surface focus:outline-none",
                    errors.email
                      ? "border-danger/60 focus:border-danger"
                      : "border-border focus:border-primary/60"
                  )}
                />
                {errors.email && (
                  <p id={`${emailId}-err`} className="mt-1.5 text-xs text-danger">
                    {errors.email.message}
                  </p>
                )}
              </div>

              {formError && (
                <p role="alert" className="text-xs font-medium text-danger">
                  {formError}
                </p>
              )}

              {/* Disabling the default button also closes the Enter-key path:
                  implicit submission fires a click at it, and a disabled button
                  swallows that click. Styling stays normal until hydrated — see
                  the button in app/login/page.tsx. */}
              <button
                type="submit"
                disabled={!hydrated || isSubmitting}
                className={cn(
                  "group inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-5 py-3.5 text-sm font-bold text-primary-fg shadow-[0_6px_24px_rgb(var(--primary)_/_0.26)] transition-all hover:scale-[1.01] hover:shadow-[0_8px_30px_rgb(var(--primary)_/_0.34)] active:scale-[0.98]",
                  hydrated && "disabled:opacity-60 disabled:hover:scale-100"
                )}
              >
                {isSubmitting ? t.auth.sendingResetLink : t.auth.sendResetLink}
                <ArrowRight
                  className="h-4 w-4 transition-transform group-hover:translate-x-0.5 rtl:rotate-180 rtl:group-hover:-translate-x-0.5"
                  aria-hidden="true"
                />
              </button>
            </form>

            <p className="mt-8 text-center text-sm text-fg-muted">
              {t.auth.rememberPassword}{" "}
              <Link href="/login" className="font-semibold text-primary-strong hover:underline">
                {t.auth.backToSignIn}
              </Link>
            </p>
          </>
        )}
      </main>
    </div>
  );
}
