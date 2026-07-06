"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  Bell,
  CheckCircle2,
  CreditCard,
  FileText,
  LineChart,
  Lock,
  Quote,
  Star,
  TrendingUp,
  Users,
  Wallet,
  Zap,
} from "lucide-react";
import { BrandMark } from "@/components/brand-mark";
import { motion, useReducedMotion, type Variants } from "framer-motion";
import type { ReactNode } from "react";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

import { GlowingBorder } from "@/components/landing/glowing-border";
import { Lamp } from "@/components/landing/lamp";
import { Marquee } from "@/components/landing/marquee";
import { MetricRing } from "@/components/landing/metric-ring";
import { PillBadge } from "@/components/landing/pill-badge";
import { SplitText } from "@/components/landing/split-text";
import { StatCard } from "@/components/landing/stat-card";
import { GlassCard } from "@/components/landing/glass-card";
import { ThemeToggle } from "@/components/landing/theme-toggle";

/* ─────────────────────────────────────────────────────────────────────────── */
/* Motion primitives — one shared vocabulary reused across every section.        */
/* Scroll-reveal (fade + a short rise, fires once), stagger grids, and a spring  */
/* hover-lift for cards. Each collapses to a plain opacity fade when the visitor */
/* prefers reduced motion. Transform + opacity only — never layout properties.   */
/* ─────────────────────────────────────────────────────────────────────────── */

const EASE = [0.16, 1, 0.3, 1] as const;
const VIEWPORT = { once: true, margin: "-80px" } as const;

/** Fade + rise, or a plain fade under prefers-reduced-motion. */
function useRise(distance = 18): Variants {
  const reduce = useReducedMotion();
  return reduce
    ? { hidden: { opacity: 0 }, visible: { opacity: 1, transition: { duration: 0.4 } } }
    : {
        hidden: { opacity: 0, y: distance },
        visible: { opacity: 1, y: 0, transition: { duration: 0.6, ease: EASE } },
      };
}

/** Spring hover-lift target, or `undefined` under prefers-reduced-motion. */
function useHoverLift(y = -6) {
  const reduce = useReducedMotion();
  return reduce
    ? undefined
    : { y, transition: { type: "spring" as const, stiffness: 300, damping: 24 } };
}

/** Reveals its children as a single block once scrolled into view. */
function Reveal({
  children,
  className,
  distance,
}: {
  children: ReactNode;
  className?: string;
  distance?: number;
}) {
  const variants = useRise(distance);
  return (
    <motion.div
      className={className}
      variants={variants}
      initial="hidden"
      whileInView="visible"
      viewport={VIEWPORT}
    >
      {children}
    </motion.div>
  );
}

/** Stagger parent — plays each <StaggerItem> child in sequence as it enters view. */
function Stagger({
  children,
  className,
  stagger = 0.07,
  delay = 0.04,
}: {
  children: ReactNode;
  className?: string;
  stagger?: number;
  delay?: number;
}) {
  return (
    <motion.div
      className={className}
      variants={{ visible: { transition: { staggerChildren: stagger, delayChildren: delay } } }}
      initial="hidden"
      whileInView="visible"
      viewport={VIEWPORT}
    >
      {children}
    </motion.div>
  );
}

/** A single child of <Stagger>. Inherits the reveal state from its parent. */
function StaggerItem({
  children,
  className,
  distance,
}: {
  children: ReactNode;
  className?: string;
  distance?: number;
}) {
  const variants = useRise(distance);
  return (
    <motion.div className={className} variants={variants}>
      {children}
    </motion.div>
  );
}

export default function LandingPage() {
  const loginDemo = useStore((s) => s.loginDemo);
  const router = useRouter();

  function handleDemo() {
    loginDemo();
    router.push("/dashboard");
  }

  return (
    <div className="min-h-screen bg-bg text-fg">
      {/* Ambient background — fixed, behind everything. Opacity dampens on light. */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 -z-10 bg-gradient-mesh opacity-[var(--ambient-opacity)]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-x-0 top-0 -z-10 h-[600px] bg-[radial-gradient(ellipse_at_top,rgb(var(--primary)/0.12),transparent_60%)]"
      />

      <Nav onDemo={handleDemo} />
      <Hero onDemo={handleDemo} />
      <LogoStrip />
      <Features />
      <DashboardShowcase />
      <Testimonial />
      <Pricing onDemo={handleDemo} />
      <FAQ />
      <CTA onDemo={handleDemo} />
      <Footer />
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Nav — backdrop blur header (Stitch pattern)                                  */
/* ─────────────────────────────────────────────────────────────────────────── */

function Nav({ onDemo }: { onDemo: () => void }) {
  return (
    <header className="sticky top-0 z-sticky border-b border-glass/[0.06] bg-bg/70 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2.5">
          <BrandMark className="h-9 w-9" />
          <div className="leading-none">
            <p className="text-base font-bold tracking-tight">FounderFlow</p>
            <p className="mt-0.5 font-mono text-[9px] uppercase tracking-[0.18em] text-fg-muted">
              v1.0 · beta
            </p>
          </div>
        </Link>

        <nav aria-label="Sections" className="hidden items-center gap-1 md:flex">
          {[
            { href: "#features", label: "Features" },
            { href: "#showcase", label: "Product" },
            { href: "#pricing", label: "Pricing" },
            { href: "#faq", label: "FAQ" },
          ].map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="rounded-full px-4 py-1.5 text-sm text-fg-muted transition-colors hover:bg-glass/[0.05] hover:text-fg"
            >
              {l.label}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <button
            onClick={onDemo}
            className="hidden rounded-full px-4 py-1.5 text-sm font-medium text-fg-muted transition-colors hover:text-fg sm:inline-flex"
          >
            Live demo
          </button>
          <ThemeToggle size="sm" />
          <Link
            href="/login"
            className="hidden rounded-full px-4 py-1.5 text-sm font-medium text-fg-muted transition-colors hover:text-fg sm:inline-flex"
          >
            Log in
          </Link>
          <Link
            href="/signup"
            className="inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-1.5 text-sm font-semibold text-primary-fg transition-transform hover:scale-[1.02] active:scale-95"
          >
            Get started
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        </div>
      </div>
    </header>
  );
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Hero — Stitch 2-column with split-text headline + 2x2 metric grid           */
/* ─────────────────────────────────────────────────────────────────────────── */

function Hero({ onDemo }: { onDemo: () => void }) {
  const item = useRise(20);
  return (
    <section className="relative mx-auto max-w-7xl px-6 pb-24 pt-16 lg:pt-24">
      <div className="grid items-center gap-12 lg:grid-cols-[1.1fr_0.9fr] lg:gap-16">
        {/* Left: copy + CTAs — staggered in on first paint (headline is owned by
            SplitText's own per-word reveal, so it stays outside the stagger). */}
        <motion.div
          className="flex flex-col items-start"
          variants={{ visible: { transition: { staggerChildren: 0.09, delayChildren: 0.05 } } }}
          initial="hidden"
          animate="visible"
        >
          <motion.div variants={item}>
            <PillBadge>Built for ambitious co-founders</PillBadge>
          </motion.div>

          <h1 className="mt-6 text-balance text-5xl font-bold leading-[1.02] tracking-tight md:text-6xl lg:text-7xl">
            <SplitText text="The financial OS" delay={0} />
            <br />
            <SplitText text="every co-founder duo" delay={250} className="text-fg-muted" />
            <br />
            <SplitText text="actually agrees on." delay={600} className="text-primary-strong" />
          </h1>

          <motion.p
            variants={item}
            className="mt-6 max-w-md text-pretty text-base leading-relaxed text-fg-muted md:text-lg"
          >
            Track investments, expenses, and tasks in one shared workspace — so every co-founder
            sees the same numbers, in real time.
          </motion.p>

          <motion.div variants={item} className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Link
              href="/signup"
              className="group inline-flex items-center justify-center gap-2 rounded-full bg-primary px-7 py-3.5 text-base font-bold text-primary-fg shadow-[0_0_40px_rgb(182_244_37_/_0.25)] transition-all hover:scale-[1.02] hover:shadow-[0_0_60px_rgb(182_244_37_/_0.45)] active:scale-95"
            >
              Start free — no credit card
              <ArrowRight
                className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
                aria-hidden="true"
              />
            </Link>
            <button
              onClick={onDemo}
              className="inline-flex items-center justify-center gap-2 rounded-full border border-glass/[0.10] bg-glass/[0.05] px-7 py-3.5 text-base font-medium text-fg backdrop-blur-sm transition-all hover:border-glass/[0.20] hover:bg-glass/[0.10] active:scale-95"
            >
              Try the live demo
              <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
            </button>
          </motion.div>

          <motion.p
            variants={item}
            className="mt-5 font-mono text-[11px] uppercase tracking-[0.18em] text-fg-muted"
          >
            Demo loads instantly · sample data included · no signup
          </motion.p>
        </motion.div>

        {/* Right: 2x2 metric grid (Stitch hero pattern) — staggered as it lands.
            h-full on wrapper + card keeps the grid's equal-height rows intact. */}
        <Stagger className="grid grid-cols-2 gap-4" stagger={0.09} delay={0.15}>
          <StaggerItem className="h-full" distance={22}>
            <StatCard
              value="PKR 1.5M"
              label="Capital tracked"
              icon={Wallet}
              tone="primary"
              className="h-full"
            />
          </StaggerItem>
          <StaggerItem className="h-full" distance={22}>
            <StatCard
              value="84%"
              label="Runway intact"
              icon={TrendingUp}
              tone="cyan"
              className="h-full"
            >
              <MetricRing value={0.84} tone="cyan" label="84" className="ml-auto h-16 w-16" />
            </StatCard>
          </StaggerItem>
          <StaggerItem className="h-full" distance={22}>
            <StatCard
              value="247"
              label="Tasks shipped"
              icon={CheckCircle2}
              tone="primary"
              className="h-full"
            />
          </StaggerItem>
          <StaggerItem className="h-full" distance={22}>
            <StatCard value="3" label="Co-founders" icon={Users} tone="pink" className="h-full" />
          </StaggerItem>
        </Stagger>
      </div>
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Logo strip — Marquee of use cases / trust signals                            */
/* ─────────────────────────────────────────────────────────────────────────── */

function LogoStrip() {
  const tags = [
    "Pre-seed startups",
    "Bootstrapped duos",
    "Indie SaaS teams",
    "Family businesses",
    "Agency partnerships",
    "Open-source maintainers",
    "Local co-ops",
    "Side-project founders",
  ];

  return (
    <section className="border-y border-glass/[0.06] bg-bg/40 py-10">
      <Reveal>
        <p className="mb-6 text-center font-mono text-[10px] uppercase tracking-[0.25em] text-fg-muted">
          Built for every kind of small team
        </p>
      </Reveal>
      <Marquee speed={50}>
        {tags.map((t) => (
          <span key={t} className="inline-flex items-center gap-2 font-mono text-sm text-fg-muted">
            <span className="h-1 w-1 rounded-full bg-primary" />
            {t}
          </span>
        ))}
      </Marquee>
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Features — Stitch feature grid + 21st.dev GlowingBorder on premium cards    */
/* ─────────────────────────────────────────────────────────────────────────── */

const FEATURES = [
  {
    icon: CreditCard,
    title: "Shared finances",
    desc: "Every founder logs contributions and spend; totals update in real time.",
    stat: "100%",
    statLabel: "Agreement",
    premium: true,
  },
  {
    icon: BarChart3,
    title: "Live dashboards",
    desc: "Balance, burn rate, and founder contributions — interactive and always current.",
    stat: "0ms",
    statLabel: "Sync delay",
    premium: true,
  },
  {
    icon: CheckCircle2,
    title: "Kanban tasks",
    desc: "Assign work, set priorities and deadlines, and track it across a board.",
    stat: "3 views",
    statLabel: "Board · List · Calendar",
    premium: true,
  },
  {
    icon: Bell,
    title: "Real-time notifications",
    desc: "When something changes, the whole team knows instantly — in-app or email.",
    stat: "<1s",
    statLabel: "Delivery",
  },
  {
    icon: FileText,
    title: "Investor-ready reports",
    desc: "Monthly P&L and contribution breakdowns, exportable to PDF or Excel.",
    stat: "PDF / XLS",
    statLabel: "Formats",
  },
  {
    icon: Users,
    title: "Role-based access",
    desc: "Admin, co-founder, and member roles — everyone sees exactly what they should.",
    stat: "3 roles",
    statLabel: "Built-in",
  },
  {
    icon: Zap,
    title: "Activity timeline",
    desc: "A searchable, audited feed of who changed what, and when.",
    stat: "∞",
    statLabel: "History",
  },
  {
    icon: LineChart,
    title: "Polished on every screen",
    desc: "Dark mode, smooth motion, and a layout that holds up from phone to desktop.",
    stat: "AA",
    statLabel: "WCAG",
  },
  {
    icon: Lock,
    title: "Private by design",
    desc: "Your data stays yours — permissions enforced on every read and write.",
    stat: "256-bit",
    statLabel: "Encryption",
  },
];

function Features() {
  return (
    <section id="features" className="relative mx-auto max-w-7xl px-6 py-24">
      <Reveal className="mx-auto max-w-2xl text-center">
        <PillBadge tone="cyan">Everything in one workspace</PillBadge>
        <h2 className="mt-6 text-balance text-4xl font-bold tracking-tight md:text-5xl">
          Everything you need, <span className="text-primary-strong">nothing you don't</span>.
        </h2>
        <p className="mt-4 text-pretty text-base leading-relaxed text-fg-muted">
          One workspace for finances, tasks, and team — no spreadsheets, no context-switching.
        </p>
      </Reveal>

      <Stagger className="mt-16 grid gap-4 md:grid-cols-2 lg:grid-cols-3" stagger={0.06}>
        {FEATURES.map((f) => (
          <FeatureCard key={f.title} {...f} />
        ))}
      </Stagger>
    </section>
  );
}

function FeatureCard({
  icon: Icon,
  title,
  desc,
  stat,
  statLabel,
  premium,
}: (typeof FEATURES)[number]) {
  const variants = useRise();
  const hover = useHoverLift(-6);
  return (
    <motion.div
      variants={variants}
      whileHover={hover}
      className={cn(
        "group relative flex flex-col overflow-hidden rounded-2xl border border-glass/[0.06]",
        "bg-glass/[0.03] p-8 backdrop-blur-sm",
        "transition-colors duration-300 hover:border-primary/30"
      )}
    >
      {premium && <GlowingBorder spread={45} proximity={80} />}

      {/* Hover gradient sweep */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-gradient-to-br from-primary/[0.06] to-transparent opacity-0 transition-opacity duration-500 group-hover:opacity-100"
      />

      <div className="relative z-10">
        <div className="mb-6 inline-flex h-11 w-11 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary-strong">
          <Icon className="h-5 w-5" aria-hidden="true" />
        </div>

        <h3 className="text-xl font-bold tracking-tight text-fg">{title}</h3>
        <p className="mt-2 text-sm leading-relaxed text-fg-muted">{desc}</p>
      </div>

      <div className="relative z-10 mt-6 flex items-center justify-between border-t border-glass/[0.06] pt-5">
        <span className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted">
          {statLabel}
        </span>
        <span className="rounded-full bg-primary/10 px-3 py-1 font-mono text-xs font-bold text-primary-strong">
          {stat}
        </span>
      </div>
    </motion.div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Dashboard showcase — Lamp section + framed product preview                  */
/* ─────────────────────────────────────────────────────────────────────────── */

function DashboardShowcase() {
  return (
    <section id="showcase" className="relative">
      <Lamp>
        <Reveal className="flex flex-col items-center text-center">
          <PillBadge>The product</PillBadge>
          <h2 className="mt-6 max-w-3xl text-balance text-4xl font-bold tracking-tight md:text-5xl">
            A workspace that <span className="text-primary-strong">scales with you</span>.
          </h2>
          <p className="mt-4 max-w-xl text-pretty text-base leading-relaxed text-fg-muted">
            Runway, contributions, active tasks, and a live activity feed — one screen, no
            context-switching.
          </p>
        </Reveal>
      </Lamp>

      <div className="relative mx-auto -mt-12 max-w-6xl px-6 pb-32">
        <Reveal distance={28}>
          <GlassCard className="overflow-hidden">
            <DashboardMock />
          </GlassCard>
        </Reveal>
      </div>
    </section>
  );
}

function DashboardMock() {
  const months = [40, 55, 35, 70, 45, 80, 60, 90, 75, 95, 65, 88];
  const reduce = useReducedMotion();
  const barVariants: Variants = reduce
    ? { hidden: { scaleY: 1 }, visible: { scaleY: 1 } }
    : { hidden: { scaleY: 0 }, visible: { scaleY: 1, transition: { duration: 0.5, ease: EASE } } };
  return (
    <div className="space-y-6 p-6 md:p-8">
      {/* Top stat row */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {[
          { label: "Balance", value: "547.5K", tone: "primary" as const },
          { label: "Raised", value: "1.5M", tone: "cyan" as const },
          { label: "Burn", value: "82K/mo", tone: "pink" as const },
          { label: "Runway", value: "11 mo", tone: "primary" as const },
        ].map((s) => (
          <div key={s.label} className="rounded-xl border border-glass/[0.06] bg-glass/[0.03] p-4">
            <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-fg-muted">
              {s.label}
            </p>
            <p
              className={cn(
                "mt-2 font-mono text-2xl font-bold leading-none",
                s.tone === "cyan"
                  ? "text-cyan-strong"
                  : s.tone === "pink"
                    ? "text-pink-strong"
                    : "text-primary-strong"
              )}
            >
              {s.value}
            </p>
          </div>
        ))}
      </div>

      {/* Chart + activity */}
      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-xl border border-glass/[0.06] bg-glass/[0.03] p-5 md:col-span-2">
          <div className="mb-4 flex items-end justify-between">
            <p className="text-sm font-semibold">Cash flow · last 12 months</p>
            <span className="font-mono text-[10px] uppercase tracking-widest text-primary-strong">
              +18.4%
            </span>
          </div>
          <motion.div
            className="flex h-44 items-end gap-2"
            variants={{ visible: { transition: { staggerChildren: 0.045, delayChildren: 0.1 } } }}
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, margin: "-40px" }}
          >
            {months.map((h, i) => (
              <motion.div
                key={i}
                className="flex-1 origin-bottom rounded-t-md bg-gradient-to-t from-primary/30 to-primary"
                style={{ height: `${h}%`, opacity: 0.55 + h / 200 }}
                variants={barVariants}
              />
            ))}
          </motion.div>
        </div>

        <div className="rounded-xl border border-glass/[0.06] bg-glass/[0.03] p-5">
          <p className="mb-4 text-sm font-semibold">Live activity</p>
          <Stagger className="space-y-3" stagger={0.08} delay={0.15}>
            {[
              { who: "Saqib", what: "added 150K investment", tone: "primary" },
              { who: "Ali", what: "completed roadmap task", tone: "cyan" },
              { who: "Ahmed", what: "logged office rent", tone: "pink" },
              { who: "Saqib", what: "assigned UI work to Ali", tone: "primary" },
            ].map((a, i) => (
              <StaggerItem key={i} className="flex items-center gap-3" distance={10}>
                <div
                  className={cn(
                    "flex h-8 w-8 shrink-0 items-center justify-center rounded-full font-mono text-xs font-bold text-primary-fg",
                    a.tone === "cyan" ? "bg-cyan" : a.tone === "pink" ? "bg-pink" : "bg-primary"
                  )}
                >
                  {a.who[0]}
                </div>
                <p className="text-xs text-fg-muted">
                  <span className="font-semibold text-fg">{a.who}</span> {a.what}
                </p>
              </StaggerItem>
            ))}
          </Stagger>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Testimonial — Stitch glass card + Playfair serif quote                       */
/* ─────────────────────────────────────────────────────────────────────────── */

function Testimonial() {
  return (
    <section className="mx-auto max-w-5xl px-6 py-24">
      <Reveal distance={24}>
        <GlassCard className="p-10 md:p-16">
          <Quote
            className="absolute left-6 top-6 h-16 w-16 text-primary-strong/20"
            aria-hidden="true"
          />

          <div className="relative">
            <div className="flex gap-1">
              {[0, 1, 2, 3, 4].map((i) => (
                <Star
                  key={i}
                  className="h-4 w-4 fill-primary-strong text-primary-strong"
                  aria-hidden="true"
                />
              ))}
            </div>

            <blockquote className="mt-6 font-serif text-2xl italic leading-relaxed text-fg md:text-3xl">
              "We replaced four spreadsheets and three Trello boards. Our first week with zero
              finance arguments — that had never happened before."
            </blockquote>

            <div className="mt-8 flex items-center gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary font-mono text-lg font-bold text-primary-fg">
                S
              </div>
              <div>
                <p className="font-semibold text-fg">Sara Khan</p>
                <p className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.2em] text-primary-strong">
                  Co-founder · Nimble Studio
                </p>
              </div>
            </div>
          </div>
        </GlassCard>
      </Reveal>
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Pricing — Stitch top-bar accent + Material check icons                       */
/* ─────────────────────────────────────────────────────────────────────────── */

const TIERS = [
  {
    name: "Solo",
    price: "Free",
    sub: "forever",
    desc: "Perfect for early days, side projects, and validating the product idea.",
    features: ["1 workspace", "Up to 2 co-founders", "All core features", "Community support"],
    cta: "Start free",
    featured: false,
  },
  {
    name: "Team",
    price: "$12",
    sub: "/mo per workspace",
    desc: "When the team grows and you need investor-ready reports + integrations.",
    features: [
      "Unlimited co-founders",
      "Investor-ready reports",
      "Email + Slack notifications",
      "PDF & Excel export",
      "Priority support",
    ],
    cta: "Start free trial",
    featured: true,
  },
  {
    name: "Scale",
    price: "Custom",
    sub: "talk to us",
    desc: "For the post-PMF stage with custom workflows and dedicated onboarding.",
    features: [
      "Everything in Team",
      "SSO + audit logs",
      "Custom integrations",
      "Dedicated CSM",
      "99.9% SLA",
    ],
    cta: "Contact sales",
    featured: false,
  },
];

function Pricing({ onDemo }: { onDemo: () => void }) {
  const reduce = useReducedMotion();
  return (
    <section id="pricing" className="mx-auto max-w-6xl px-6 py-24">
      <Reveal className="mx-auto max-w-2xl text-center">
        <PillBadge tone="cyan">Pricing</PillBadge>
        <h2 className="mt-6 text-balance text-4xl font-bold tracking-tight md:text-5xl">
          Free for the early days. <span className="text-primary-strong">Honest as you grow.</span>
        </h2>
      </Reveal>

      <Stagger className="mt-16 grid gap-6 md:grid-cols-3" stagger={0.08}>
        {TIERS.map((t) => {
          // The featured tier rests a touch higher; hover lifts from that rest
          // point. All transform lives in Framer so it never fights CSS :hover.
          const restY = t.featured ? -8 : 0;
          const variants: Variants = reduce
            ? { hidden: { opacity: 0 }, visible: { opacity: 1, transition: { duration: 0.4 } } }
            : {
                hidden: { opacity: 0, y: 24 },
                visible: { opacity: 1, y: restY, transition: { duration: 0.55, ease: EASE } },
              };
          const hover = reduce
            ? undefined
            : {
                y: restY - 6,
                transition: { type: "spring" as const, stiffness: 300, damping: 24 },
              };
          return (
            <motion.div
              key={t.name}
              variants={variants}
              whileHover={hover}
              className={cn(
                "group relative flex flex-col overflow-hidden rounded-3xl border bg-glass/[0.03] p-8 transition-colors duration-300",
                t.featured
                  ? "border-primary/40 shadow-[0_20px_60px_rgb(182_244_37_/_0.08)]"
                  : "border-glass/[0.06] hover:border-glass/[0.10]"
              )}
            >
              {/* Top accent bar — Stitch pattern */}
              {t.featured && (
                <div aria-hidden="true" className="absolute inset-x-0 top-0 h-1 bg-primary" />
              )}

              <div className="flex items-start justify-between">
                <h3 className="text-xl font-bold tracking-tight">{t.name}</h3>
                {t.featured && (
                  <span className="rounded-full bg-bg px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-primary-strong">
                    Most popular
                  </span>
                )}
              </div>

              <div className="mt-6 flex items-baseline gap-2">
                <span className="font-mono text-5xl font-bold text-fg">{t.price}</span>
                <span className="text-sm text-fg-muted">{t.sub}</span>
              </div>

              <p className="mt-3 text-sm text-fg-muted">{t.desc}</p>

              <ul className="mt-8 space-y-3">
                {t.features.map((f) => (
                  <li key={f} className="flex items-start gap-3 text-sm text-fg">
                    <CheckCircle2
                      className="mt-0.5 h-4 w-4 shrink-0 text-primary-strong"
                      aria-hidden="true"
                    />
                    {f}
                  </li>
                ))}
              </ul>

              <div className="mt-auto pt-8">
                {t.name === "Scale" ? (
                  <a
                    href="mailto:sales@founderflow.app"
                    className="inline-flex w-full items-center justify-center gap-2 rounded-full border border-glass/[0.10] bg-glass/[0.05] px-5 py-3 text-sm font-semibold text-fg transition-colors hover:bg-glass/[0.10]"
                  >
                    {t.cta}
                  </a>
                ) : t.featured ? (
                  <Link
                    href="/signup"
                    className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-primary px-5 py-3 text-sm font-bold text-primary-fg shadow-[0_0_30px_rgb(182_244_37_/_0.25)] transition-transform hover:scale-[1.02] active:scale-95"
                  >
                    {t.cta}
                    <ArrowRight className="h-4 w-4" aria-hidden="true" />
                  </Link>
                ) : (
                  <button
                    onClick={onDemo}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-full border border-glass/[0.10] bg-glass/[0.05] px-5 py-3 text-sm font-semibold text-fg transition-colors hover:bg-glass/[0.10]"
                  >
                    {t.cta}
                  </button>
                )}
              </div>
            </motion.div>
          );
        })}
      </Stagger>
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* FAQ — Stitch native <details> with rotating + icon                           */
/* ─────────────────────────────────────────────────────────────────────────── */

const FAQS = [
  {
    q: "Do I need a credit card to start?",
    a: "No. The Solo plan is free forever — no card required.",
  },
  {
    q: "Can my co-founder and I share one workspace?",
    a: "Yes. Invite co-founders by email, assign roles, and you're set — built for teams of 2–5.",
  },
  {
    q: "Does FounderFlow replace QuickBooks or Xero?",
    a: "No — it sits in front of them. Track day-to-day finances, then export clean reports for your accountant.",
  },
  {
    q: "How is my data secured?",
    a: "Encrypted in transit and at rest, with role-based access enforced server-side on every request.",
  },
  {
    q: "Can I export my data?",
    a: "Yes — to PDF, Excel, and JSON, any time.",
  },
];

function FAQ() {
  return (
    <section id="faq" className="mx-auto max-w-3xl px-6 py-24">
      <Reveal className="text-center">
        <PillBadge tone="pink">FAQ</PillBadge>
        <h2 className="mt-6 text-balance text-4xl font-bold tracking-tight md:text-5xl">
          Questions, answered.
        </h2>
      </Reveal>

      <Stagger className="mt-12 space-y-3" stagger={0.06}>
        {FAQS.map((f) => (
          <StaggerItem key={f.q} distance={12}>
            <details className="group overflow-hidden rounded-2xl border border-glass/[0.06] bg-glass/[0.03] transition-colors hover:bg-glass/[0.05]">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 p-6 [&::-webkit-details-marker]:hidden">
                <span className="text-base font-semibold text-fg">{f.q}</span>
                <span
                  aria-hidden="true"
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-primary/30 bg-primary/10 text-lg text-primary-strong transition-transform duration-300 group-open:rotate-45"
                >
                  +
                </span>
              </summary>
              <div className="px-6 pb-6 text-sm leading-relaxed text-fg-muted">{f.a}</div>
            </details>
          </StaggerItem>
        ))}
      </Stagger>
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* CTA — lamp glow + glowing pill button + mini stats (Stitch)                 */
/* ─────────────────────────────────────────────────────────────────────────── */

function CTA({ onDemo }: { onDemo: () => void }) {
  return (
    <section className="mx-auto max-w-5xl px-6 py-24">
      <div className="relative overflow-hidden rounded-3xl border border-glass/[0.06] bg-bg/60 p-12 text-center md:p-20">
        {/* Lamp glow background */}
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-lamp-glow" />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-32 left-1/2 h-64 w-[600px] -translate-x-1/2 rounded-full bg-primary/20 blur-3xl"
        />

        <div className="relative z-10">
          <Reveal>
            <h2 className="mx-auto max-w-2xl text-balance text-4xl font-bold tracking-tight md:text-5xl">
              Stop fighting over <span className="text-primary-strong">spreadsheets</span>.
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-pretty text-base leading-relaxed text-fg-muted md:text-lg">
              Set up your workspace in under a minute. Free for the early days, no credit card
              required.
            </p>

            <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link
                href="/signup"
                className="group inline-flex items-center gap-3 rounded-full bg-primary px-10 py-4 text-lg font-bold text-primary-fg shadow-[0_0_50px_rgb(182_244_37_/_0.35)] transition-all hover:scale-[1.03] hover:shadow-[0_0_70px_rgb(182_244_37_/_0.5)] active:scale-95"
              >
                Start your free workspace
                <ArrowRight
                  className="h-5 w-5 transition-transform group-hover:translate-x-1"
                  aria-hidden="true"
                />
              </Link>
              <button
                onClick={onDemo}
                className="inline-flex items-center gap-2 rounded-full border border-glass/[0.10] bg-glass/[0.05] px-8 py-4 text-base font-medium text-fg backdrop-blur-sm transition-colors hover:bg-glass/[0.10]"
              >
                Explore the demo
              </button>
            </div>
          </Reveal>

          {/* Mini stats footer row — Stitch pattern */}
          <Stagger
            className="mt-16 grid grid-cols-2 gap-8 border-t border-glass/[0.06] pt-10 opacity-70 md:grid-cols-4 md:gap-16"
            stagger={0.08}
          >
            {[
              { value: "Free", label: "Forever" },
              { value: "< 60s", label: "Setup" },
              { value: "0", label: "Credit card" },
              { value: "100%", label: "Yours to export" },
            ].map((s) => (
              <StaggerItem key={s.label} className="text-center" distance={12}>
                <p className="font-mono text-2xl font-bold text-fg">{s.value}</p>
                <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.18em] text-fg-muted">
                  {s.label}
                </p>
              </StaggerItem>
            ))}
          </Stagger>
        </div>
      </div>
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Footer                                                                       */
/* ─────────────────────────────────────────────────────────────────────────── */

function Footer() {
  return (
    <footer className="border-t border-glass/[0.06] bg-bg/40">
      <div className="mx-auto flex max-w-7xl flex-col items-start justify-between gap-6 px-6 py-10 md:flex-row md:items-center">
        <div className="flex items-center gap-2.5">
          <BrandMark className="h-8 w-8" />
          <span className="text-sm font-bold tracking-tight">FounderFlow</span>
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-fg-muted">
            v1.0
          </span>
        </div>

        <nav aria-label="Footer" className="flex flex-wrap items-center gap-x-6 gap-y-2">
          {[
            { href: "#features", label: "Features" },
            { href: "#pricing", label: "Pricing" },
            { href: "#faq", label: "FAQ" },
            { href: "/login", label: "Log in" },
          ].map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="text-sm text-fg-muted transition-colors hover:text-fg"
            >
              {l.label}
            </a>
          ))}
        </nav>

        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-fg-muted">
          © {new Date().getFullYear()} · Built by founders, for founders
        </p>
      </div>
    </footer>
  );
}
