"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowRight, MailCheck, Sparkles } from "lucide-react";
import toast from "react-hot-toast";
import { requestPasswordResetAction } from "@/lib/actions/password-reset";
import {
  RequestPasswordResetSchema,
  type RequestPasswordResetInput,
} from "@/lib/schemas/password-reset";
import { PillBadge } from "@/components/landing/pill-badge";
import { ThemeToggle } from "@/components/landing/theme-toggle";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/use-t";

export default function ForgotPasswordPage() {
  const t = useT();
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
    <div className="relative flex min-h-screen items-center justify-center bg-bg px-6 py-16">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top_left,rgb(var(--primary)/0.10),transparent_60%)]"
      />

      <div className="absolute right-6 top-6">
        <ThemeToggle size="sm" />
      </div>

      <div className="w-full max-w-md">
        <Link href="/" className="mb-10 inline-flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary">
            <Sparkles className="h-4 w-4 text-primary-fg" aria-hidden="true" />
          </div>
          <span className="text-base font-bold tracking-tight">FounderFlow</span>
        </Link>

        {submitted ? (
          <div className="rounded-2xl border border-glass/[0.10] bg-glass/[0.05] p-8 text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/15 text-primary-strong">
              <MailCheck className="h-6 w-6" aria-hidden="true" />
            </div>
            <h1 className="text-2xl font-bold tracking-tight">{t.auth.resetLinkSentTitle}</h1>
            <p className="mt-3 text-sm text-fg-muted">{t.auth.resetLinkSentBody}</p>
            <Link
              href="/login"
              className="mt-8 inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-primary-fg transition-transform hover:scale-[1.02] active:scale-95"
            >
              {t.auth.backToSignIn}
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          </div>
        ) : (
          <>
            <PillBadge>{t.auth.forgotPassword}</PillBadge>
            <h1 className="mt-5 text-4xl font-bold tracking-tight md:text-5xl">
              {t.auth.forgotPasswordTitle}
            </h1>
            <p className="mt-3 text-sm text-fg-muted">{t.auth.forgotPasswordTagline}</p>

            <form onSubmit={handleSubmit(onSubmit)} className="mt-10 space-y-5" noValidate>
              <div>
                <label
                  htmlFor={emailId}
                  className="mb-2 block font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
                >
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
                    "w-full rounded-xl border bg-glass/[0.05] px-4 py-3 text-sm text-fg transition-colors placeholder:text-fg-muted/60 focus:bg-glass/[0.08] focus:outline-none",
                    errors.email
                      ? "border-danger/60 focus:border-danger"
                      : "border-glass/[0.10] focus:border-primary/50"
                  )}
                />
                {errors.email && (
                  <p id={`${emailId}-err`} className="mt-1.5 text-xs text-danger">
                    {errors.email.message}
                  </p>
                )}
              </div>

              <button
                type="submit"
                disabled={isSubmitting}
                className="group inline-flex w-full items-center justify-center gap-2 rounded-full bg-primary px-5 py-3.5 text-sm font-bold text-primary-fg shadow-[0_0_30px_rgb(182_244_37_/_0.25)] transition-all hover:scale-[1.01] hover:shadow-[0_0_45px_rgb(182_244_37_/_0.4)] active:scale-95 disabled:opacity-60 disabled:hover:scale-100"
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
