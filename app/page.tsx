"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import {
  ArrowRight,
  BarChart3,
  Bell,
  CheckCircle2,
  CreditCard,
  FileText,
  LineChart,
  Lock,
  Sparkles,
  Users,
  Zap,
} from "lucide-react";
import { useStore } from "@/lib/store";
import { useRouter } from "next/navigation";

export default function LandingPage() {
  const loginDemo = useStore((s) => s.loginDemo);
  const router = useRouter();

  function handleDemo() {
    loginDemo();
    router.push("/dashboard");
  }

  return (
    <div className="min-h-screen bg-white dark:bg-[#09090f] overflow-hidden">
      {/* Background */}
      <div className="fixed inset-0 -z-10 bg-gradient-mesh opacity-60" />
      <div className="fixed inset-0 -z-10 bg-[radial-gradient(ellipse_at_top,rgba(99,102,241,0.12),transparent_50%)]" />

      {/* Nav */}
      <nav className="relative z-10 border-b border-slate-200/60 dark:border-slate-800/60 backdrop-blur-xl bg-white/50 dark:bg-[#09090f]/50">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-brand-500 to-accent-500 flex items-center justify-center shadow-glow">
              <Sparkles className="h-5 w-5 text-white" />
            </div>
            <span className="text-xl font-bold gradient-text">FounderFlow</span>
          </Link>
          <div className="hidden md:flex items-center gap-8">
            <a href="#features" className="text-sm text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 transition">
              Features
            </a>
            <a href="#preview" className="text-sm text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 transition">
              Preview
            </a>
            <a href="#pricing" className="text-sm text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 transition">
              Pricing
            </a>
          </div>
          <div className="flex items-center gap-3">
            <Link href="/login" className="btn-ghost">
              Log in
            </Link>
            <Link href="/signup" className="btn-primary">
              Get started
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="relative max-w-7xl mx-auto px-6 pt-20 pb-24 text-center">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-brand-50 dark:bg-brand-500/10 border border-brand-200 dark:border-brand-500/20 text-sm text-brand-700 dark:text-brand-300 mb-6"
        >
          <Sparkles className="h-3.5 w-3.5" />
          Built for ambitious co-founders
        </motion.div>

        <motion.h1
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.1 }}
          className="text-5xl md:text-7xl font-bold tracking-tight text-balance"
        >
          Run your startup like<br />
          <span className="gradient-text">a single nervous system.</span>
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.2 }}
          className="mt-6 text-lg md:text-xl text-slate-600 dark:text-slate-400 max-w-2xl mx-auto text-balance"
        >
          Track investments, expenses, tasks, and every team motion in one
          beautiful workspace. The financial OS your co-founders have been
          asking for.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.3 }}
          className="mt-10 flex flex-col sm:flex-row gap-4 justify-center"
        >
          <Link href="/signup" className="btn-primary text-base px-7 py-3">
            Start free — no credit card
            <ArrowRight className="h-4 w-4" />
          </Link>
          <button onClick={handleDemo} className="btn-secondary text-base px-7 py-3">
            Try the demo workspace
          </button>
        </motion.div>

        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.6, delay: 0.4 }}
          className="mt-6 text-xs text-slate-500 dark:text-slate-500"
        >
          Demo loads instantly with sample data — no signup needed
        </motion.p>

        {/* Preview card */}
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.4 }}
          id="preview"
          className="mt-20 relative"
        >
          <div className="absolute -inset-4 bg-gradient-to-r from-brand-500/30 via-accent-500/30 to-brand-500/30 blur-3xl opacity-30" />
          <div className="relative rounded-2xl overflow-hidden border border-slate-200 dark:border-slate-800 shadow-2xl bg-white dark:bg-slate-900">
            <DashboardPreview />
          </div>
        </motion.div>
      </section>

      {/* Features */}
      <section id="features" className="relative max-w-7xl mx-auto px-6 py-24">
        <div className="text-center mb-16">
          <h2 className="text-4xl md:text-5xl font-bold tracking-tight">
            Everything a co-founder duo needs.<br />
            <span className="gradient-text">Nothing they don't.</span>
          </h2>
          <p className="mt-4 text-lg text-slate-600 dark:text-slate-400 max-w-2xl mx-auto">
            Stop juggling four spreadsheets and three apps. FounderFlow gives
            your team a shared source of truth.
          </p>
        </div>

        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
          {features.map((f, i) => (
            <motion.div
              key={f.title}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.4, delay: i * 0.05 }}
              className="group p-6 rounded-2xl bg-white dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 hover:border-brand-300 dark:hover:border-brand-700 hover:shadow-glow transition-all duration-300"
            >
              <div className="h-11 w-11 rounded-xl bg-gradient-to-br from-brand-500 to-accent-500 flex items-center justify-center text-white mb-4 group-hover:scale-110 transition-transform">
                <f.icon className="h-5 w-5" />
              </div>
              <h3 className="text-lg font-semibold mb-2">{f.title}</h3>
              <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">{f.desc}</p>
            </motion.div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section id="pricing" className="relative max-w-5xl mx-auto px-6 py-20">
        <div className="relative rounded-3xl overflow-hidden border border-slate-200 dark:border-slate-800 bg-gradient-to-br from-brand-600 via-brand-500 to-accent-500 p-12 md:p-16 text-center">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,0.2),transparent_50%)]" />
          <div className="relative">
            <h2 className="text-4xl md:text-5xl font-bold text-white tracking-tight">
              Built free for the early days.
            </h2>
            <p className="mt-4 text-lg text-white/80 max-w-2xl mx-auto">
              No seat limits. No surprise charges. Use FounderFlow as long as
              you're a small team — and beyond.
            </p>
            <div className="mt-8 flex flex-col sm:flex-row gap-4 justify-center">
              <Link
                href="/signup"
                className="inline-flex items-center justify-center gap-2 px-8 py-3 rounded-xl font-semibold bg-white text-brand-700 hover:bg-slate-50 transition-all active:scale-95 shadow-lg"
              >
                Get started free
                <ArrowRight className="h-4 w-4" />
              </Link>
              <button
                onClick={handleDemo}
                className="inline-flex items-center justify-center gap-2 px-8 py-3 rounded-xl font-semibold bg-white/10 backdrop-blur-sm text-white border border-white/20 hover:bg-white/20 transition-all active:scale-95"
              >
                Explore demo
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-slate-200 dark:border-slate-800 mt-20">
        <div className="max-w-7xl mx-auto px-6 py-8 flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-brand-500 to-accent-500 flex items-center justify-center">
              <Sparkles className="h-4 w-4 text-white" />
            </div>
            <span className="font-semibold gradient-text">FounderFlow</span>
          </div>
          <p className="text-sm text-slate-500">
            © {new Date().getFullYear()} FounderFlow. Built for founders, by founders.
          </p>
        </div>
      </footer>
    </div>
  );
}

const features = [
  {
    icon: CreditCard,
    title: "Expense & Investment Tracking",
    desc: "Every founder logs their own contributions and spend. The system tallies it all in real time — no spreadsheets, no arguments.",
  },
  {
    icon: BarChart3,
    title: "Financial Dashboard",
    desc: "See total balance, founder-wise contributions, burn rate, and category breakdowns in beautiful interactive charts.",
  },
  {
    icon: CheckCircle2,
    title: "Task Management",
    desc: "Assign work to your co-founders or team members. Set priorities, deadlines, and watch progress move across a kanban board.",
  },
  {
    icon: Bell,
    title: "Real-time Notifications",
    desc: "When someone adds a 500K investment or completes a task, everyone knows instantly. No more 'wait, who paid for that?'",
  },
  {
    icon: FileText,
    title: "Reports & Analytics",
    desc: "Monthly expense reports, founder-wise contributions, category analysis. Export to PDF or Excel for your investors.",
  },
  {
    icon: Users,
    title: "Role-based Access",
    desc: "Admin Founder, Co-Founder, and Team Member roles. Everyone sees what they need, with the right permissions.",
  },
  {
    icon: Zap,
    title: "Activity Timeline",
    desc: "A live feed of everything happening in your company. Who added what, when, and why — fully searchable.",
  },
  {
    icon: LineChart,
    title: "Beautiful by default",
    desc: "Built with the same craft you put into your product. Dark mode, smooth animations, and responsive on every screen.",
  },
  {
    icon: Lock,
    title: "Secure & private",
    desc: "Your data stays with your company. Role-based permissions ensure team members only see what they should.",
  },
];

function DashboardPreview() {
  return (
    <div className="bg-gradient-to-br from-slate-50 to-white dark:from-slate-950 dark:to-slate-900 p-6 md:p-10">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        {[
          { label: "Total Balance", value: "PKR 547,500", change: "+12.4%", color: "from-emerald-500 to-teal-500" },
          { label: "Total Investments", value: "PKR 1.5M", change: "+8.2%", color: "from-brand-500 to-accent-500" },
          { label: "Total Expenses", value: "PKR 952K", change: "+15.1%", color: "from-amber-500 to-orange-500" },
          { label: "Active Tasks", value: "12", change: "3 urgent", color: "from-pink-500 to-rose-500" },
        ].map((c) => (
          <div key={c.label} className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
            <div className={`h-1 w-12 rounded-full bg-gradient-to-r ${c.color} mb-3`} />
            <p className="text-xs text-slate-500 dark:text-slate-400">{c.label}</p>
            <p className="text-xl font-bold mt-1">{c.value}</p>
            <p className="text-xs text-emerald-600 dark:text-emerald-400 mt-1">{c.change}</p>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="md:col-span-2 p-5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 h-64 flex items-end gap-2">
          {[40, 55, 35, 70, 45, 80, 60, 90, 75, 95, 65, 88].map((h, i) => (
            <div
              key={i}
              className="flex-1 rounded-t-lg bg-gradient-to-t from-brand-500 to-accent-500 opacity-80"
              style={{ height: `${h}%` }}
            />
          ))}
        </div>
        <div className="p-5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 h-64">
          <p className="text-sm font-medium mb-4">Recent Activity</p>
          <div className="space-y-3">
            {["Saqib added 150K investment", "Ali completed roadmap task", "Ahmed logged office rent"].map((a, i) => (
              <div key={i} className="flex items-center gap-3">
                <div className="h-8 w-8 rounded-full bg-gradient-to-br from-brand-500 to-accent-500" />
                <p className="text-xs text-slate-600 dark:text-slate-400">{a}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
