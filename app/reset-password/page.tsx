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
import { SectionLabel } from "@/components/landing/section-label";
import { display } from "@/components/landing/fonts";
import { MarketingThemeToggle } from "@/components/landing/marketing-theme-toggle";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/use-t";
import { useHydrated } from "@/lib/hooks/use-hydrated";

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
  /**
   * FaultsAudit A14. Full argument: lib/hooks/use-hydrated.ts.
   *
   * The worst shape of the bug lives here. A native pre-hydration submit
   * defaults to GET, and this form's fields are a hidden reset token and a new
   * password — so the resulting URL carries a live credential AND the
   * single-use token that mints it, together, into the access log, browser
   * history and the next `Referer`. The password field is also the only field
   * that blocks implicit submission, so Enter alone was enough to fire it.
   *
   * Whether the form is in the server HTML at all depends on how Next renders
   * this route: `useSearchParams` bails the Suspense boundary to the client
   * when the page is prerendered, but a dynamic render emits the form. The
   * gate does not depend on knowing which — it is correct either way.
   */
  const hydrated = useHydrated();
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

      {/* <main> rather than <div> (a11y-008) — see app/forgot-password/page.tsx. */}
      <main id="main" tabIndex={-1} className="w-full max-w-md">
        <Link href="/" className="mb-10 inline-flex items-center gap-2.5">
          <BrandMark className="h-9 w-9" />
          <span className="text-base font-bold tracking-tight">FounderFlow</span>
        </Link>

        {!token ? (
          <MissingTokenNotice t={t} />
        ) : succeeded ? (
          <div className="rounded-2xl border border-border bg-surface p-8 text-center">
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
            <SectionLabel>{t.auth.forgotPassword}</SectionLabel>
            <h1 className="mt-5 text-4xl font-bold tracking-tight md:text-5xl">
              {t.auth.resetPasswordTitle}
            </h1>
            <p className="mt-3 text-sm text-fg-muted">{t.auth.resetPasswordTagline}</p>

            {/* method="post" is load-bearing — see lib/hooks/use-hydrated.ts.
                A GET here would put the reset token and the new password in
                the same URL. */}
            <form
              method="post"
              onSubmit={handleSubmit(onSubmit)}
              className="mt-10 space-y-5"
              noValidate
            >
              <input type="hidden" {...register("token")} />

              <div>
                <label htmlFor={pwId} className="mb-2 block text-sm font-medium text-fg">
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
                      "w-full rounded-2xl border bg-surface px-4 py-3 pe-12 text-sm text-fg transition-colors placeholder:text-fg-muted focus:bg-surface focus:outline-none",
                      errors.password
                        ? "border-danger/60 focus:border-danger"
                        : "border-border focus:border-primary/60"
                    )}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    aria-label={showPassword ? t.auth.hidePassword : t.auth.showPassword}
                    className="absolute end-3 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-lg text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
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

              {/* Inert until hydrated — closes both the click and the Enter-key
                  path. Styling stays normal in that window; see the button in
                  app/login/page.tsx. */}
              <button
                type="submit"
                disabled={!hydrated || isSubmitting}
                className={cn(
                  "group inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-5 py-3.5 text-sm font-bold text-primary-fg shadow-[0_6px_24px_rgb(var(--primary)_/_0.26)] transition-all hover:scale-[1.01] hover:shadow-[0_8px_30px_rgb(var(--primary)_/_0.34)] active:scale-[0.98]",
                  hydrated && "disabled:opacity-60 disabled:hover:scale-100"
                )}
              >
                {isSubmitting ? t.auth.settingNewPassword : t.auth.setNewPassword}
                <ArrowRight
                  className="h-4 w-4 transition-transform group-hover:translate-x-0.5 rtl:rotate-180 rtl:group-hover:-translate-x-0.5"
                  aria-hidden="true"
                />
              </button>
            </form>
          </>
        )}
      </main>
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
        className="mt-8 inline-flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-bold text-primary-fg transition-transform hover:scale-[1.02] active:scale-[0.98]"
      >
        {t.auth.forgotPassword}
        <ArrowRight className="h-4 w-4 rtl:rotate-180" aria-hidden="true" />
      </Link>
    </div>
  );
}
