"use client";

/**
 * <RunwayCard> — the Runway snapshot rendered inside a message row.
 *
 * This is the component the landing page has been promising since day one:
 * components/landing/channel-panel.tsx answers "can we afford the contractor?"
 * with an inline runway card, and this is the real one. The vocabulary is
 * deliberately lifted from that mock and from components/landing/stat-card.tsx
 * — emerald hairline frame, `TrendingUp` eyebrow, big mono value with a small
 * uppercase caption underneath — so the thing a visitor was sold and the thing
 * a customer opens are recognisably the same object.
 *
 * ─── THIS COMPONENT NEVER DECIDES WHAT A VIEWER MAY SEE. ───
 *
 * `toMessageClient` in lib/queries/chat.ts already made that call, server-side,
 * before the DTO was serialized. When `redacted` is true the figures are not
 * "hidden" here — they are genuinely absent from the props, from the RSC
 * payload, and from the network tab. So there is nothing to blur, nothing to
 * mask, and no placeholder shaped like a number to draw. The only correct
 * response to `redacted` is a frame and a sentence. Do not add a `title`, an
 * `aria-label` or a tooltip that reconstructs a figure — there is no figure to
 * reconstruct, and inventing a hole where the query layer left none is the one
 * way this component can leak something.
 *
 * Three facts the card must keep apart, because conflating any two of them
 * tells the reader something false:
 *   • `card === null`       → the payload could not be read (corrupt, or a
 *                             version newer than this build). Say so; do not
 *                             guess at fields we have never seen.
 *   • `redacted === true`   → a permission fact about the READER.
 *   • `runwayMonths === null` → a data fact about the WORKSPACE: nothing has
 *                             been spent, so there is no burn to divide by.
 *                             `runwayMonths()` in lib/finance/runway.ts answers
 *                             null for that case here and on /dashboard alike,
 *                             because "∞ months" is not an answer anybody can
 *                             plan against.
 *
 * ─── "AS OF", NEVER "LIVE". ───
 *
 * The landing mock's eyebrow reads "Runway · live". The real card's must not.
 * A card is a SNAPSHOT frozen at post time (see lib/schemas/chat.ts) and it is
 * read months later, in threads people scroll back through when they are
 * deciding something. A stale number wearing the word "live" is a lie that
 * gets believed in a funding conversation, so every variant of this card —
 * including the redacted one, which has no figures at all — is stamped with
 * its `asOf` and nothing else.
 *
 * ─── CURRENCY COMES FROM THE CARD, NOT FROM THE WORKSPACE. ───
 *
 * `formatCurrency(amount, card.currency)` directly, deliberately NOT
 * `useMoney()`. `useMoney` binds to the workspace's CURRENT currency, which
 * would silently relabel every historical card the day a founder switches from
 * PKR to USD — same digits, new symbol, a card that now claims a number it
 * never held. The snapshot carries the currency it was denominated in and that
 * is what it renders in.
 */

import { useId } from "react";
import { EyeOff, FileQuestion, TrendingUp, type LucideIcon } from "lucide-react";
import { format } from "date-fns";
import type { RunwayCardClient } from "@/lib/queries/chat";
import { cn, formatCurrency } from "@/lib/utils";

type Props = {
  /** The viewer-resolved card, or null when its payload could not be read. */
  card: RunwayCardClient | null;
  className?: string;
};

/**
 * `asOf` → the three forms the stamp needs, with an explicit guard for a value
 * that is not a date.
 *
 * `RunwayPayloadSchema` already enforces `z.string().datetime()`, so this
 * cannot fire today — but `format()` from date-fns THROWS a RangeError on an
 * Invalid Date, and a throw inside one message row unmounts the entire channel
 * for everyone in it. The query layer bends over backwards to make a single bad
 * row degrade quietly (see `parseMentions` and `toCardFields`); a renderer that
 * turns that same bad row into a white screen would undo all of it for the cost
 * of one branch.
 */
function stampFor(asOf: string): { machine?: string; short: string; absolute?: string } {
  const d = new Date(asOf);
  if (Number.isNaN(d.getTime())) return { short: "an unrecorded time" };
  return {
    machine: d.toISOString(),
    // "25 Sep, 03:40" — day + month because a card outlives the day it was
    // posted, clock time because two cards on one day must be tellable apart.
    short: format(d, "d MMM, HH:mm"),
    absolute: d.toLocaleString(),
  };
}

/** Rounded to one decimal, with the trailing ".0" dropped: 11.0 → "11". */
function trimMonths(months: number): string {
  return (Math.round(months * 10) / 10).toFixed(1).replace(/\.0$/, "");
}

/**
 * `runwayMonths` → the words that go in the headline.
 *
 * Every branch here returns WORDS, never a bare glyph, because three of the
 * four cases have no number to show and the fourth still needs its unit spoken:
 * a headline reading "11.4" on its own is a figure without a noun, and a
 * screen reader hands it over as "eleven point four" attached to nothing.
 *
 * Negative runway is its own branch. `cashOnHand` is allowed to be negative on
 * purpose (a workspace can have spent more than it raised), which makes
 * `runwayMonths` negative too — and "−3.1 months" is both unreadable as a
 * duration and easy to skim as a delta rather than a total. "Out of runway" is
 * the honest reading, and the balance below still shows exactly how far under.
 *
 * Under a month is folded into words as well: `trimMonths(0.04)` is "0", and a
 * card announcing "0 months" to a workspace that has three weeks left is worse
 * than no card.
 */
function headlineFor(months: number | null): { value: string; note: string | null } {
  if (months === null || !Number.isFinite(months)) {
    return {
      value: "No burn recorded",
      note: "Nothing was spent in the three months before this snapshot, so there was no burn rate to divide the balance by.",
    };
  }
  if (months <= 0) {
    return {
      value: "Out of runway",
      note: "The balance was at or below zero when this snapshot was taken.",
    };
  }
  if (months < 1) {
    return { value: "Under a month", note: null };
  }
  const text = trimMonths(months);
  return { value: `${text} ${text === "1" ? "month" : "months"}`, note: null };
}

/**
 * Shared chrome for all three variants, so the frame, the eyebrow and the
 * stamp are written once. A redacted card that drifted into looking like a
 * different kind of object would tell the reader the message itself was
 * different, rather than that their access was.
 */
function CardFrame({
  headingId,
  icon: Icon,
  asOf,
  tone,
  className,
  children,
}: {
  headingId: string;
  icon: LucideIcon;
  /** null on the unreadable variant — there is no payload to have read it from. */
  asOf: string | null;
  tone: "figures" | "muted";
  className?: string;
  children: React.ReactNode;
}) {
  const stamp = asOf === null ? null : stampFor(asOf);
  const accent = tone === "figures" ? "text-primary-strong" : "text-fg-muted";

  return (
    // `aria-labelledby` rather than a bare <section>: an unnamed section is
    // exposed as a generic container, so the card would arrive as a loose pile
    // of numbers. Named, it announces "Runway snapshot, as of 25 Sep, 03:40"
    // on entry — which is the whole reason the stamp is in the heading and not
    // parked in a corner as a detached fragment.
    <section
      aria-labelledby={headingId}
      className={cn(
        "max-w-md rounded-xl border p-3",
        tone === "figures"
          ? "border-primary/30 bg-primary/[0.07]"
          : "border-dashed border-border bg-surface/60",
        className
      )}
    >
      <h2 id={headingId} className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
        <Icon className={cn("h-3 w-3 shrink-0", accent)} aria-hidden="true" />
        <span className={cn("font-mono text-[9px] font-bold uppercase tracking-[0.18em]", accent)}>
          Runway snapshot
        </span>
        {stamp && (
          <>
            <span aria-hidden="true" className="text-[9px] text-fg-muted/50">
              ·
            </span>
            <time
              dateTime={stamp.machine}
              title={stamp.absolute}
              className="font-mono text-[9px] uppercase tracking-[0.14em] text-fg-muted"
            >
              as of {stamp.short}
            </time>
          </>
        )}
      </h2>
      {children}
    </section>
  );
}

/** One figure: value on top, caption under it, in the mock's vocabulary. */
function Figure({ label, value }: { label: string; value: string }) {
  return (
    // `flex-col-reverse` so the DOM stays <dt> then <dd> — a screen reader
    // reads "Cash on hand: PKR 547,000" — while the eye still gets the big
    // number first and the small caption second, as StatCard does.
    <div className="flex min-w-0 flex-col-reverse">
      <dt className="mt-1 font-mono text-[9px] uppercase tracking-widest text-fg-muted">{label}</dt>
      {/* Wraps rather than truncates. A clipped label is cosmetic; a clipped
          figure is a DIFFERENT figure — "PKR 1,234,5…" reads as a real number
          to anyone skimming, and this card exists to be skimmed. */}
      <dd className="break-words font-mono text-sm font-bold leading-tight text-fg">{value}</dd>
    </div>
  );
}

export function RunwayCard({ card, className }: Props) {
  const headingId = useId();

  // Unreadable: corrupt JSON, the wrong shape, or a payload version this build
  // has never seen. The query layer refuses to half-render a future card rather
  // than letting a reader guess which field is money and which is months, and
  // the only useful thing to say here is that there IS a card and it is not
  // readable — dropping the frame would quietly rewrite the conversation.
  if (card === null) {
    return (
      <CardFrame
        headingId={headingId}
        icon={FileQuestion}
        asOf={null}
        tone="muted"
        className={className}
      >
        <p className="mt-2 text-[13px] leading-snug text-fg-muted">
          This card can&apos;t be displayed. It was posted in a format this version of the app
          doesn&apos;t know how to read — reloading may pick up a newer build.
        </p>
      </CardFrame>
    );
  }

  // Redacted: a fact about the READER, not about the workspace or the card.
  // The figures are absent from `card` entirely, so this branch has nothing to
  // withhold and nothing to blur — it says who can see them and stops.
  if (card.redacted) {
    return (
      <CardFrame
        headingId={headingId}
        icon={EyeOff}
        asOf={card.asOf}
        tone="muted"
        className={className}
      >
        <p className="mt-2 text-[13px] leading-snug text-fg-muted">
          The figures on this snapshot are visible to admins and co-founders only. Everything else
          in this conversation is unchanged.
        </p>
      </CardFrame>
    );
  }

  const headline = headlineFor(card.runwayMonths);
  // `cashOnHand` / `monthlyBurn` are typed nullable because the SAME interface
  // carries the redacted card, where they are null. Past the guard above they
  // are always numbers — but the type does not know that, and an em dash is a
  // better answer than "NaN" if the shape ever drifts.
  const money = (amount: number | null): string =>
    amount === null || !Number.isFinite(amount) ? "—" : formatCurrency(amount, card.currency);

  return (
    <CardFrame
      headingId={headingId}
      icon={TrendingUp}
      asOf={card.asOf}
      tone="figures"
      className={className}
    >
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2.5">
        <div className="col-span-2 flex flex-col-reverse">
          <dt className="mt-1 font-mono text-[9px] uppercase tracking-widest text-fg-muted">
            Runway
          </dt>
          <dd className="font-mono text-xl font-bold leading-tight text-fg">{headline.value}</dd>
        </div>
        <Figure label="Cash on hand" value={money(card.cashOnHand)} />
        <Figure label="Burn / month" value={money(card.monthlyBurn)} />
      </dl>

      {headline.note && (
        <p className="mt-2.5 text-[11px] leading-snug text-fg-muted">{headline.note}</p>
      )}
    </CardFrame>
  );
}
