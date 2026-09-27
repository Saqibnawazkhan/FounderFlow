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
    const result = await requestPasswordResetAction(data);
    if (!result.success) {
      toast.error(result.error);
      return;
    }
    // Regardless of whether the email existed, we show the same success state
    // — the server action deliberately doesn't leak that signal, and neither
    // do we. See lib/actions/password-reset.ts for the enumeration posture.
    setSubmitted(true);
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

      <div className="absolute right-6 top-6">
        <MarketingThemeToggle size="sm" />
      </div>

      <div className="w-full max-w-md">
        <Link href="/" className="mb-10 inline-flex items-center gap-2.5">
          <BrandMark className="h-9 w-9" />
          <span className="text-base font-bold tracking-tight">FounderFlow</span>
        </Link>

        {submitted ? (
          <div className="rounded-2xl border border-border bg-surface p-8 text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/15 text-primary-strong">
              <MailCheck className="h-6 w-6" aria-hidden="true" />
            </div>
            <h1 className="text-2xl font-bold tracking-tight">{t.auth.resetLinkSentTitle}</h1>
            <p className="mt-3 text-sm text-fg-muted">{t.auth.resetLinkSentBody}</p>
            <Link
              href="/login"
              className="mt-8 inline-flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-bold text-primary-fg transition-transform hover:scale-[1.02] active:scale-[0.98]"
            >
              {t.auth.backToSignIn}
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
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
                  className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
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
      </div>
    </div>
  );
}
