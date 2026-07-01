"use client";

import { forwardRef, useId, useState } from "react";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowRight, ChevronDown, Eye, EyeOff, Sparkles, CheckCircle2 } from "lucide-react";
import toast from "react-hot-toast";
import { signupAction } from "@/lib/actions/auth";
import { SignupSchema, type SignupInput } from "@/lib/schemas/auth";
import { PillBadge } from "@/components/landing/pill-badge";
import { StatCard } from "@/components/landing/stat-card";
import { ThemeToggle } from "@/components/landing/theme-toggle";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/use-t";

const INDUSTRIES = [
  "SaaS / B2B Software",
  "E-commerce",
  "FinTech",
  "EdTech",
  "HealthTech",
  "AI / Machine Learning",
  "Marketplace",
  "Consulting / Services",
  "Hardware",
  "Other",
];

// Field names that live on step 1 — used by RHF.trigger() to gate the
// "Continue" button without touching the company fields.
const STEP_1_FIELDS = ["name", "email", "password"] as const;

export default function SignupPage() {
  const t = useT();
  const nameId = useId();
  const emailId = useId();
  const pwId = useId();
  const companyId = useId();
  const industryId = useId();

  const [step, setStep] = useState<1 | 2>(1);
  const [showPassword, setShowPassword] = useState(false);

  const {
    register,
    handleSubmit,
    trigger,
    formState: { errors, isSubmitting },
  } = useForm<SignupInput>({
    resolver: zodResolver(SignupSchema),
    mode: "onSubmit",
    reValidateMode: "onChange",
    defaultValues: {
      name: "",
      email: "",
      password: "",
      companyName: "",
      industry: INDUSTRIES[0],
    },
  });

  async function handleContinue() {
    // Validate just the step-1 subset. If clean, advance.
    const ok = await trigger([...STEP_1_FIELDS]);
    if (ok) setStep(2);
  }

  async function onSubmit(data: SignupInput) {
    try {
      const result = await signupAction(data);
      if (result.success) {
        toast.success(t.auth.welcomeToFFToast);
        // Full nav so middleware reads the new session cookie.
        window.location.href = "/dashboard";
        return;
      }
      toast.error(result.error || t.auth.signupFailedToast);
    } catch (err) {
      // Server action threw — usually means a DB / env-var problem on the
      // server. Surface it instead of leaving the user staring at "Creating…"
      console.error("signupAction threw:", err);
      toast.error(t.auth.networkErrorToast);
    }
  }

  return (
    <div className="min-h-screen bg-bg text-fg lg:grid lg:grid-cols-[1.05fr_1fr]">
      {/* Left: showcase */}
      <aside className="relative hidden overflow-hidden bg-bg/40 lg:flex lg:flex-col lg:justify-center lg:px-16 xl:px-24">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-gradient-mesh opacity-40"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-40 left-0 h-96 w-96 rounded-full bg-cyan/20 blur-3xl"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-40 right-0 h-96 w-96 rounded-full bg-primary/25 blur-3xl"
        />

        <div className="relative max-w-md">
          <PillBadge tone="cyan">{t.auth.signUpShowcaseBadge}</PillBadge>
          <h2 className="mt-6 text-balance text-4xl font-bold leading-tight tracking-tight xl:text-5xl">
            {t.auth.signUpShowcaseHeadingPre}
            <span className="text-primary-strong">{t.auth.signUpShowcaseHeadingEm}</span>
            {t.auth.signUpShowcaseHeadingPost}
          </h2>
          <p className="mt-4 text-pretty text-base leading-relaxed text-fg-muted">
            {t.auth.signUpShowcaseDesc}
          </p>

          <div className="mt-10 grid grid-cols-2 gap-3">
            <StatCard value="2,500+" label={t.auth.startupsLabel} tone="primary" />
            <StatCard value="PKR 1.2B" label={t.auth.trackedLabel} tone="cyan" />
            <StatCard value="50K+" label={t.auth.tasksDoneLabel} tone="pink" />
            <StatCard value="5K+" label={t.auth.cofounderDuosLabel} tone="primary" />
          </div>
        </div>
      </aside>

      {/* Right: form */}
      <div className="relative flex flex-col justify-center px-6 py-12 sm:px-10 lg:px-16">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_top_right,rgb(var(--primary)/0.10),transparent_60%)]"
        />

        {/* Floating theme toggle — top-right of the form pane */}
        <div className="absolute right-6 top-6 sm:right-10 lg:right-12">
          <ThemeToggle size="sm" />
        </div>

        <Link href="/" className="mb-12 inline-flex w-fit items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary">
            <Sparkles className="h-4 w-4 text-primary-fg" aria-hidden="true" />
          </div>
          <span className="text-base font-bold tracking-tight">FounderFlow</span>
        </Link>

        <div className="w-full max-w-sm">
          {/* Step indicator */}
          <div className="mb-8 flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.2em]">
            <span className={cn("text-primary-strong", step === 1 && "font-bold")}>
              {t.auth.stepYou}
            </span>
            <span className="h-px flex-1 bg-glass/[0.10]" />
            <span className={cn(step === 2 ? "font-bold text-primary-strong" : "text-fg-muted")}>
              {t.auth.stepCompany}
            </span>
          </div>

          <PillBadge tone={step === 1 ? "primary" : "cyan"}>
            {t.auth.stepBadgePre}
            {step}
            {t.auth.stepBadgePost}
          </PillBadge>

          <h1 className="mt-5 text-4xl font-bold tracking-tight md:text-5xl">
            {step === 1 ? (
              <>
                {t.auth.signUpHeading1Pre}
                <span className="text-primary-strong">{t.auth.signUpHeading1Em}</span>
                {t.auth.signUpHeading1Post}
              </>
            ) : (
              <>
                {t.auth.signUpHeading2Pre}
                <span className="text-primary-strong">{t.auth.signUpHeading2Em}</span>
                {t.auth.signUpHeading2Post}
              </>
            )}
          </h1>

          <p className="mt-3 text-sm text-fg-muted">
            {step === 1 ? t.auth.signUpStep1Note : t.auth.signUpStep2Note}
          </p>

          <form onSubmit={handleSubmit(onSubmit)} className="mt-10 space-y-5" noValidate>
            {/* Render BOTH steps so RHF's registered inputs stay in the DOM
                and keep their values when the user clicks Back/Continue. */}
            <div className={cn(step === 1 ? "space-y-5" : "hidden")}>
              <RegField
                id={nameId}
                label={t.auth.fullName}
                placeholder={t.auth.fullNamePlaceholder}
                autoComplete="name"
                maxLength={80}
                // eslint-disable-next-line jsx-a11y/no-autofocus -- landing on /signup step 1; first-field autofocus is expected
                autoFocus
                error={errors.name?.message}
                {...register("name")}
              />
              <RegField
                id={emailId}
                label={t.auth.workEmail}
                type="email"
                inputMode="email"
                maxLength={254}
                placeholder={t.auth.emailPlaceholder}
                autoComplete="email"
                error={errors.email?.message}
                {...register("email")}
              />
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
                    placeholder={t.auth.passwordPlaceholderSignup}
                    autoComplete="new-password"
                    aria-invalid={errors.password ? true : undefined}
                    aria-describedby={errors.password ? `${pwId}-err` : undefined}
                    {...register("password")}
                    className={cn(
                      "w-full rounded-xl border bg-glass/[0.05] px-4 py-3 pr-12 text-sm text-fg transition-colors placeholder:text-fg-muted/60 focus:bg-glass/[0.08] focus:outline-none",
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
            </div>

            <div className={cn(step === 2 ? "space-y-5" : "hidden")}>
              <RegField
                id={companyId}
                label={t.auth.companyName}
                placeholder={t.auth.companyNamePlaceholder}
                error={errors.companyName?.message}
                {...register("companyName")}
              />
              <div>
                <label
                  htmlFor={industryId}
                  className="mb-2 block font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
                >
                  {t.auth.industry}
                </label>
                <div className="relative">
                  <select
                    id={industryId}
                    aria-invalid={errors.industry ? true : undefined}
                    {...register("industry")}
                    className={cn(
                      "w-full cursor-pointer appearance-none rounded-xl border bg-glass/[0.05] px-4 py-3 pr-11 text-sm text-fg transition-colors focus:bg-glass/[0.08] focus:outline-none",
                      errors.industry
                        ? "border-danger/60 focus:border-danger"
                        : "border-glass/[0.10] focus:border-primary/50"
                    )}
                  >
                    {INDUSTRIES.map((i) => (
                      <option key={i} value={i} className="bg-surface text-fg">
                        {i}
                      </option>
                    ))}
                  </select>
                  <ChevronDown
                    className="pointer-events-none absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted"
                    aria-hidden="true"
                  />
                </div>
                {errors.industry && (
                  <p className="mt-1.5 text-xs text-danger">{errors.industry.message}</p>
                )}
              </div>

              <div className="flex items-start gap-3 rounded-xl border border-primary/20 bg-primary/[0.06] p-4 text-sm">
                <CheckCircle2
                  className="mt-0.5 h-4 w-4 shrink-0 text-primary-strong"
                  aria-hidden="true"
                />
                <p className="text-fg">
                  <span className="font-semibold">{t.auth.adminFounderNoteTitle}</span>
                  <span className="text-fg-muted">{t.auth.adminFounderNoteBody}</span>
                </p>
              </div>
            </div>

            <div className="flex gap-3 pt-2">
              {step === 2 && (
                <button
                  type="button"
                  onClick={() => setStep(1)}
                  className="flex-1 rounded-full border border-glass/[0.10] bg-glass/[0.05] px-5 py-3.5 text-sm font-medium text-fg transition-colors hover:bg-glass/[0.10]"
                >
                  {t.auth.back}
                </button>
              )}
              {step === 1 ? (
                <button
                  type="button"
                  onClick={handleContinue}
                  className="group inline-flex flex-1 items-center justify-center gap-2 rounded-full bg-primary px-5 py-3.5 text-sm font-bold text-primary-fg shadow-[0_0_30px_rgb(182_244_37_/_0.25)] transition-all hover:scale-[1.01] hover:shadow-[0_0_45px_rgb(182_244_37_/_0.4)] active:scale-95"
                >
                  {t.auth.continue}
                  <ArrowRight
                    className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
                    aria-hidden="true"
                  />
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="group inline-flex flex-1 items-center justify-center gap-2 rounded-full bg-primary px-5 py-3.5 text-sm font-bold text-primary-fg shadow-[0_0_30px_rgb(182_244_37_/_0.25)] transition-all hover:scale-[1.01] hover:shadow-[0_0_45px_rgb(182_244_37_/_0.4)] active:scale-95 disabled:opacity-60 disabled:hover:scale-100"
                >
                  {isSubmitting ? t.auth.creatingLoading : t.auth.createWorkspaceCta}
                  <ArrowRight
                    className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
                    aria-hidden="true"
                  />
                </button>
              )}
            </div>
          </form>

          <p className="mt-8 text-center text-sm text-fg-muted">
            {t.auth.haveAccount}{" "}
            <Link href="/login" className="font-semibold text-primary-strong hover:underline">
              {t.auth.signIn}
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}

// Forward-ref wrapper so RHF's `register()` can hook the underlying <input>.
// Spreads any extra register-injected props (name, onChange, onBlur).
type RegFieldProps = {
  id: string;
  label: string;
  error?: string;
} & React.InputHTMLAttributes<HTMLInputElement>;

const RegField = forwardRef<HTMLInputElement, RegFieldProps>(function RegField(
  { id, label, error, type = "text", ...rest },
  ref
) {
  return (
    <div>
      <label
        htmlFor={id}
        className="mb-2 block font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
      >
        {label}
      </label>
      <input
        id={id}
        type={type}
        ref={ref}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-err` : undefined}
        {...rest}
        className={cn(
          "w-full rounded-xl border bg-glass/[0.05] px-4 py-3 text-sm text-fg transition-colors placeholder:text-fg-muted/60 focus:bg-glass/[0.08] focus:outline-none",
          error
            ? "border-danger/60 focus:border-danger"
            : "border-glass/[0.10] focus:border-primary/50"
        )}
      />
      {error && (
        <p id={`${id}-err`} className="mt-1.5 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
});
