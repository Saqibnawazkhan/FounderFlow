"use client";

import { Suspense, useEffect, useId, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowRight, CheckCircle2, Eye, EyeOff, ShieldAlert } from "lucide-react";
import { BrandMark } from "@/components/brand-mark";
import toast from "react-hot-toast";
import { resetPasswordAction } from "@/lib/actions/password-reset";
import { ResetPasswordSchema, type ResetPasswordInput } from "@/lib/schemas/password-reset";
import { PillBadge } from "@/components/landing/pill-badge";
import { ThemeToggle } from "@/components/landing/theme-toggle";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/use-t";

/**
 * `useSearchParams` marks the tree as dynamic — Next won't statically render
 * the page. The Suspense boundary satisfies the build-time requirement while
 * we still get a snappy client-only render.
 */
export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetPasswordInner />
    </Suspense>
  );
}

function ResetPasswordInner() {
  const t = useT();
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const pwId = useId();
  const [showPassword, setShowPassword] = useState(false);
  const [succeeded, setSucceeded] = useState(false);

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<ResetPasswordInput>({
    resolver: zodResolver(ResetPasswordSchema),
    mode: "onSubmit",
    reValidateMode: "onChange",
    defaultValues: { token, password: "" },
  });

  // Hydrate the (hidden) token field when the query string arrives — the
  // form is mounted before useSearchParams settles in the Suspense pass.
  useEffect(() => {
    setValue("token", token);
  }, [token, setValue]);

  async function onSubmit(data: ResetPasswordInput) {
    const result = await resetPasswordAction(data);
    if (!result.success) {
      toast.error(result.error);
      return;
    }
    setSucceeded(true);
    // Small delay so the success card gets a moment before the bounce.
    setTimeout(() => router.push("/login"), 1800);
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
          <BrandMark className="h-9 w-9" />
          <span className="text-base font-bold tracking-tight">FounderFlow</span>
        </Link>

        {!token ? (
          <MissingTokenNotice t={t} />
        ) : succeeded ? (
          <div className="rounded-2xl border border-glass/[0.10] bg-glass/[0.05] p-8 text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/15 text-primary-strong">
              <CheckCircle2 className="h-6 w-6" aria-hidden="true" />
            </div>
            <h1 className="text-2xl font-bold tracking-tight">
              {t.auth.resetPasswordSuccessTitle}
            </h1>
            <p className="mt-3 text-sm text-fg-muted">{t.auth.resetPasswordSuccessBody}</p>
          </div>
        ) : (
          <>
            <PillBadge>{t.auth.forgotPassword}</PillBadge>
            <h1 className="mt-5 text-4xl font-bold tracking-tight md:text-5xl">
              {t.auth.resetPasswordTitle}
            </h1>
            <p className="mt-3 text-sm text-fg-muted">{t.auth.resetPasswordTagline}</p>

            <form onSubmit={handleSubmit(onSubmit)} className="mt-10 space-y-5" noValidate>
              <input type="hidden" {...register("token")} />

              <div>
                <label
                  htmlFor={pwId}
                  className="mb-2 block font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
                >
                  {t.auth.newPassword}
                </label>
                <div className="relative">
                  <input
                    id={pwId}
                    type={showPassword ? "text" : "password"}
                    placeholder={t.auth.newPasswordPlaceholder}
                    autoComplete="new-password"
                    // eslint-disable-next-line jsx-a11y/no-autofocus -- landing from a reset link; single interactable input, focus is the point
                    autoFocus
                    aria-invalid={errors.password ? true : undefined}
                    aria-describedby={errors.password ? `${pwId}-err` : undefined}
                    {...register("password")}
                    className={cn(
                      "w-full rounded-xl border bg-glass/[0.05] px-4 py-3 pr-12 text-sm text-fg transition-colors placeholder:text-fg-muted focus:bg-glass/[0.08] focus:outline-none",
                      errors.password
                        ? "border-danger/60 focus:border-danger"
                        : "border-glass/[0.10] focus:border-primary/50"
                    )}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    aria-label={showPassword ? t.auth.hidePassword : t.auth.showPassword}
                    className="absolute right-3 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-lg text-fg-muted transition-colors hover:bg-glass/[0.05] hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                  >
                    {showPassword ? (
                      <EyeOff className="h-4 w-4" aria-hidden="true" />
                    ) : (
                      <Eye className="h-4 w-4" aria-hidden="true" />
                    )}
                  </button>
                </div>
                {errors.password && (
                  <p id={`${pwId}-err`} className="mt-1.5 text-xs text-danger">
                    {errors.password.message}
                  </p>
                )}
              </div>

              <button
                type="submit"
                disabled={isSubmitting}
                className="group inline-flex w-full items-center justify-center gap-2 rounded-full bg-primary px-5 py-3.5 text-sm font-bold text-primary-fg shadow-[0_0_30px_rgb(182_244_37_/_0.25)] transition-all hover:scale-[1.01] hover:shadow-[0_0_45px_rgb(182_244_37_/_0.4)] active:scale-95 disabled:opacity-60 disabled:hover:scale-100"
              >
                {isSubmitting ? t.auth.settingNewPassword : t.auth.setNewPassword}
                <ArrowRight
                  className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
                  aria-hidden="true"
                />
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

function MissingTokenNotice({ t }: { t: ReturnType<typeof useT> }) {
  return (
    <div className="rounded-2xl border border-danger/30 bg-danger/[0.06] p-8 text-center">
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-danger/15 text-danger">
        <ShieldAlert className="h-6 w-6" aria-hidden="true" />
      </div>
      <h1 className="text-2xl font-bold tracking-tight">{t.auth.resetLinkInvalidTitle}</h1>
      <p className="mt-3 text-sm text-fg-muted">{t.auth.resetLinkInvalidBody}</p>
      <Link
        href="/forgot-password"
        className="mt-8 inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-primary-fg transition-transform hover:scale-[1.02] active:scale-95"
      >
        {t.auth.forgotPassword}
        <ArrowRight className="h-4 w-4" aria-hidden="true" />
      </Link>
    </div>
  );
}
