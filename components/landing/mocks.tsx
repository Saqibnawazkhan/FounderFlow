/**
 * Product mockups for the landing page's three pillar rows.
 *
 * Server components — no hooks, no handlers, no browser APIs. Keep it that way:
 * the landing page renders them to HTML and they never reach the client bundle.
 * Motion comes from the shared `.reveal-item` / `.reveal-bar` CSS, which needs
 * an ancestor carrying `data-visible` (i.e. wrap them in <Stagger>).
 */

import { AtSign, CheckCircle2, Hash, MessageSquare } from "lucide-react";
import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

function vars(v: Record<string, string | number>): CSSProperties {
  return v as CSSProperties;
}

const FRAME = cn(
  "overflow-hidden rounded-2xl border border-border bg-card",
  "shadow-[0_18px_50px_rgb(15_23_42_/_0.10)] dark:shadow-[0_18px_50px_rgb(0_0_0_/_0.45)]"
);

const TONE_BG = {
  primary: "bg-primary text-primary-fg",
  forest: "bg-forest text-primary-fg",
  mint: "bg-mint text-primary-fg",
};

function Avatar({
  initial,
  tone,
  className,
}: {
  initial: string;
  tone: keyof typeof TONE_BG;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center rounded-lg font-mono font-bold",
        TONE_BG[tone],
        className ?? "h-6 w-6 text-[10px]"
      )}
    >
      {initial}
    </span>
  );
}

/* ── Talk ─────────────────────────────────────────────────────────────────── */

/**
 * Every affordance drawn here must exist in the shipped product: channels,
 * @mentions, threaded replies, emoji reactions (from the fixed allow-list in
 * lib/schemas/chat.ts) and unread/mention counts. This mock used to show a
 * paperclip + a filename, which sold **file attachments** — permanently out of
 * scope, since there is no object storage and per-workspace blob cost was
 * declined. A landing page that promises a feature the signup flow can't
 * deliver is a trust bug, not a design flourish; don't re-add it.
 */
export function ThreadMock() {
  return (
    <div className={FRAME}>
      <div className="flex items-center gap-2 border-b border-border bg-surface px-4 py-2.5">
        <Hash className="h-3.5 w-3.5 text-fg-muted" aria-hidden="true" />
        <span className="text-sm font-bold tracking-tight">product</span>
        <span className="ml-auto font-mono text-[10px] text-fg-muted">4 members</span>
      </div>

      <div className="space-y-3.5 p-4">
        <div className="reveal-item flex gap-2.5" style={vars({ "--reveal-i": 0 })}>
          <Avatar initial="A" tone="forest" />
          <div className="min-w-0">
            <p className="flex items-baseline gap-1.5">
              <span className="text-xs font-bold text-fg">Ali</span>
              <span className="font-mono text-[9px] text-fg-muted">11:02</span>
            </p>
            <p className="mt-0.5 text-[13px] leading-snug text-fg-muted">
              Pushed the onboarding rewrite.{" "}
              <span className="rounded bg-forest/20 px-1 font-medium text-forest-strong">
                @sara
              </span>{" "}
              can you take a look before we ship?
            </p>
            <div className="mt-2 flex items-center gap-2">
              <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5 text-[10px]">
                👀 <span className="font-mono text-fg-muted">2</span>
              </span>
              <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5 text-[10px]">
                🚀 <span className="font-mono text-fg-muted">3</span>
              </span>
              <span className="inline-flex items-center gap-1 text-[10px] font-medium text-primary-strong">
                <MessageSquare className="h-3 w-3" aria-hidden="true" />5 replies
              </span>
            </div>
          </div>
        </div>

        <div className="reveal-item flex gap-2.5" style={vars({ "--reveal-i": 1 })}>
          <Avatar initial="S" tone="primary" />
          <div className="min-w-0">
            <p className="flex items-baseline gap-1.5">
              <span className="text-xs font-bold text-fg">Sara</span>
              <span className="font-mono text-[9px] text-fg-muted">11:08</span>
            </p>
            <p className="mt-0.5 text-[13px] leading-snug text-fg-muted">
              On it — leaving the copy notes in the thread.
            </p>
            <div className="mt-2 flex items-center gap-2">
              <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5 text-[10px]">
                ✅ <span className="font-mono text-fg-muted">1</span>
              </span>
            </div>
          </div>
        </div>

        <div
          className="reveal-item flex items-center gap-2 rounded-lg bg-mint/10 px-3 py-2"
          style={vars({ "--reveal-i": 2 })}
        >
          <AtSign className="h-3.5 w-3.5 shrink-0 text-mint-strong" aria-hidden="true" />
          <span className="text-[11px] text-fg-muted">
            <span className="font-semibold text-fg">1 mention</span> waiting in{" "}
            <span className="font-mono">#hiring</span>
          </span>
        </div>
      </div>
    </div>
  );
}

/* ── Ship ─────────────────────────────────────────────────────────────────── */

const BOARD = [
  {
    col: "To do",
    accent: "bg-fg-muted",
    cards: [
      { title: "Draft investor update", who: "S", tone: "primary" as const, tag: "High" },
      { title: "Fix invite email copy", who: "A", tone: "forest" as const, tag: "Low" },
    ],
  },
  {
    col: "In progress",
    accent: "bg-forest",
    cards: [{ title: "Onboarding rewrite", who: "A", tone: "forest" as const, tag: "High" }],
  },
  {
    col: "Done",
    accent: "bg-primary",
    cards: [
      { title: "Q3 budget approved", who: "S", tone: "primary" as const, tag: "Done" },
      { title: "Ship push alerts", who: "A", tone: "mint" as const, tag: "Done" },
    ],
  },
];

export function BoardMock() {
  return (
    <div className={cn(FRAME, "p-4")}>
      <div className="grid grid-cols-3 gap-3">
        {BOARD.map((c, ci) => (
          <div key={c.col} className="min-w-0">
            <div className="mb-2 flex items-center gap-1.5">
              <span className={cn("h-1.5 w-1.5 rounded-full", c.accent)} />
              <span className="truncate font-mono text-[9px] font-bold uppercase tracking-[0.14em] text-fg-muted">
                {c.col}
              </span>
            </div>
            <div className="space-y-2">
              {c.cards.map((card, i) => (
                <div
                  key={card.title}
                  className="reveal-item rounded-lg border border-border bg-surface p-2.5"
                  style={vars({ "--reveal-i": ci * 2 + i })}
                >
                  <p className="text-[11px] font-semibold leading-snug text-fg">{card.title}</p>
                  <div className="mt-2 flex items-center justify-between">
                    <span
                      className={cn(
                        "rounded px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase tracking-wider",
                        card.tag === "High"
                          ? "bg-mint/20 text-mint-strong"
                          : card.tag === "Done"
                            ? "bg-primary/20 text-primary-strong"
                            : "bg-fg/10 text-fg-muted"
                      )}
                    >
                      {card.tag}
                    </span>
                    <Avatar initial={card.who} tone={card.tone} className="h-4 w-4 text-[8px]" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Money ────────────────────────────────────────────────────────────────── */

const MONTHS = [40, 55, 35, 70, 45, 80, 60, 90, 75, 95, 65, 88];

const MONEY_STATS = [
  { label: "Balance", value: "547.5K", tone: "text-primary-strong" },
  { label: "Raised", value: "1.5M", tone: "text-forest-strong" },
  { label: "Burn", value: "82K/mo", tone: "text-mint-strong" },
];

export function MoneyMock() {
  return (
    <div className={cn(FRAME, "p-4")}>
      <div className="grid grid-cols-3 gap-2">
        {MONEY_STATS.map((s, i) => (
          <div
            key={s.label}
            className="reveal-item rounded-lg border border-border bg-surface p-2.5"
            style={vars({ "--reveal-i": i })}
          >
            <p className="font-mono text-[8px] uppercase tracking-[0.18em] text-fg-muted">
              {s.label}
            </p>
            <p className={cn("mt-1 font-mono text-base font-bold leading-none", s.tone)}>
              {s.value}
            </p>
          </div>
        ))}
      </div>

      <div className="mt-3 rounded-lg border border-border bg-surface p-3">
        <div className="mb-3 flex items-end justify-between">
          <p className="text-[11px] font-semibold">Cash flow · 12 months</p>
          <span className="font-mono text-[9px] uppercase tracking-widest text-primary-strong">
            +18.4%
          </span>
        </div>
        <div className="flex h-24 items-end gap-1.5">
          {MONTHS.map((h, i) => (
            <div
              key={i}
              className="reveal-bar flex-1 rounded-t bg-gradient-to-t from-primary/40 to-primary"
              style={vars({ height: `${h}%`, "--reveal-i": i })}
            />
          ))}
        </div>
      </div>

      <div
        className="reveal-item mt-3 flex items-center gap-2 rounded-lg bg-primary/10 px-3 py-2"
        style={vars({ "--reveal-i": 4 })}
      >
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-primary-strong" aria-hidden="true" />
        <span className="text-[11px] text-fg-muted">
          <span className="font-semibold text-fg">Budget on track</span> — 67.4% of Q3 spend used
        </span>
      </div>
    </div>
  );
}
