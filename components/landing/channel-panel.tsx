/**
 * ChannelPanel — the hero's product surface.
 *
 * A miniature of the messaging workspace: channel rail, a live thread, and the
 * composer. The thread is written to make the product's argument structurally
 * rather than in prose — a money question gets asked in chat and answered by a
 * runway card inline, in the same window. That is the whole pitch.
 *
 * Server component — no hooks, no handlers, no browser APIs. Keep it that way:
 * the landing page renders it to HTML and it never reaches the client bundle.
 * The entrance is a CSS load animation (not a scroll reveal) because this sits
 * above the fold and must never wait on hydration to appear.
 */

import { Hash, Lock, Plus, Search, Send, Smile, TrendingUp } from "lucide-react";
import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

function rise(delay: number): CSSProperties {
  return { animationDelay: `${delay}ms`, animationFillMode: "both" };
}

const CHANNELS = [
  { name: "general", unread: 0 },
  { name: "finance", unread: 3, active: true },
  { name: "product", unread: 0 },
  { name: "hiring", unread: 1, private: true },
];

const DMS = [
  { name: "Sara", initial: "S", tone: "primary" as const, online: true },
  { name: "Ali", initial: "A", tone: "forest" as const, online: true },
  { name: "Ahmed", initial: "A", tone: "mint" as const, online: false },
];

const TONE_BG = {
  primary: "bg-primary text-primary-fg",
  forest: "bg-forest text-primary-fg",
  mint: "bg-mint text-primary-fg",
};

export function ChannelPanel({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "animate-slide-up overflow-hidden rounded-2xl border border-border bg-card",
        "shadow-[0_24px_70px_rgb(15_23_42_/_0.14)] dark:shadow-[0_24px_70px_rgb(0_0_0_/_0.5)]",
        className
      )}
      style={rise(180)}
    >
      {/* Window chrome — reads as "this is the app", not a decorative graphic. */}
      <div className="flex items-center gap-2 border-b border-border bg-surface px-4 py-3">
        <span className="h-2.5 w-2.5 rounded-full bg-danger/70" />
        <span className="h-2.5 w-2.5 rounded-full bg-warning/70" />
        <span className="h-2.5 w-2.5 rounded-full bg-success/70" />
        <div className="ml-3 flex flex-1 items-center gap-2 rounded-lg bg-bg px-2.5 py-1">
          <Search className="h-3 w-3 text-fg-muted" aria-hidden="true" />
          <span className="font-mono text-[10px] text-fg-muted">nimble-studio.founderflow.app</span>
        </div>
      </div>

      <div className="flex">
        {/* Channel rail — hidden on the narrowest screens so the thread keeps
            enough width to stay legible. */}
        <aside className="hidden w-[132px] shrink-0 border-r border-border bg-surface p-3 sm:block">
          <p className="px-1 font-mono text-[9px] uppercase tracking-[0.18em] text-fg-muted">
            Channels
          </p>
          <ul className="mt-2 space-y-0.5">
            {CHANNELS.map((c) => (
              <li key={c.name}>
                <span
                  className={cn(
                    "flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs",
                    c.active ? "bg-primary/15 font-semibold text-primary-strong" : "text-fg-muted"
                  )}
                >
                  {c.private ? (
                    <Lock className="h-3 w-3 shrink-0" aria-hidden="true" />
                  ) : (
                    <Hash className="h-3 w-3 shrink-0" aria-hidden="true" />
                  )}
                  <span className="truncate">{c.name}</span>
                  {c.unread > 0 && (
                    <span className="ml-auto rounded-full bg-primary px-1.5 font-mono text-[9px] font-bold text-primary-fg">
                      {c.unread}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>

          <p className="mt-4 px-1 font-mono text-[9px] uppercase tracking-[0.18em] text-fg-muted">
            Direct
          </p>
          <ul className="mt-2 space-y-0.5">
            {DMS.map((d) => (
              <li
                key={d.name}
                className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-fg-muted"
              >
                <span className="relative shrink-0">
                  <span
                    className={cn(
                      "grid h-4 w-4 place-items-center rounded-full font-mono text-[8px] font-bold",
                      TONE_BG[d.tone]
                    )}
                  >
                    {d.initial}
                  </span>
                  {d.online && (
                    <span className="absolute -bottom-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-success ring-1 ring-surface" />
                  )}
                </span>
                <span className="truncate">{d.name}</span>
              </li>
            ))}
          </ul>

          <span className="mt-4 flex items-center gap-1.5 px-1.5 text-xs text-fg-muted">
            <Plus className="h-3 w-3" aria-hidden="true" />
            Add
          </span>
        </aside>

        {/* Thread */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
            <Hash className="h-3.5 w-3.5 text-fg-muted" aria-hidden="true" />
            <span className="text-sm font-bold tracking-tight">finance</span>
            <span className="ml-auto font-mono text-[10px] text-fg-muted">3 members</span>
          </div>

          <div className="space-y-3 p-4">
            <Message
              initial="S"
              tone="primary"
              name="Sara"
              time="9:14"
              delay={420}
              body="Can we afford the design contractor this month?"
            />

            <Message
              initial="A"
              tone="forest"
              name="Ali"
              time="9:15"
              delay={620}
              body="One sec — pulling the numbers."
            />

            {/* The point of the whole panel: the answer arrives in the thread,
                not in a spreadsheet someone has to go open. */}
            <div className="animate-slide-up pl-9" style={rise(820)}>
              <div className="rounded-xl border border-primary/30 bg-primary/[0.07] p-3">
                <div className="flex items-center gap-1.5">
                  <TrendingUp className="h-3 w-3 text-primary-strong" aria-hidden="true" />
                  <span className="font-mono text-[9px] font-bold uppercase tracking-[0.18em] text-primary-strong">
                    Runway · live
                  </span>
                </div>
                <div className="mt-2 grid grid-cols-3 gap-3">
                  <div>
                    <p className="font-mono text-xl font-bold leading-none text-fg">11 mo</p>
                    <p className="mt-1 font-mono text-[9px] uppercase tracking-widest text-fg-muted">
                      Runway
                    </p>
                  </div>
                  <div>
                    <p className="font-mono text-xl font-bold leading-none text-fg">82K</p>
                    <p className="mt-1 font-mono text-[9px] uppercase tracking-widest text-fg-muted">
                      Burn / mo
                    </p>
                  </div>
                  <div>
                    <p className="font-mono text-xl font-bold leading-none text-fg">547K</p>
                    <p className="mt-1 font-mono text-[9px] uppercase tracking-widest text-fg-muted">
                      Balance
                    </p>
                  </div>
                </div>
              </div>
            </div>

            <Message
              initial="A"
              tone="forest"
              name="Ali"
              time="9:16"
              delay={1000}
              body="Yes — 11 months of runway. Logging it as a pending expense now."
            />

            {/* Typing indicator — the one piece of perpetual motion, which is
                what makes a static mock read as live. */}
            <div className="flex animate-slide-up items-center gap-2 pl-9" style={rise(1200)}>
              <span className="flex gap-1">
                <Dot delay="0ms" />
                <Dot delay="160ms" />
                <Dot delay="320ms" />
              </span>
              <span className="text-[11px] text-fg-muted">Sara is typing…</span>
            </div>
          </div>

          {/* Composer */}
          <div className="mt-auto border-t border-border p-3">
            <div className="flex items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2">
              <span className="flex-1 truncate text-xs text-fg-muted">Message #finance</span>
              <Smile className="h-3.5 w-3.5 shrink-0 text-fg-muted" aria-hidden="true" />
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-primary">
                <Send className="h-3 w-3 text-primary-fg" aria-hidden="true" />
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Message({
  initial,
  tone,
  name,
  time,
  body,
  delay,
}: {
  initial: string;
  tone: keyof typeof TONE_BG;
  name: string;
  time: string;
  body: string;
  delay: number;
}) {
  return (
    <div className="flex animate-slide-up gap-2.5" style={rise(delay)}>
      <span
        className={cn(
          "mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-lg font-mono text-[10px] font-bold",
          TONE_BG[tone]
        )}
      >
        {initial}
      </span>
      <div className="min-w-0">
        <p className="flex items-baseline gap-1.5">
          <span className="text-xs font-bold text-fg">{name}</span>
          <span className="font-mono text-[9px] text-fg-muted">{time}</span>
        </p>
        <p className="mt-0.5 text-[13px] leading-snug text-fg-muted">{body}</p>
      </div>
    </div>
  );
}

function Dot({ delay }: { delay: string }) {
  return (
    <span
      className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-fg-muted"
      style={{ animationDelay: delay }}
    />
  );
}
