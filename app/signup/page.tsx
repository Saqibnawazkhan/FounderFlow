"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { ArrowRight, Eye, EyeOff, Sparkles } from "lucide-react";
import toast from "react-hot-toast";
import { useStore } from "@/lib/store";

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

export default function SignupPage() {
  const router = useRouter();
  const signup = useStore((s) => s.signup);

  const [step, setStep] = useState(1);
  const [form, setForm] = useState({
    name: "",
    email: "",
    password: "",
    companyName: "",
    industry: INDUSTRIES[0],
  });
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  function update<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm({ ...form, [key]: value });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (step === 1) {
      if (!form.name || !form.email || !form.password) {
        toast.error("Please fill in all fields");
        return;
      }
      if (form.password.length < 6) {
        toast.error("Password must be at least 6 characters");
        return;
      }
      setStep(2);
      return;
    }
    if (!form.companyName || !form.industry) {
      toast.error("Please fill in company details");
      return;
    }
    setLoading(true);
    const result = signup(form);
    setLoading(false);
    if (result.success) {
      toast.success("Welcome to FounderFlow!");
      router.push("/dashboard");
    } else {
      toast.error(result.error || "Sign up failed");
    }
  }

  return (
    <div className="min-h-screen flex">
      {/* Left: Visual */}
      <div className="hidden lg:flex flex-1 bg-gradient-to-br from-accent-600 via-brand-600 to-brand-500 relative overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(255,255,255,0.2),transparent_50%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_bottom_right,rgba(217,70,239,0.3),transparent_50%)]" />
        <div className="relative flex flex-col justify-center px-12 xl:px-20 text-white">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
          >
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/10 backdrop-blur-sm border border-white/20 text-sm mb-6">
              <Sparkles className="h-3.5 w-3.5" />
              Free for early-stage teams
            </div>
            <h2 className="text-4xl xl:text-5xl font-bold leading-tight">
              Get your founders on<br />the same page in 60s.
            </h2>
            <p className="mt-6 text-lg text-white/80 max-w-md">
              Set up your company, invite your co-founders, and start tracking
              every dollar and task — together.
            </p>

            <div className="mt-12 grid grid-cols-2 gap-4 max-w-md">
              {[
                { label: "Startups served", value: "2,500+" },
                { label: "PKR tracked", value: "1.2B+" },
                { label: "Tasks completed", value: "50K+" },
                { label: "Co-founder duos", value: "5K+" },
              ].map((s) => (
                <div key={s.label} className="p-4 rounded-xl bg-white/10 backdrop-blur-sm border border-white/20">
                  <p className="text-2xl font-bold">{s.value}</p>
                  <p className="text-sm text-white/70 mt-1">{s.label}</p>
                </div>
              ))}
            </div>
          </motion.div>
        </div>
      </div>

      {/* Right: Form */}
      <div className="flex-1 flex flex-col justify-center px-6 sm:px-12 lg:px-20 py-12">
        <div className="w-full max-w-md mx-auto">
          <Link href="/" className="flex items-center gap-2 mb-12">
            <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-brand-500 to-accent-500 flex items-center justify-center shadow-glow">
              <Sparkles className="h-5 w-5 text-white" />
            </div>
            <span className="text-xl font-bold gradient-text">FounderFlow</span>
          </Link>

          <motion.div
            key={step}
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.3 }}
          >
            <div className="flex items-center gap-2 mb-4">
              <div className="flex-1 h-1 rounded-full bg-brand-500" />
              <div className={`flex-1 h-1 rounded-full ${step === 2 ? "bg-brand-500" : "bg-slate-200 dark:bg-slate-800"}`} />
            </div>

            <h1 className="text-3xl font-bold tracking-tight">
              {step === 1 ? "Create your account" : "Setup your company"}
            </h1>
            <p className="text-slate-600 dark:text-slate-400 mt-2">
              {step === 1 ? "Start with your personal details." : "Tell us about your startup."}
            </p>

            <form onSubmit={handleSubmit} className="mt-8 space-y-5">
              {step === 1 ? (
                <>
                  <div>
                    <label className="label">Full name</label>
                    <input
                      value={form.name}
                      onChange={(e) => update("name", e.target.value)}
                      className="input"
                      placeholder="Saqib Nawaz"
                      autoComplete="name"
                    />
                  </div>
                  <div>
                    <label className="label">Work email</label>
                    <input
                      type="email"
                      value={form.email}
                      onChange={(e) => update("email", e.target.value)}
                      className="input"
                      placeholder="you@startup.com"
                      autoComplete="email"
                    />
                  </div>
                  <div>
                    <label className="label">Password</label>
                    <div className="relative">
                      <input
                        type={showPassword ? "text" : "password"}
                        value={form.password}
                        onChange={(e) => update("password", e.target.value)}
                        className="input pr-12"
                        placeholder="At least 6 characters"
                        autoComplete="new-password"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
                      >
                        {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <label className="label">Company name</label>
                    <input
                      value={form.companyName}
                      onChange={(e) => update("companyName", e.target.value)}
                      className="input"
                      placeholder="Nimbus Labs"
                    />
                  </div>
                  <div>
                    <label className="label">Industry</label>
                    <select
                      value={form.industry}
                      onChange={(e) => update("industry", e.target.value)}
                      className="input"
                    >
                      {INDUSTRIES.map((i) => (
                        <option key={i} value={i}>
                          {i}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="p-3 rounded-xl bg-brand-50 dark:bg-brand-500/10 border border-brand-200 dark:border-brand-500/20 text-sm text-brand-700 dark:text-brand-300">
                    <strong>You'll be the Admin Founder.</strong> You can invite
                    co-founders and team members from the dashboard.
                  </div>
                </>
              )}

              <div className="flex gap-3">
                {step === 2 && (
                  <button
                    type="button"
                    onClick={() => setStep(1)}
                    className="btn-secondary flex-1 py-3"
                  >
                    Back
                  </button>
                )}
                <button type="submit" disabled={loading} className="btn-primary flex-1 py-3">
                  {loading ? "Creating..." : step === 1 ? "Continue" : "Create account"}
                  <ArrowRight className="h-4 w-4" />
                </button>
              </div>
            </form>

            <p className="mt-6 text-sm text-center text-slate-600 dark:text-slate-400">
              Already have an account?{" "}
              <Link href="/login" className="text-brand-600 dark:text-brand-400 font-medium hover:underline">
                Sign in
              </Link>
            </p>
          </motion.div>
        </div>
      </div>
    </div>
  );
}
