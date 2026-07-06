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
import { LoginSchema, type LoginInput } from "@/lib/schemas/auth";
import { PillBadge } from "@/components/landing/pill-badge";
import { StatCard } from "@/components/landing/stat-card";
import { MetricRing } from "@/components/landing/metric-ring";
import { ThemeToggle } from "@/components/landing/theme-toggle";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/use-t";

export default function LoginPage() {
  const router = useRouter();
  const loginDemo = useStore((s) => s.loginDemo);
  const t = useT();

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
        // Full nav so the server middleware re-reads the new session cookie.
        window.location.href = "/dashboard";
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
    <div className="min-h-screen bg-bg text-fg lg:grid lg:grid-cols-[1fr_1.05fr]">
      {/* Left: form */}
      <div className="relative flex flex-col justify-center px-6 py-12 sm:px-10 lg:px-16">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_top_left,rgb(var(--primary)/0.10),transparent_60%)]"
        />

        {/* Floating theme toggle — top-right of the form pane */}
        <div className="absolute right-6 top-6 sm:right-10 lg:right-12">
          <ThemeToggle size="sm" />
        </div>

        <Link href="/" className="mb-12 inline-flex w-fit items-center gap-2.5">
          <BrandMark className="h-9 w-9" />
          <span className="text-base font-bold tracking-tight">FounderFlow</span>
        </Link>

        <div className="w-full max-w-sm">
          <PillBadge>{t.auth.welcomeBack}</PillBadge>

          <h1 className="mt-5 text-4xl font-bold tracking-tight md:text-5xl">
            {t.auth.signInHeadingPre}
            <span className="text-primary-strong">{t.auth.signInHeadingEm}</span>
            {t.auth.signInHeadingPost}
          </h1>

          <p className="mt-3 text-sm text-fg-muted">{t.auth.signInTagline}</p>

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
                maxLength={254}
                placeholder={t.auth.emailPlaceholder}
                autoComplete="email"
                // eslint-disable-next-line jsx-a11y/no-autofocus -- landing on a dedicated /login page; first-field autofocus is expected
                autoFocus
                aria-invalid={errors.email ? true : undefined}
                aria-describedby={errors.email ? `${emailId}-err` : undefined}
                {...register("email")}
                className={cn(
                  "w-full rounded-xl border bg-glass/[0.05] px-4 py-3 text-sm text-fg transition-colors placeholder:text-fg-muted focus:bg-glass/[0.08] focus:outline-none",
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

            <div>
              <label
                htmlFor={pwId}
                className="mb-2 block font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
              >
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
              <div className="mt-2 text-right">
                <Link
                  href="/forgot-password"
                  className="text-xs font-medium text-fg-muted transition-colors hover:text-primary-strong"
                >
                  {t.auth.forgotPassword}
                </Link>
              </div>
            </div>

            <button
              type="submit"
              disabled={isSubmitting}
              className="group inline-flex w-full items-center justify-center gap-2 rounded-full bg-primary px-5 py-3.5 text-sm font-bold text-primary-fg shadow-[0_0_30px_rgb(182_244_37_/_0.25)] transition-all hover:scale-[1.01] hover:shadow-[0_0_45px_rgb(182_244_37_/_0.4)] active:scale-95 disabled:opacity-60 disabled:hover:scale-100"
            >
              {isSubmitting ? t.auth.signInLoading : t.auth.signIn}
              <ArrowRight
                className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
                aria-hidden="true"
              />
            </button>
          </form>

          <div className="my-6 flex items-center gap-3">
            <div className="h-px flex-1 bg-glass/[0.05]" />
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-fg-muted">
              {t.auth.or}
            </span>
            <div className="h-px flex-1 bg-glass/[0.05]" />
          </div>

          <button
            onClick={handleDemo}
            className="inline-flex w-full items-center justify-center gap-2 rounded-full border border-glass/[0.10] bg-glass/[0.05] px-5 py-3.5 text-sm font-medium text-fg backdrop-blur-sm transition-colors hover:bg-glass/[0.10]"
          >
            <Zap className="h-4 w-4 text-cyan-strong" aria-hidden="true" />
            {t.auth.tryDemo}
          </button>

          <p className="mt-8 text-center text-sm text-fg-muted">
            {t.auth.newHere}{" "}
            <Link href="/signup" className="font-semibold text-primary-strong hover:underline">
              {t.auth.createWorkspace}
            </Link>
          </p>
        </div>
      </div>

      {/* Right: showcase panel — Stitch hero mini */}
      <aside className="relative hidden overflow-hidden border-l border-glass/[0.06] bg-bg/40 lg:flex lg:flex-col lg:justify-center lg:px-16 xl:px-24">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-gradient-mesh opacity-40"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-40 right-0 h-96 w-96 rounded-full bg-primary/20 blur-3xl"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-40 left-0 h-96 w-96 rounded-full bg-cyan/20 blur-3xl"
        />

        <div className="relative max-w-md">
          <PillBadge tone="cyan">{t.auth.loginShowcaseBadge}</PillBadge>
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
            <StatCard value="84%" label={t.auth.runwayLabel} tone="cyan">
              <MetricRing value={0.84} tone="cyan" label="84" className="ml-auto h-14 w-14" />
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
