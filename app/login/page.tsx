"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Eye, EyeOff, Sparkles, Zap, CheckCircle2 } from "lucide-react";
import toast from "react-hot-toast";
import { useStore } from "@/lib/store";
import { PillBadge } from "@/components/landing/pill-badge";
import { StatCard } from "@/components/landing/stat-card";
import { MetricRing } from "@/components/landing/metric-ring";
import { ThemeToggle } from "@/components/landing/theme-toggle";

export default function LoginPage() {
  const router = useRouter();
  const login = useStore((s) => s.login);
  const loginDemo = useStore((s) => s.loginDemo);

  const emailId = useId();
  const pwId = useId();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email || !password) {
      toast.error("Please fill in all fields");
      return;
    }
    setLoading(true);
    const result = login(email, password);
    setLoading(false);
    if (result.success) {
      toast.success("Welcome back");
      router.push("/dashboard");
    } else {
      toast.error(result.error || "Login failed");
    }
  }

  function handleDemo() {
    loginDemo();
    toast.success("Loaded demo workspace");
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
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary">
            <Sparkles className="h-4 w-4 text-primary-fg" aria-hidden="true" />
          </div>
          <span className="text-base font-bold tracking-tight">FounderFlow</span>
        </Link>

        <div className="w-full max-w-sm">
          <PillBadge>Welcome back</PillBadge>

          <h1 className="mt-5 text-4xl font-bold tracking-tight md:text-5xl">
            Sign in to your <span className="text-primary-strong">workspace</span>.
          </h1>

          <p className="mt-3 text-sm text-fg-muted">Pick up where your co-founder left off.</p>

          <form onSubmit={handleSubmit} className="mt-10 space-y-5" noValidate>
            <div>
              <label
                htmlFor={emailId}
                className="mb-2 block font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
              >
                Email
              </label>
              <input
                id={emailId}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@startup.com"
                autoComplete="email"
                className="w-full rounded-xl border border-glass/[0.10] bg-glass/[0.05] px-4 py-3 text-sm text-fg transition-colors placeholder:text-fg-muted/60 focus:border-primary/50 focus:bg-glass/[0.08] focus:outline-none"
              />
            </div>

            <div>
              <label
                htmlFor={pwId}
                className="mb-2 block font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
              >
                Password
              </label>
              <div className="relative">
                <input
                  id={pwId}
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your password"
                  autoComplete="current-password"
                  className="w-full rounded-xl border border-glass/[0.10] bg-glass/[0.05] px-4 py-3 pr-12 text-sm text-fg transition-colors placeholder:text-fg-muted/60 focus:border-primary/50 focus:bg-glass/[0.08] focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  className="absolute right-3 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-lg text-fg-muted transition-colors hover:bg-glass/[0.05] hover:text-fg"
                >
                  {showPassword ? (
                    <EyeOff className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <Eye className="h-4 w-4" aria-hidden="true" />
                  )}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="group inline-flex w-full items-center justify-center gap-2 rounded-full bg-primary px-5 py-3.5 text-sm font-bold text-primary-fg shadow-[0_0_30px_rgb(182_244_37_/_0.25)] transition-all hover:scale-[1.01] hover:shadow-[0_0_45px_rgb(182_244_37_/_0.4)] active:scale-95 disabled:opacity-60 disabled:hover:scale-100"
            >
              {loading ? "Signing in…" : "Sign in"}
              <ArrowRight
                className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
                aria-hidden="true"
              />
            </button>
          </form>

          <div className="my-6 flex items-center gap-3">
            <div className="h-px flex-1 bg-glass/[0.05]" />
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-fg-muted">
              or
            </span>
            <div className="h-px flex-1 bg-glass/[0.05]" />
          </div>

          <button
            onClick={handleDemo}
            className="inline-flex w-full items-center justify-center gap-2 rounded-full border border-glass/[0.10] bg-glass/[0.05] px-5 py-3.5 text-sm font-medium text-fg backdrop-blur-sm transition-colors hover:bg-glass/[0.10]"
          >
            <Zap className="h-4 w-4 text-cyan-strong" aria-hidden="true" />
            Try the live demo
          </button>

          <p className="mt-8 text-center text-sm text-fg-muted">
            New here?{" "}
            <Link href="/signup" className="font-semibold text-primary-strong hover:underline">
              Create a workspace
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
          <PillBadge tone="cyan">Live workspace</PillBadge>
          <h2 className="mt-6 text-balance text-4xl font-bold leading-tight tracking-tight xl:text-5xl">
            One shared source of <span className="text-primary-strong">truth</span>.
          </h2>
          <p className="mt-4 text-pretty text-base leading-relaxed text-fg-muted">
            Every PKR, every task, every founder contribution — synced in real time across your
            team.
          </p>

          <div className="mt-10 grid grid-cols-2 gap-3">
            <StatCard value="PKR 1.5M" label="Tracked" tone="primary" />
            <StatCard value="84%" label="Runway" tone="cyan">
              <MetricRing value={0.84} tone="cyan" label="84" className="ml-auto h-14 w-14" />
            </StatCard>
          </div>

          <div className="mt-6 space-y-2.5">
            {[
              "Real-time expense & investment tracking",
              "Role-based access for your whole team",
              "Investor-ready PDF + Excel exports",
            ].map((f) => (
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
