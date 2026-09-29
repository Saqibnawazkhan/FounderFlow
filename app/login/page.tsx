"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowRight, Eye, EyeOff, Zap, CheckCircle2 } from "lucide-react";
import { BrandMark } from "@/components/brand-mark";
import toast from "react-hot-toast";
import { useStore } from "@/lib/store";
import { loginAction } from "@/lib/actions/auth";
import { safePostLoginPath } from "@/lib/auth/post-login-redirect";
import { LoginSchema, type LoginInput } from "@/lib/schemas/auth";
import { SectionLabel } from "@/components/landing/section-label";
import { display } from "@/components/landing/fonts";
import { StatCard } from "@/components/landing/stat-card";
import { MetricRing } from "@/components/landing/metric-ring";
import { MarketingThemeToggle } from "@/components/landing/marketing-theme-toggle";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/use-t";
import { useHydrated } from "@/lib/hooks/use-hydrated";

export default function LoginPage() {
  const router = useRouter();
  const loginDemo = useStore((s) => s.loginDemo);
  const t = useT();
  // FaultsAudit A14: holds the submit button inert until React is actually
  // here, so a click that beats hydration cannot fire a native GET with a
  // password in it. Full argument: lib/hooks/use-hydrated.ts.
  const hydrated = useHydrated();

  const emailId = useId();
  const pwId = useId();

  const [showPassword, setShowPassword] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginInput>({
    resolver: zodResolver(LoginSchema),
    mode: "onSubmit",
    reValidateMode: "onChange",
    defaultValues: { email: "", password: "" },
  });

  async function onSubmit(data: LoginInput) {
    try {
      const result = await loginAction(data);
      if (result.success) {
        toast.success(t.auth.welcomeBackToast);
        // auth-017: go back to the page the bounce came from, not always the
        // dashboard. Middleware puts the original href in `callbackUrl`
        // (next-auth/lib/index.js:177) and this line used to hard-code
        // "/dashboard", so every emailed or bookmarked deep link lost its
        // destination the moment a session expired.
        //
        // `safePostLoginPath` is doing security work, not tidying: a redirect
        // target taken from a query parameter is an open redirect unless it is
        // validated same-origin. Never navigate to the raw parameter. The whole
        // argument, and the attack forms, are in lib/auth/post-login-redirect.ts.
        //
        // WHY `window.location.search` AND NOT `useSearchParams()`. That hook
        // opts the route out of static prerendering and has to sit behind a
        // Suspense boundary (app/reset-password/page.tsx:21 spells this out) —
        // and /login is one of the prerendered routes, on the busiest path in
        // the funnel. This handler only ever runs in the browser, after
        // hydration, so reading the live location costs nothing and changes
        // nothing about how the page is built.
        //
        // The full page load is deliberate and load-bearing twice over: the Edge
        // middleware has to re-read the new session cookie, and the inline
        // pre-paint script in app/layout.tsx reads the `ff_locale` / `ff_theme`
        // cookies that `seedAppearanceCookies` just wrote — an inline <head>
        // script only runs on a fresh document, so a client-side router.push
        // would leave a first-time device on the wrong language until its next
        // hard reload.
        window.location.href = safePostLoginPath(
          new URLSearchParams(window.location.search).get("callbackUrl"),
          window.location.origin
        );
        return;
      }
      toast.error(result.error || t.auth.loginFailedToast);
    } catch (err) {
      console.error("loginAction threw:", err);
      toast.error(t.auth.networkErrorToast);
    }
  }

  function handleDemo() {
    loginDemo();
    toast.success(t.auth.demoLoadedToast);
    router.push("/dashboard");
  }

  return (
    <div
      data-marketing
      data-theme="light"
      className={cn(
        display.variable,
        "min-h-screen bg-bg text-fg lg:grid lg:grid-cols-[1fr_1.05fr]"
      )}
    >
      {/* Left: form.
          <main> rather than <div> (a11y-008): the root layout renders "Skip to
          main content" on this route and its `#main` target existed only in the
          authenticated shell, so on the busiest page in the funnel the first
          control a keyboard user meets did nothing. The form column is the main
          region — the showcase <aside> beside it is complementary by definition.
          `tabIndex={-1}` makes the fragment jump focus it instead of only
          moving the focus-navigation start point. */}
      <main
        id="main"
        tabIndex={-1}
        className="relative flex flex-col justify-center px-6 py-12 sm:px-10 lg:px-16"
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_top_left,rgb(var(--primary)/0.10),transparent_60%)]"
        />

        {/* Floating theme toggle — top-right of the form pane */}
        <div className="absolute end-6 top-6 sm:end-10 lg:end-12">
          <MarketingThemeToggle size="sm" />
        </div>

        <Link href="/" className="mb-12 inline-flex w-fit items-center gap-2.5">
          <BrandMark className="h-9 w-9" />
          <span className="text-base font-bold tracking-tight">FounderFlow</span>
        </Link>

        <div className="w-full max-w-sm">
          <SectionLabel>{t.auth.welcomeBack}</SectionLabel>

          <h1 className="mt-5 text-4xl font-bold tracking-tight md:text-5xl">
            {t.auth.signInHeadingPre}
            <span className="text-primary-strong">{t.auth.signInHeadingEm}</span>
            {t.auth.signInHeadingPost}
          </h1>

          <p className="mt-3 text-sm text-fg-muted">{t.auth.signInTagline}</p>

          {/* method="post" is load-bearing, not decoration: it is what keeps a
              pre-hydration native submit out of the query string. See
              lib/hooks/use-hydrated.ts. */}
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
                maxLength={254}
                placeholder={t.auth.emailPlaceholder}
                autoComplete="email"
                // eslint-disable-next-line jsx-a11y/no-autofocus -- landing on a dedicated /login page; first-field autofocus is expected
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

            <div>
              <label htmlFor={pwId} className="mb-2 block text-sm font-medium text-fg">
                {t.auth.password}
              </label>
              <div className="relative">
                <input
                  id={pwId}
                  type={showPassword ? "text" : "password"}
                  maxLength={256}
                  placeholder={t.auth.passwordPlaceholderLogin}
                  autoComplete="current-password"
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
              <div className="mt-2 text-end">
                <Link
                  href="/forgot-password"
                  className="text-xs font-medium text-fg-muted transition-colors hover:text-primary-strong"
                >
                  {t.auth.forgotPassword}
                </Link>
              </div>
            </div>

            {/* Inert until hydrated. `disabled` is the only lever that works
                here — an onClick guard needs the JS that has not arrived yet.
                The button keeps its normal appearance in that window: the
                `disabled:` classes apply only once hydrated, because a control
                that looks dead for the first few frames of every cold load is
                worse than one that looks alive and ignores a click nobody could
                have aimed yet. */}
            <button
              type="submit"
              disabled={!hydrated || isSubmitting}
              className={cn(
                "group inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-5 py-3.5 text-sm font-bold text-primary-fg shadow-[0_6px_24px_rgb(var(--primary)_/_0.26)] transition-all hover:scale-[1.01] hover:shadow-[0_8px_30px_rgb(var(--primary)_/_0.34)] active:scale-[0.98]",
                hydrated && "disabled:opacity-60 disabled:hover:scale-100"
              )}
            >
              {isSubmitting ? t.auth.signInLoading : t.auth.signIn}
              <ArrowRight
                className="h-4 w-4 transition-transform group-hover:translate-x-0.5 rtl:rotate-180 rtl:group-hover:-translate-x-0.5"
                aria-hidden="true"
              />
            </button>
          </form>

          <div className="my-6 flex items-center gap-3">
            <div className="h-px flex-1 bg-border" />
            <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-fg-muted">
              {t.auth.or}
            </span>
            <div className="h-px flex-1 bg-border" />
          </div>

          <button
            onClick={handleDemo}
            className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-surface px-5 py-3.5 text-sm font-medium text-fg backdrop-blur-sm transition-colors hover:bg-surface-hover"
          >
            <Zap className="h-4 w-4 text-forest-strong" aria-hidden="true" />
            {t.auth.tryDemo}
          </button>

          <p className="mt-8 text-center text-sm text-fg-muted">
            {t.auth.newHere}{" "}
            <Link href="/signup" className="font-semibold text-primary-strong hover:underline">
              {t.auth.createWorkspace}
            </Link>
          </p>
        </div>
      </main>

      {/* Right: showcase panel — Stitch hero mini */}
      <aside className="relative hidden overflow-hidden border-s border-border bg-surface lg:flex lg:flex-col lg:justify-center lg:px-16 xl:px-24">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-gradient-mesh opacity-40"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-40 end-0 h-96 w-96 rounded-full bg-primary/20 blur-3xl"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-40 start-0 h-96 w-96 rounded-full bg-forest/20 blur-3xl"
        />

        <div className="relative max-w-md">
          <SectionLabel tone="forest">{t.auth.loginShowcaseBadge}</SectionLabel>
          <h2 className="mt-6 text-balance text-4xl font-bold leading-tight tracking-tight xl:text-5xl">
            {t.auth.loginShowcaseHeadingPre}
            <span className="text-primary-strong">{t.auth.loginShowcaseHeadingEm}</span>
            {t.auth.loginShowcaseHeadingPost}
          </h2>
          <p className="mt-4 text-pretty text-base leading-relaxed text-fg-muted">
            {t.auth.loginShowcaseDesc}
          </p>

          <div className="mt-10 grid grid-cols-2 gap-3">
            <StatCard value="PKR 1.5M" label={t.auth.trackedLabel} tone="primary" />
            <StatCard value="84%" label={t.auth.runwayLabel} tone="forest">
              <MetricRing value={0.84} tone="forest" label="84" className="ms-auto h-14 w-14" />
            </StatCard>
          </div>

          <div className="mt-6 space-y-2.5">
            {[t.auth.loginFeature1, t.auth.loginFeature2, t.auth.loginFeature3].map((f) => (
              <div key={f} className="flex items-center gap-3 text-sm text-fg-muted">
                <CheckCircle2 className="h-4 w-4 shrink-0 text-primary-strong" aria-hidden="true" />
                {f}
              </div>
            ))}
          </div>
        </div>
      </aside>
    </div>
  );
}
