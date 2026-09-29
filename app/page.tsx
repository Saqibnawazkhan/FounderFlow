import type { CSSProperties } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRight,
  ArrowUpRight,
  AtSign,
  BarChart3,
  Bell,
  CheckCircle2,
  FileText,
  Hash,
  MessageSquare,
  Quote,
  Star,
  Users,
  Zap,
} from "lucide-react";
import { BrandMark } from "@/components/brand-mark";
import { appOrigin } from "@/lib/env";
import { cn } from "@/lib/utils";

import { ChannelPanel } from "@/components/landing/channel-panel";
import { BoardMock, MoneyMock, ThreadMock } from "@/components/landing/mocks";
import { GlassCard } from "@/components/landing/glass-card";
import { Lamp } from "@/components/landing/lamp";
import { Marquee } from "@/components/landing/marquee";
import { SectionLabel } from "@/components/landing/section-label";
import { SplitText } from "@/components/landing/split-text";
import { MarketingThemeToggle } from "@/components/landing/marketing-theme-toggle";
import { DemoButton } from "@/components/landing/demo-button";
import { Reveal, Stagger, StaggerItem } from "@/components/landing/reveal";
import { display } from "@/components/landing/fonts";

/* ─────────────────────────────────────────────────────────────────────────── */
/* This page is a SERVER component, deliberately.                              */
/*                                                                             */
/* It used to be one 1100-line "use client" file, which pulled framer-motion    */
/* (~40 kB gzip) onto the one route strangers load first. Every animation here  */
/* is CSS: scroll reveals key off a `data-visible` flag set by <InView>, hover  */
/* lifts are `.hover-lift`, and above-the-fold content uses a plain CSS load    */
/* animation so it never waits on hydration.                                   */
/*                                                                             */
/* The only client islands are <MarketingThemeToggle>, <DemoButton> and the     */
/* <InView> inside <Reveal>/<Stagger>. Keep it that way — adding "use client"   */
/* here would drag every section back into the bundle and would silently drop   */
/* the `metadata` export, which only server components may declare.             */
/*                                                                             */
/* The root carries `data-marketing data-theme="light"`: the marketing surface  */
/* is light-first regardless of the app shell's theme (see the `[data-theme]`   */
/* token blocks in globals.css). MarketingThemeToggle flips that attribute.     */
/* ─────────────────────────────────────────────────────────────────────────── */

/* Absolute origin for this page's JSON-LD (see <LandingJsonLd/> below).
 *
 * This line used to read the raw NEXT_PUBLIC_APP_URL with `||` and fall back to a
 * literal `https://founderflow-seven` vercel-app hostname (spelled out in
 * tests/lib/env/app-origin-call-sites.test.ts, which now fails if any deployment
 * hostname reappears in this file). That fallback was a latent bug of its own,
 * not just a tenth copy of the localhost one. Three things were wrong with it:
 *
 *  1. A HARD-CODED DEPLOYMENT HOSTNAME. Whenever the variable is unset, the
 *     landing page told every crawler that FounderFlow lives at that one
 *     preview-style hostname — and would keep telling them so after the app moved
 *     to its own domain, silently, with nothing to fail and nothing to log. A
 *     wrong-but-well-formed absolute URL is the dangerous kind: a crawler
 *     believes it and splits the site's identity across two hosts, whereas an
 *     obviously-local one is discarded. It was also the only place in the repo
 *     where a deployment hostname was committed to source at all.
 *  2. `||`, not `??`, so an empty NEXT_PUBLIC_APP_URL — the shape of "I added the
 *     variable in Vercel and left the value blank" — fell through to it too.
 *  3. It was the raw variable, so it bypassed both the trailing-slash
 *     normalisation and lib/env's production assertion.
 *
 * `appOrigin()` fixes all three, and picks up the property that matters most for
 * structured data: it is the SAME decision app/layout.tsx feeds to
 * `metadataBase`, so the JSON-LD `url` and the `<link rel="canonical">` on this
 * page can no longer disagree about where this app lives. Disagreeing is exactly
 * what Google treats as a conflicting signal.
 *
 * On localhost as a fallback: yes, an absolute localhost URL in structured data
 * is its own kind of wrong — but it is only ever emitted where nothing indexes
 * it. A production build cannot reach it (NEXT_PUBLIC_APP_URL is in
 * `requiredProdEnv` in scripts/vercel-build.mjs and a loopback value is rejected
 * outright), and Vercel serves preview deployments with `x-robots-tag: noindex`.
 * So the choice is between "obvious junk in a document no crawler reads" and
 * "a plausible lie in the document every crawler reads". This takes the first. */
const SITE_URL = appOrigin();

const DESCRIPTION =
  "Channels, DMs, tasks, and real financials in one workspace. FounderFlow gives small teams and startups a place to talk about the work — and see what it costs — without switching tabs.";

export const metadata: Metadata = {
  title: "FounderFlow — Team Chat, Tasks & Money in One Workspace",
  description: DESCRIPTION,
  // The root layout sets metadataBase; a self-referencing canonical stops the
  // marketing page competing with its own utm-tagged and trailing-slash forms.
  alternates: { canonical: "/" },
  openGraph: {
    title: "FounderFlow — Team Chat, Tasks & Money in One Workspace",
    description: DESCRIPTION,
    url: "/",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "FounderFlow — Team Chat, Tasks & Money in One Workspace",
    description: DESCRIPTION,
  },
};

/** Above-the-fold entrance. Plays on load rather than on scroll, so the hero
 *  paints and animates without waiting for JS. `both` fill-mode holds the
 *  from-state during the delay; without it the element flashes in first. */
function rise(delay: number): CSSProperties {
  return { animationDelay: `${delay}ms`, animationFillMode: "both" };
}

/** Inline custom properties, typed. CSS vars aren't part of React's CSSProperties. */
function vars(v: Record<string, string | number>): CSSProperties {
  return v as CSSProperties;
}

export default function LandingPage() {
  return (
    <div
      data-marketing
      data-theme="light"
      className={cn(display.variable, "min-h-screen bg-bg text-fg")}
    >
      {/* Scroll reveals start invisible and are switched on by IntersectionObserver.
          With JS off that never happens, so unhide everything up front. */}
      <noscript>
        <style>{`.reveal,.reveal-item{opacity:1!important;transform:none!important}.reveal-bar{transform:scaleY(1)!important}`}</style>
      </noscript>

      {/* Ambient wash — kept low on light so it reads as paper, not neon. */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 -z-10 bg-gradient-mesh opacity-[var(--ambient-opacity)]"
      />

      <LandingJsonLd />
      <Nav />
      {/* a11y-008. This page had a <header>, a <nav aria-label="Sections">,
          twelve <section>s and a <footer> — and no <main> at all, so the root
          layout's "Skip to main content" resolved to nothing on the one route
          strangers arrive on, and there was no main landmark to jump to either.
          <Nav> and <Footer> stay outside it: they are the chrome being skipped.
          `tabIndex={-1}` is what makes the fragment jump actually focus this
          region rather than only nudging the focus-navigation start point. */}
      <main id="main" tabIndex={-1}>
        <Hero />
        <TrustStrip />
        <StackBand />
        <Pillars />
        <Features />
        <HowItWorks />
        <Showcase />
        <Testimonial />
        <Pricing />
        <FAQ />
        <CTA />
      </main>
      <Footer />
    </div>
  );
}

/** SoftwareApplication structured data for rich search results. Rendered on the
 *  server into the prerendered HTML, so crawlers read it without running JS. */
function LandingJsonLd() {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "FounderFlow",
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web",
    url: SITE_URL,
    description:
      "Team communication, tasks, and company finances in one workspace — channels, direct messages, kanban boards, budgets and runway for small teams and startups.",
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
      description: "Free Solo plan — up to 2 teammates, no credit card required.",
    },
    publisher: { "@type": "Organization", name: "FounderFlow", url: SITE_URL },
  };
  return (
    <script
      type="application/ld+json"
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
    />
  );
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Nav                                                                          */
/* ─────────────────────────────────────────────────────────────────────────── */

const NAV_LINKS = [
  { href: "#talk", label: "Chat" },
  { href: "#features", label: "Features" },
  { href: "#showcase", label: "Product" },
  { href: "#pricing", label: "Pricing" },
  { href: "#faq", label: "FAQ" },
];

function Nav() {
  return (
    <header className="sticky top-0 z-sticky border-b border-border bg-bg/85 backdrop-blur-xl">
      <div className="mx-auto flex h-[68px] max-w-7xl items-center justify-between px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2.5">
          <BrandMark className="h-9 w-9" />
          <span className="text-[17px] font-bold tracking-tight">FounderFlow</span>
        </Link>

        <nav aria-label="Sections" className="hidden items-center gap-1 lg:flex">
          {NAV_LINKS.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="rounded-lg px-3.5 py-2 text-sm font-medium text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg"
            >
              {l.label}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <MarketingThemeToggle size="sm" />
          <Link
            href="/login"
            className="hidden rounded-lg px-3.5 py-2 text-sm font-medium text-fg-muted transition-colors hover:text-fg sm:inline-flex"
          >
            Log in
          </Link>
          <Link
            href="/signup"
            className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2.5 text-sm font-bold text-primary-fg shadow-[0_4px_14px_rgb(var(--primary)_/_0.22)] transition-transform hover:scale-[1.03] active:scale-[0.98]"
          >
            Start free
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        </div>
      </div>
    </header>
  );
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Hero — headline left, live channel panel right                              */
/* ─────────────────────────────────────────────────────────────────────────── */

function Hero() {
  return (
    <section className="relative mx-auto max-w-7xl px-6 pb-20 pt-14 lg:pb-28 lg:pt-20">
      <div className="grid items-center gap-12 lg:grid-cols-[0.95fr_1.05fr] lg:gap-14">
        <div className="flex flex-col items-start">
          <div className="animate-slide-up" style={rise(40)}>
            <SectionLabel tone="forest">All-in-one workspace for small teams</SectionLabel>
          </div>

          <h1 className="mt-4 text-balance text-[2.75rem] font-bold leading-[1.03] tracking-tight md:text-6xl lg:text-[4.2rem]">
            <SplitText text="Talk it through." delay={0} />
            <br />
            <SplitText text="Ship the work." delay={220} className="text-fg-muted" />
            <br />
            <SplitText text="See the money." delay={440} className="text-primary-strong" />
          </h1>

          <p
            className="mt-6 max-w-lg animate-slide-up text-pretty text-base leading-relaxed text-fg-muted md:text-[17px]"
            style={rise(140)}
          >
            Channels, direct messages, tasks and real financials in one workspace — so the answer to
            &ldquo;can we afford this?&rdquo; lives in the same window where you asked it.
          </p>

          <div className="mt-8 flex animate-slide-up flex-col gap-3 sm:flex-row" style={rise(230)}>
            <Link
              href="/signup"
              className="group inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-7 py-3.5 text-base font-bold text-primary-fg shadow-[0_8px_30px_rgb(var(--primary)_/_0.26)] transition-all hover:scale-[1.02] hover:shadow-[0_10px_40px_rgb(var(--primary)_/_0.34)] active:scale-[0.98]"
            >
              Start free — no credit card
              <ArrowRight
                className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
                aria-hidden="true"
              />
            </Link>
            <DemoButton className="inline-flex items-center justify-center gap-2 rounded-xl border border-border bg-surface px-7 py-3.5 text-base font-semibold text-fg transition-all hover:bg-surface-hover active:scale-[0.98]">
              Try the live demo
              <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
            </DemoButton>
          </div>

          <div
            className="mt-6 flex animate-slide-up flex-wrap items-center gap-x-5 gap-y-2"
            style={rise(320)}
          >
            {["Free for 2 teammates", "No credit card", "Set up in 60 seconds"].map((t) => (
              <span key={t} className="inline-flex items-center gap-1.5 text-xs text-fg-muted">
                <CheckCircle2 className="h-3.5 w-3.5 text-primary-strong" aria-hidden="true" />
                {t}
              </span>
            ))}
          </div>
        </div>

        {/* The product itself, not an abstraction of it. */}
        <ChannelPanel />
      </div>
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Trust strip                                                                  */
/* ─────────────────────────────────────────────────────────────────────────── */

const TRUST_TAGS = [
  "Pre-seed startups",
  "Bootstrapped duos",
  "Indie SaaS teams",
  "Agency partnerships",
  "Family businesses",
  "Open-source maintainers",
  "Local co-ops",
  "Side-project founders",
];

function TrustStrip() {
  return (
    <section className="border-y border-border bg-surface py-9">
      <Reveal>
        <SectionLabel tone="muted" className="mb-5 text-center">
          Built for every kind of small team
        </SectionLabel>
      </Reveal>
      <Marquee speed={50}>
        {TRUST_TAGS.map((t) => (
          <span
            key={t}
            className="inline-flex items-center gap-2 text-sm font-medium text-fg-muted"
          >
            <span aria-hidden="true" className="h-1 w-1 rounded-full bg-fg-muted/50" />
            {t}
          </span>
        ))}
      </Marquee>
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Stack band — the all-in-one claim, made concrete                            */
/* ─────────────────────────────────────────────────────────────────────────── */

const REPLACES = [
  { tool: "Slack", forWhat: "team chat" },
  { tool: "WhatsApp", forWhat: "founder DMs" },
  { tool: "Trello", forWhat: "task boards" },
  { tool: "Google Sheets", forWhat: "the money" },
  { tool: "Toggl", forWhat: "time tracking" },
];

function StackBand() {
  return (
    <section className="relative overflow-hidden">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-gradient-to-br from-primary/[0.10] via-forest/[0.07] to-mint/[0.08]"
      />
      <div className="relative mx-auto max-w-5xl px-6 py-20">
        <Reveal className="text-center">
          <h2 className="text-balance text-3xl font-bold tracking-tight md:text-[2.6rem]">
            One workspace instead of <span className="text-primary-strong">five open tabs</span>.
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-pretty text-base leading-relaxed text-fg-muted">
            Small teams don&apos;t need five tools — they need one place where the conversation and
            the numbers sit next to each other.
          </p>
        </Reveal>

        <Stagger className="mt-12 flex flex-wrap items-center justify-center gap-3" stagger={70}>
          {REPLACES.map((r, i) => (
            <StaggerItem key={r.tool} index={i} distance={12}>
              <span className="inline-flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-2.5">
                <span className="text-sm font-semibold text-fg-muted line-through decoration-danger/60 decoration-2">
                  {r.tool}
                </span>
                <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-fg-muted">
                  {r.forWhat}
                </span>
              </span>
            </StaggerItem>
          ))}
        </Stagger>

        <Reveal className="mt-8 flex justify-center" delay={200}>
          <span className="inline-flex items-center gap-2.5 rounded-xl bg-primary px-5 py-3 text-base font-bold text-primary-fg shadow-[0_8px_30px_rgb(var(--primary)_/_0.22)]">
            <BrandMark className="h-6 w-6" title="" />
            FounderFlow
          </span>
        </Reveal>
      </div>
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Pillars — three alternating rows, each with its real surface                */
/* ─────────────────────────────────────────────────────────────────────────── */

const PILLARS = [
  {
    id: "talk",
    badge: "Talk",
    tone: "forest" as const,
    title: "Channels for every corner of the company",
    body: "Public channels, private ones, group threads and one-to-one DMs. Mention a teammate, react, attach a file, and keep the decision where anyone can find it later.",
    points: [
      "Channels, private channels and direct messages",
      "Threaded replies, reactions and @mentions",
      "File attachments and full-text search",
    ],
    mock: <ThreadMock />,
  },
  {
    id: "ship",
    badge: "Ship",
    tone: "primary" as const,
    title: "Turn the conversation into work that gets done",
    body: "A decision in a channel becomes a task with an owner and a deadline. Track it on a board, in a list, or on a calendar — and log the hours against it.",
    points: [
      "Kanban board, list and calendar views",
      "Owners, priorities, deadlines and projects",
      "Built-in time tracking per task",
    ],
    mock: <BoardMock />,
  },
  {
    id: "money",
    badge: "Money",
    tone: "mint" as const,
    title: "The numbers, in the same window as the chat",
    body: "Log investments and expenses, set budgets, and watch runway update live. When someone asks what something costs, the answer is one channel away — not one spreadsheet away.",
    points: [
      "Investments, expenses, revenue and budgets",
      "Live runway, burn rate and balance",
      "Investor-ready PDF and Excel exports",
    ],
    mock: <MoneyMock />,
  },
];

function Pillars() {
  return (
    <section className="mx-auto max-w-7xl px-6 py-24">
      <Reveal className="mx-auto max-w-2xl text-center">
        <SectionLabel>How it fits together</SectionLabel>
        <h2 className="mt-4 text-balance text-4xl font-bold tracking-tight md:text-5xl">
          Three things every small team does.{" "}
          <span className="text-primary-strong">One place to do them.</span>
        </h2>
      </Reveal>

      <div className="mt-20 space-y-24">
        {PILLARS.map((p, i) => (
          <PillarRow key={p.id} {...p} flip={i % 2 === 1} />
        ))}
      </div>
    </section>
  );
}

function PillarRow({
  id,
  badge,
  tone,
  title,
  body,
  points,
  mock,
  flip,
}: (typeof PILLARS)[number] & { flip: boolean }) {
  return (
    <div id={id} className="grid scroll-mt-24 items-center gap-10 lg:grid-cols-2 lg:gap-16">
      <Reveal className={cn(flip && "lg:order-2")}>
        <SectionLabel tone={tone}>{badge}</SectionLabel>
        <h3 className="mt-3 text-balance text-3xl font-bold tracking-tight md:text-[2.1rem] md:leading-[1.15]">
          {title}
        </h3>
        <p className="mt-4 text-pretty text-base leading-relaxed text-fg-muted">{body}</p>
        <ul className="mt-6 space-y-3">
          {points.map((pt) => (
            <li key={pt} className="flex items-start gap-3 text-[15px] text-fg">
              <CheckCircle2
                className={cn(
                  "mt-0.5 h-4 w-4 shrink-0",
                  tone === "forest"
                    ? "text-forest-strong"
                    : tone === "mint"
                      ? "text-mint-strong"
                      : "text-primary-strong"
                )}
                aria-hidden="true"
              />
              {pt}
            </li>
          ))}
        </ul>
      </Reveal>

      {/* The mock's own pieces animate via .reveal-item, so it needs a
          data-visible ancestor — <Stagger> is that ancestor. */}
      <Stagger className={cn(flip && "lg:order-1")} stagger={70}>
        {mock}
      </Stagger>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Features                                                                     */
/* ─────────────────────────────────────────────────────────────────────────── */

const FEATURES = [
  {
    icon: MessageSquare,
    title: "Channels & DMs",
    desc: "Organise the company into channels, go private when you need to, and DM anyone on the team.",
    aside: "Public, private, and one-to-one — all searchable.",
    wide: true,
  },
  {
    icon: AtSign,
    title: "Threads & mentions",
    desc: "Replies stay attached to the message that started them. @mention someone and they know.",
  },
  {
    icon: CheckCircle2,
    title: "Tasks that stick",
    desc: "Board, list and calendar views with owners, priorities and deadlines.",
  },
  {
    icon: BarChart3,
    title: "Live financials",
    desc: "Balance, burn rate, runway and founder contributions — always current, never a stale export.",
    aside: "Recalculated on every write, not on a nightly job.",
    wide: true,
  },
  {
    icon: FileText,
    title: "Investor-ready reports",
    desc: "Monthly P&L and contribution breakdowns, exportable to PDF or Excel.",
  },
  {
    icon: Bell,
    title: "Push & email alerts",
    desc: "Mentions, assignments and budget warnings reach you on desktop and mobile.",
  },
  {
    icon: Users,
    title: "Role-based access",
    desc: "Admin, co-founder and member roles, enforced server-side on every read and write.",
  },
];

function Features() {
  return (
    <section id="features" className="scroll-mt-24 border-y border-border bg-surface">
      <div className="mx-auto max-w-7xl px-6 py-24">
        {/* Asymmetric header — every other section on this page centres its
            heading, so this one deliberately breaks the rhythm. */}
        <Reveal className="grid gap-6 md:grid-cols-[1.1fr_0.9fr] md:items-end">
          <div>
            <SectionLabel tone="forest">Everything included</SectionLabel>
            <h2 className="mt-3 text-balance text-4xl font-bold tracking-tight md:text-5xl">
              Everything you need,{" "}
              <span className="text-primary-strong">nothing you don&apos;t</span>.
            </h2>
          </div>
          <p className="text-pretty text-base leading-relaxed text-fg-muted md:pb-2">
            No per-feature upsells and no add-on pricing. Every plan gets the whole workspace — the
            free one included.
          </p>
        </Reveal>

        {/* Bento: the two anchor features run double-width and alternate sides,
            so the grid never reads as nine identical tiles. */}
        <Stagger className="mt-14 grid gap-4 md:grid-cols-2 lg:grid-cols-3" stagger={55}>
          {FEATURES.map((f, i) => (
            <FeatureCard key={f.title} index={i} {...f} />
          ))}
        </Stagger>
      </div>
    </section>
  );
}

function FeatureCard({
  icon: Icon,
  title,
  desc,
  aside,
  wide,
  index,
}: (typeof FEATURES)[number] & { index: number; aside?: string; wide?: boolean }) {
  return (
    <StaggerItem index={index} className={cn("h-full", wide && "lg:col-span-2")}>
      <div
        className={cn(
          "hover-lift group flex h-full flex-col rounded-2xl border border-border bg-card p-6",
          "transition-colors duration-300 hover:border-primary/40",
          wide && "lg:flex-row lg:items-center lg:gap-8 lg:p-8"
        )}
      >
        <div
          className={cn(
            "mb-5 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl",
            "border border-primary/25 bg-primary/10 text-primary-strong",
            wide && "lg:mb-0 lg:h-14 lg:w-14"
          )}
        >
          <Icon className={cn("h-5 w-5", wide && "lg:h-6 lg:w-6")} aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <h3 className={cn("text-[17px] font-bold tracking-tight text-fg", wide && "lg:text-xl")}>
            {title}
          </h3>
          <p className="mt-2 text-sm leading-relaxed text-fg-muted">{desc}</p>
          {aside && (
            <p className="mt-3 border-t border-border pt-3 font-mono text-[11px] text-fg-muted">
              {aside}
            </p>
          )}
        </div>
      </div>
    </StaggerItem>
  );
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* How it works                                                                 */
/* ─────────────────────────────────────────────────────────────────────────── */

const STEPS = [
  {
    n: "01",
    icon: Zap,
    title: "Create your workspace",
    desc: "Sign up in under a minute — no credit card. Your shared company home is ready the moment you land.",
  },
  {
    n: "02",
    icon: Hash,
    title: "Invite the team, open a channel",
    desc: "Add teammates by email, assign roles, and spin up channels for product, finance and hiring.",
  },
  {
    n: "03",
    icon: BarChart3,
    title: "Talk, assign and track — together",
    desc: "Discuss in channels, turn decisions into tasks, log the spend, and watch runway update live.",
  },
];

function HowItWorks() {
  return (
    <section id="how-it-works" className="mx-auto max-w-7xl scroll-mt-24 px-6 py-24">
      <Reveal className="mx-auto max-w-2xl text-center">
        <SectionLabel tone="mint">How it works</SectionLabel>
        <h2 className="mt-4 text-balance text-4xl font-bold tracking-tight md:text-5xl">
          From five scattered tools to{" "}
          <span className="text-primary-strong">one shared workspace</span>.
        </h2>
        <p className="mt-4 text-pretty text-base leading-relaxed text-fg-muted">
          Three steps to get your team aligned — most are set up before their coffee&apos;s cold.
        </p>
      </Reveal>

      <Stagger className="mt-14 grid gap-5 md:grid-cols-3" stagger={100}>
        {STEPS.map((s, i) => (
          <StepCard key={s.n} index={i} {...s} />
        ))}
      </Stagger>
    </section>
  );
}

function StepCard({
  n,
  icon: Icon,
  title,
  desc,
  index,
}: (typeof STEPS)[number] & { index: number }) {
  return (
    <StaggerItem index={index} className="h-full">
      <div className="hover-lift flex h-full flex-col rounded-2xl border border-border bg-card p-7 transition-colors duration-300 hover:border-primary/40">
        <div className="flex items-center justify-between">
          <span className="font-mono text-4xl font-bold leading-none tracking-tight text-primary-strong/80">
            {n}
          </span>
          <div className="inline-flex h-11 w-11 items-center justify-center rounded-xl border border-primary/25 bg-primary/10 text-primary-strong">
            <Icon className="h-5 w-5" aria-hidden="true" />
          </div>
        </div>
        <h3 className="mt-6 text-[19px] font-bold tracking-tight text-fg">{title}</h3>
        <p className="mt-2 text-sm leading-relaxed text-fg-muted">{desc}</p>
      </div>
    </StaggerItem>
  );
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Showcase                                                                     */
/* ─────────────────────────────────────────────────────────────────────────── */

function Showcase() {
  return (
    <section id="showcase" className="relative scroll-mt-24 border-y border-border bg-surface">
      <Lamp>
        <Reveal className="flex flex-col items-center text-center">
          <SectionLabel>The product</SectionLabel>
          <h2 className="mt-4 max-w-3xl text-balance text-4xl font-bold tracking-tight md:text-5xl">
            One window. <span className="text-primary-strong">The whole company.</span>
          </h2>
          <p className="mt-4 max-w-xl text-pretty text-base leading-relaxed text-fg-muted">
            Chat on the left, work in the middle, money on the right — no tab-switching, no
            re-explaining, no &ldquo;which spreadsheet was that in?&rdquo;.
          </p>
        </Reveal>
      </Lamp>

      <div className="relative mx-auto -mt-10 max-w-6xl px-6 pb-28">
        <Reveal distance={28}>
          <GlassCard className="overflow-hidden">
            <WorkspaceMock />
          </GlassCard>
        </Reveal>
      </div>
    </section>
  );
}

const WORKSPACE_CHANNELS = ["general", "finance", "product", "hiring", "design"];

const WORKSPACE_FEED = [
  { who: "Sara", what: "added a 150K investment", tone: "primary" as const },
  { who: "Ali", what: "completed “Onboarding rewrite”", tone: "forest" as const },
  { who: "Ahmed", what: "logged office rent", tone: "mint" as const },
  { who: "Sara", what: "mentioned you in #hiring", tone: "primary" as const },
];

const WORKSPACE_BARS = [40, 55, 35, 70, 45, 80, 60, 90, 75, 95, 65, 88];

const TONE_DOT = {
  primary: "bg-primary text-primary-fg",
  forest: "bg-forest text-primary-fg",
  mint: "bg-mint text-primary-fg",
};

function WorkspaceMock() {
  return (
    <Stagger className="grid gap-4 p-5 md:grid-cols-[150px_1fr_220px] md:p-6" stagger={60}>
      {/* Chat rail */}
      <div className="rounded-xl border border-border bg-surface p-3">
        <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-fg-muted">Channels</p>
        <ul className="mt-2 space-y-1">
          {WORKSPACE_CHANNELS.map((c, i) => (
            <li
              key={c}
              className={cn(
                "reveal-item flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs",
                i === 1 ? "bg-primary/15 font-semibold text-primary-strong" : "text-fg-muted"
              )}
              style={vars({ "--reveal-i": i })}
            >
              <Hash className="h-3 w-3 shrink-0" aria-hidden="true" />
              {c}
            </li>
          ))}
        </ul>
      </div>

      {/* Work in the middle */}
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: "Balance", value: "547.5K", tone: "text-primary-strong" },
            { label: "Raised", value: "1.5M", tone: "text-forest-strong" },
            { label: "Burn", value: "82K/mo", tone: "text-mint-strong" },
            { label: "Runway", value: "11 mo", tone: "text-primary-strong" },
          ].map((s, i) => (
            <div
              key={s.label}
              className="reveal-item rounded-xl border border-border bg-surface p-3"
              style={vars({ "--reveal-i": i })}
            >
              <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-fg-muted">
                {s.label}
              </p>
              <p className={cn("mt-1.5 font-mono text-xl font-bold leading-none", s.tone)}>
                {s.value}
              </p>
            </div>
          ))}
        </div>

        <div className="rounded-xl border border-border bg-surface p-4">
          <div className="mb-3 flex items-end justify-between">
            <p className="text-sm font-semibold">Cash flow · last 12 months</p>
            <span className="font-mono text-[10px] uppercase tracking-widest text-primary-strong">
              +18.4%
            </span>
          </div>
          <div className="flex h-36 items-end gap-2">
            {WORKSPACE_BARS.map((h, i) => (
              <div
                key={i}
                className="reveal-bar flex-1 rounded-t-md bg-gradient-to-t from-primary/35 to-primary"
                style={vars({ height: `${h}%`, "--reveal-i": i })}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Activity rail */}
      <div className="rounded-xl border border-border bg-surface p-4">
        <p className="mb-3 text-sm font-semibold">Live activity</p>
        <ul className="space-y-3">
          {WORKSPACE_FEED.map((a, i) => (
            <li
              key={i}
              className="reveal-item flex items-center gap-2.5"
              style={vars({ "--reveal-i": i })}
            >
              <span
                className={cn(
                  "grid h-7 w-7 shrink-0 place-items-center rounded-full font-mono text-[10px] font-bold",
                  TONE_DOT[a.tone]
                )}
              >
                {a.who[0]}
              </span>
              <p className="text-xs leading-snug text-fg-muted">
                <span className="font-semibold text-fg">{a.who}</span> {a.what}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </Stagger>
  );
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Testimonial                                                                  */
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
              &ldquo;We closed four tabs on day one. The finance question that used to derail a
              whole standup now gets answered in the thread where it was asked.&rdquo;
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
/* Pricing                                                                      */
/* ─────────────────────────────────────────────────────────────────────────── */

const TIERS = [
  {
    name: "Solo",
    price: "Free",
    sub: "to start",
    desc: "For the early days — validating the idea with a co-founder.",
    features: [
      "1 workspace, up to 2 teammates",
      "Unlimited channels and DMs",
      "Tasks, time tracking and finances",
      "Community support",
    ],
    cta: "Start free",
    featured: false,
  },
  {
    name: "Team",
    price: "$10",
    sub: "/mo per workspace",
    desc: "When the team grows and the reporting has to look the part.",
    features: [
      "Unlimited teammates",
      "Private channels and guest access",
      "Investor-ready reports",
      "Push and email notifications",
      "PDF & Excel export",
      "Priority support",
    ],
    cta: "Get started",
    featured: true,
  },
  {
    name: "Scale",
    price: "Custom",
    sub: "talk to us",
    desc: "Post-PMF, with custom workflows and dedicated onboarding.",
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

function Pricing() {
  return (
    <section id="pricing" className="scroll-mt-24 border-y border-border bg-surface">
      <div className="mx-auto max-w-6xl px-6 py-24">
        <Reveal className="mx-auto max-w-2xl text-center">
          <SectionLabel tone="forest">Pricing</SectionLabel>
          <h2 className="mt-4 text-balance text-4xl font-bold tracking-tight md:text-5xl">
            Free for the early days.{" "}
            <span className="text-primary-strong">Honest as you grow.</span>
          </h2>
          <p className="mt-4 text-pretty text-base leading-relaxed text-fg-muted">
            One price per workspace — not per seat, so inviting a teammate never costs you more.
          </p>
        </Reveal>

        <Stagger className="mt-14 grid gap-6 md:grid-cols-3" stagger={80}>
          {TIERS.map((t, i) => (
            <StaggerItem key={t.name} index={i} className="h-full" distance={24}>
              {/* The featured tier rests a touch higher; --lift-rest keeps that
                  offset and the hover lift on one transform so they never fight. */}
              <div
                style={t.featured ? vars({ "--lift-rest": "-8px" }) : undefined}
                className={cn(
                  "hover-lift relative flex h-full flex-col overflow-hidden rounded-2xl border bg-card p-7 transition-colors duration-300",
                  t.featured
                    ? "border-primary shadow-[0_20px_60px_rgb(var(--primary)_/_0.14)]"
                    : "border-border hover:border-fg-muted/30"
                )}
              >
                {t.featured && (
                  <div aria-hidden="true" className="absolute inset-x-0 top-0 h-1 bg-primary" />
                )}

                <div className="flex items-start justify-between">
                  <h3 className="text-xl font-bold tracking-tight">{t.name}</h3>
                  {t.featured && (
                    <span className="rounded-full bg-primary/15 px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-primary-strong">
                      Most popular
                    </span>
                  )}
                </div>

                <div className="mt-5 flex items-baseline gap-2">
                  <span className="font-mono text-5xl font-bold text-fg">{t.price}</span>
                  <span className="text-sm text-fg-muted">{t.sub}</span>
                </div>

                <p className="mt-3 text-sm text-fg-muted">{t.desc}</p>

                <ul className="mt-7 space-y-3">
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
                      className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-surface px-5 py-3 text-sm font-semibold text-fg transition-colors hover:bg-surface-hover"
                    >
                      {t.cta}
                    </a>
                  ) : t.featured ? (
                    <Link
                      href="/signup"
                      className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-5 py-3 text-sm font-bold text-primary-fg shadow-[0_6px_24px_rgb(var(--primary)_/_0.22)] transition-transform hover:scale-[1.02] active:scale-[0.98]"
                    >
                      {t.cta}
                      <ArrowRight className="h-4 w-4" aria-hidden="true" />
                    </Link>
                  ) : (
                    <DemoButton className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-surface px-5 py-3 text-sm font-semibold text-fg transition-colors hover:bg-surface-hover">
                      {t.cta}
                    </DemoButton>
                  )}
                </div>
              </div>
            </StaggerItem>
          ))}
        </Stagger>
      </div>
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* FAQ                                                                          */
/* ─────────────────────────────────────────────────────────────────────────── */

const FAQS = [
  {
    q: "Is this meant to replace Slack?",
    a: "For a small team, yes. You get channels, private channels, group threads and direct messages — plus the tasks and the finances those conversations are actually about, which is the part Slack sends you to another tool for.",
  },
  {
    q: "Can I message someone privately?",
    a: "Yes. Direct messages and private channels are included on every plan, including the free one.",
  },
  {
    q: "Do I need a credit card to start?",
    a: "No. The Solo plan is free to start — no card required.",
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
    <section id="faq" className="mx-auto max-w-3xl scroll-mt-24 px-6 py-24">
      <Reveal className="text-center">
        <SectionLabel tone="mint">FAQ</SectionLabel>
        <h2 className="mt-4 text-balance text-4xl font-bold tracking-tight md:text-5xl">
          Questions, answered.
        </h2>
      </Reveal>

      <Stagger className="mt-12 space-y-3" stagger={55}>
        {FAQS.map((f, i) => (
          <StaggerItem key={f.q} index={i} distance={12}>
            <details className="group overflow-hidden rounded-2xl border border-border bg-card transition-colors hover:border-fg-muted/30">
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
/* CTA                                                                          */
/* ─────────────────────────────────────────────────────────────────────────── */

const CTA_STATS = [
  { value: "Free", label: "To start" },
  { value: "< 60s", label: "Setup" },
  { value: "0", label: "Credit card" },
  { value: "100%", label: "Yours to export" },
];

function CTA() {
  return (
    <section className="mx-auto max-w-5xl px-6 py-24">
      <div className="relative overflow-hidden rounded-3xl border border-border bg-card p-12 text-center md:p-20">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-gradient-to-br from-primary/[0.12] via-transparent to-forest/[0.10]"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-32 left-1/2 h-64 w-[600px] -translate-x-1/2 rounded-full bg-primary/25 blur-3xl"
        />

        <div className="relative z-10">
          <Reveal>
            <h2 className="mx-auto max-w-2xl text-balance text-4xl font-bold tracking-tight md:text-5xl">
              Close the other four tabs.
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-pretty text-base leading-relaxed text-fg-muted md:text-lg">
              Set up your workspace in under a minute. Free for the early days, no credit card
              required.
            </p>

            <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link
                href="/signup"
                className="group inline-flex items-center gap-3 rounded-xl bg-primary px-9 py-4 text-lg font-bold text-primary-fg shadow-[0_10px_40px_rgb(var(--primary)_/_0.28)] transition-all hover:scale-[1.03] active:scale-[0.98]"
              >
                Start your free workspace
                <ArrowRight
                  className="h-5 w-5 transition-transform group-hover:translate-x-1"
                  aria-hidden="true"
                />
              </Link>
              <DemoButton className="inline-flex items-center gap-2 rounded-xl border border-border bg-surface px-8 py-4 text-base font-semibold text-fg transition-colors hover:bg-surface-hover">
                Explore the demo
              </DemoButton>
            </div>
          </Reveal>

          <Stagger
            className="mt-14 grid grid-cols-2 gap-8 border-t border-border pt-10 md:grid-cols-4 md:gap-16"
            stagger={80}
          >
            {CTA_STATS.map((s, i) => (
              <StaggerItem key={s.label} index={i} className="text-center" distance={12}>
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
    <footer className="border-t border-border bg-surface">
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
            { href: "#talk", label: "Chat" },
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

        {/* Server-rendered at build time. The page is statically prerendered, so
            this year is baked in at deploy — fine at our release cadence. */}
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-fg-muted">
          © {new Date().getFullYear()} · Built by founders, for founders
        </p>
      </div>
    </footer>
  );
}
