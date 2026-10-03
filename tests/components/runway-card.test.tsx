/**
 * <RunwayCard> — the one component in chat that renders the company balance.
 *
 * The security test below (`renders the frame with no figures when the viewer
 * cannot see finances`) is the reason this file exists. Everything else here
 * is scaffolding that keeps that test honest: a redaction assertion passes
 * vacuously against a card that renders nothing at all, so the converse case
 * uses the SAME scanner to prove the scanner can find a figure when one is
 * there.
 *
 * No mocks. The card takes a viewer-resolved DTO and calls `formatCurrency`;
 * there is no action, no fetch and no Prisma behind it, and stubbing the
 * formatter would mean testing a card nobody ships.
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { RunwayCard } from "@/components/chat/runway-card";
import type { RunwayCardClient } from "@/lib/queries/chat";
import { formatCurrency } from "@/lib/utils";

const CURRENCY = "PKR";

/**
 * The instant every fixture is stamped with. Note the assertions below never
 * compare a RENDERED clock — `format()` in the component works in local time
 * and CI pins no `TZ`, so an expectation like "25 Sep, 03:40" either passes
 * for the wrong reason or fails on a laptop in Karachi. The machine-readable
 * `dateTime` attribute is the timezone-independent thing to assert against,
 * and it is what a screen reader and every downstream parser actually read.
 */
const AS_OF = "2026-09-25T03:40:00.000Z";

/**
 * The figures, in ONE place, so the redaction test can derive what it hunts
 * for from the fixture rather than from a hand-copied literal that drifts the
 * first time somebody edits a number here.
 *
 * Deliberately long and unmistakable: a seven-digit balance cannot collide by
 * accident with a clock, a day-of-month or a version number in the scans
 * below.
 */
const FIGURES = {
  cashOnHand: 5_471_390,
  monthlyBurn: 482_700,
  runwayMonths: 11.4,
} as const;

const VISIBLE: RunwayCardClient = {
  asOf: AS_OF,
  currency: CURRENCY,
  runwayMonths: FIGURES.runwayMonths,
  cashOnHand: FIGURES.cashOnHand,
  monthlyBurn: FIGURES.monthlyBurn,
  redacted: false,
};

/**
 * What `toMessageClient` actually hands a member: the frame's facts, and null
 * in every figure slot. The figures are absent from the DTO, not hidden in it
 * — which is the property the test below re-checks at the DOM, because that
 * server-side guarantee is worth nothing if the component reconstructs a
 * figure into an attribute on its way out.
 */
const REDACTED: RunwayCardClient = {
  asOf: AS_OF,
  currency: CURRENCY,
  runwayMonths: null,
  cashOnHand: null,
  monthlyBurn: null,
  redacted: true,
};

/** A workspace that has raised money and spent none of it yet. */
const NO_BURN: RunwayCardClient = {
  asOf: AS_OF,
  currency: CURRENCY,
  runwayMonths: null,
  cashOnHand: FIGURES.cashOnHand,
  monthlyBurn: 0,
  redacted: false,
};

describe("RunwayCard (the company balance, rendered inside a message row)", () => {
  // ───────────────────────────────────────────────────────────────────
  // THE TEST THAT MATTERS.
  //
  // Every other test in this file is about whether the card READS well. This
  // one is about whether a member can read the company's cash position out of
  // a public channel, and it is the only test standing between that and a
  // shipped build.
  //
  // It asserts against text and attributes — NOT against visibility, NOT
  // against a class name. That choice is the whole test. The plausible way
  // this breaks is somebody in a hurry implementing redaction in the
  // component: render the figures, add `hidden`, or `sr-only`, or
  // `text-transparent`, or a blur. Every one of those passes a
  // `toBeVisible()` check and every one of them leaves "PKR 5,471,390" sitting
  // in the page source, in the RSC payload, and in the accessibility tree — a
  // right-click away from the person it was withheld from. A redacted figure
  // that is merely invisible is not redacted.
  //
  // If this test fails, do not reach for a different matcher. The figures are
  // reaching the DOM, and either the component started rendering
  // `card.cashOnHand` before checking `card.redacted`, or the query layer
  // stopped nulling the fields — see `toMessageClient` in lib/queries/chat.ts.
  // ───────────────────────────────────────────────────────────────────
  it("renders the frame with no figures when the viewer cannot see finances", () => {
    const { container } = render(<RunwayCard card={REDACTED} />);

    // The card is still THERE. Redaction is a fact about the reader, not a
    // reason to rewrite the conversation by dropping the message.
    expect(screen.getByRole("region", { name: /runway snapshot/i })).toBeInTheDocument();
    expect(screen.getByText(/visible to admins and co-founders only/i)).toBeInTheDocument();

    // 1. No figure survives into the rendered text, in either spelling.
    //    `figureSpellings` is derived from FIGURES, so adding a figure to the
    //    fixture widens this scan instead of quietly skipping it.
    const text = container.textContent ?? "";
    for (const spelling of figureSpellings()) {
      expect(text).not.toContain(spelling);
    }

    // 2. The formatting-agnostic backstop: collapse the render to bare digits
    //    and look for each figure's digits. This catches a leak dressed in a
    //    spelling nobody anticipated — a raw `toLocaleString()`, a different
    //    separator, a figure split across two spans.
    //
    //    The snapshot stamp is excluded because it is deliberately present on
    //    EVERY variant of this card, including this one — its digits are the
    //    one legitimate run of numbers here, and leaving them in would make
    //    the scan depend on the machine's timezone. A figure smuggled into the
    //    stamp is still caught, by scan 1 above, which reads the whole card.
    const digits = digitsIn(textWithoutStamp(container));
    for (const figure of Object.values(FIGURES)) {
      expect(digits).not.toContain(digitsOf(figure));
    }

    // 3. No attribute carries a figure either. This is the half a text-only
    //    assertion misses: `title="PKR 5,471,390"` renders nothing and tells
    //    the browser's tooltip, the accessibility tree and View Source
    //    everything. The component's doc comment forbids reconstructing a
    //    figure into an attribute precisely because there is no legitimate
    //    reason to, so any hit here is a leak.
    for (const { element, name, value, isStamp } of scannedAttributes(container)) {
      const where = `<${element.tagName.toLowerCase()} ${name}>`;

      // The stamp's tooltip is the one attribute here that legitimately holds
      // a run of digits. It is asserted EXACTLY rather than scanned, which is
      // the stronger check anyway — "this attribute is the snapshot instant
      // and nothing else" — and it keeps the scan off `toLocaleString()`,
      // whose separators are the machine's locale's business. A digit scan
      // over it would fail on a machine that renders "11.40" for a clock.
      if (isStamp) {
        expect(value, `${where} should be the snapshot instant and nothing else`).toBe(
          new Date(AS_OF).toLocaleString()
        );
        continue;
      }

      for (const spelling of figureSpellings()) {
        expect(value, `${where} carries a redacted figure`).not.toContain(spelling);
      }
      for (const figure of Object.values(FIGURES)) {
        expect(digitsIn(value), `${where} carries a redacted figure`).not.toContain(
          digitsOf(figure)
        );
      }
    }
  });

  // The converse. Without it the test above would pass just as happily
  // against a component that rendered an empty <div> for every viewer — the
  // classic way a security assertion rots into a tautology. This one proves
  // the same scanner finds the same figures when the viewer is allowed them.
  it("shows the figures to a viewer who may see finances", () => {
    const { container } = render(<RunwayCard card={VISIBLE} />);

    expect(figureFor(container, "Cash on hand")).toBe(formatCurrency(FIGURES.cashOnHand, CURRENCY));
    expect(figureFor(container, "Burn / month")).toBe(
      formatCurrency(FIGURES.monthlyBurn, CURRENCY)
    );
    // A number with its unit spoken, not a bare glyph — "11.4" alone is a
    // figure attached to no noun.
    expect(figureFor(container, "Runway")).toBe("11.4 months");

    // The scanner, pointed the other way.
    const digits = digitsIn(textWithoutStamp(container));
    for (const figure of Object.values(FIGURES)) {
      expect(digits).toContain(digitsOf(figure));
    }
  });

  // The landing mock's eyebrow reads "Runway · live". The real card's must
  // not: it is a snapshot frozen at post time and read months later, in the
  // threads people scroll back through when they are deciding something. A
  // stale number wearing the word "live" is a lie that gets believed in a
  // funding conversation.
  it("labels the card with when it was taken, not as live", () => {
    // Both carded variants, because the redacted one has no figures and is
    // therefore the easiest place for the stamp to be quietly dropped.
    for (const card of [VISIBLE, REDACTED]) {
      const { container, unmount } = render(<RunwayCard card={card} />);

      const stamp = container.querySelector("time");
      expect(stamp).not.toBeNull();
      // The machine-readable instant, not the rendered clock: `format()` works
      // in local time and CI pins no TZ, so asserting "25 Sep, 03:40" would
      // pass or fail on the machine's offset rather than on the code.
      expect(stamp).toHaveAttribute("dateTime", AS_OF);
      expect(stamp?.textContent ?? "").toMatch(/^as of \S/);

      // The stamp belongs to the card's accessible name, so the card
      // announces when it was taken on entry rather than parking the date in
      // a detached fragment a screen-reader user never reaches.
      expect(screen.getByRole("region", { name: /runway snapshot.*as of/i })).toBeInTheDocument();

      expect(container.textContent ?? "").not.toMatch(/\blive\b/i);

      unmount();
    }
  });

  // `runwayMonths: null` is a fact about the WORKSPACE — nothing was spent, so
  // there is no burn to divide by, and `runwayMonths()` answers null for that on
  // every surface (lib/finance/runway.ts). Neither "∞ months" nor "0 months" is
  // something a founder can plan against: the first is not an answer and the
  // second is a lie in the dangerous direction.
  it("renders a workspace with no burn as words rather than a number", () => {
    const { container } = render(<RunwayCard card={NO_BURN} />);

    const runway = figureFor(container, "Runway");
    expect(runway).toBe("No burn recorded");
    expect(runway).not.toMatch(/\d/);

    const text = container.textContent ?? "";
    expect(text).not.toMatch(/∞|Infinity|NaN/);
    expect(text).not.toMatch(/\b0 months\b/);
    // The sentence that explains WHY there is no figure, so the reader does
    // not read absence as an error.
    expect(screen.getByText(/nothing was spent in the three months/i)).toBeInTheDocument();

    // And the balance is still on the card — "no burn" withholds the ratio,
    // not the money.
    expect(figureFor(container, "Cash on hand")).toBe(formatCurrency(FIGURES.cashOnHand, CURRENCY));
  });
});

/* ── Scanners ──────────────────────────────────────────────────────────── */

/**
 * Every spelling of every fixture figure that could plausibly reach a reader:
 * the bare number a careless `data-` attribute would hold, and the exact
 * string the component would have produced had it rendered the figure.
 *
 * `formatCurrency` is imported rather than re-implemented on purpose — a
 * hand-written "PKR 5,471,390" here would stop matching the day the formatter
 * changes its separator or its non-breaking space, and the scan would go
 * silently blind.
 *
 * The digits-only spelling is deliberately NOT in this list. It belongs to the
 * digit scan, which strips the snapshot stamp first; folded in here it would
 * mean hunting for a three-character string like "114" inside a rendered
 * clock, which is how a security test turns into a flake that somebody
 * eventually deletes.
 */
function figureSpellings(): string[] {
  const out: string[] = [];
  for (const figure of Object.values(FIGURES)) {
    out.push(String(figure), formatCurrency(figure, CURRENCY));
  }
  return out;
}

/** Digits only — "PKR 5,471,390" → "5471390". */
function digitsIn(text: string): string {
  return text.replace(/[^0-9]/g, "");
}

/** A number's digits, sign and decimal point discarded: 11.4 → "114". */
function digitsOf(figure: number): string {
  return digitsIn(String(Math.abs(figure)));
}

/**
 * The card's text with the `<time>` stamp removed. See the comment at scan 2
 * for why the stamp is the one run of digits that is not a leak.
 */
function textWithoutStamp(container: HTMLElement): string {
  const clone = container.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("time").forEach((node) => node.remove());
  return clone.textContent ?? "";
}

/**
 * Every `aria-label`, `title` and `data-*` on every element in the card.
 *
 * These three because they are the attributes that carry PROSE to a human or
 * an assistive technology — the places a figure could be parked and still be
 * read out, copied or viewed in source. `class` is excluded (it is not a
 * channel for a number) and so is `dateTime`, which is the stamp's own
 * machine-readable instant and is asserted directly in its own test.
 *
 * `isStamp` marks the snapshot tooltip so the caller can assert it exactly
 * instead of scanning it — see the comment at the call site.
 */
function scannedAttributes(
  container: HTMLElement
): Array<{ element: Element; name: string; value: string; isStamp: boolean }> {
  const found: Array<{ element: Element; name: string; value: string; isStamp: boolean }> = [];
  for (const element of Array.from(container.querySelectorAll("*"))) {
    for (const attr of Array.from(element.attributes)) {
      const name = attr.name.toLowerCase();
      if (name === "aria-label" || name === "title" || name.startsWith("data-")) {
        found.push({
          element,
          name,
          value: attr.value,
          isStamp: element.tagName === "TIME" && name === "title",
        });
      }
    }
  }
  return found;
}

/**
 * The rendered value sitting under a given caption — `figureFor(c, "Cash on
 * hand")`. The card lays each pair out as `<dt>` then `<dd>` inside one
 * wrapper (visually reversed with `flex-col-reverse` so the eye gets the
 * number first), which is what makes the pairing readable to a screen reader
 * and findable here.
 */
function figureFor(container: HTMLElement, label: string): string {
  const term = Array.from(container.querySelectorAll("dt")).find(
    (node) => node.textContent?.trim() === label
  );
  return term?.parentElement?.querySelector("dd")?.textContent?.trim() ?? "";
}
