import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { format, formatDistanceToNow, isToday, isYesterday } from "date-fns";
import { currencyMinorUnits, sanitizeNumericOutput } from "@/lib/format";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCurrency(amount: number, currency = "PKR"): string {
  // Intl.NumberFormat handles PKR natively — the previous special case was
  // producing a subtly different glyph pattern from other currencies (custom
  // "PKR " prefix vs the CLDR-standard non-breaking-space output). Unifying
  // under one Intl path fixes audit row F12: currency rendering is now
  // consistent across every currency the workspace picks.
  //
  // ## Fraction digits are a DECISION, not a flag (money-001 / rep-001)
  //
  // This used to pass `maximumFractionDigits: 0` and nothing else, so no amount
  // anywhere in the product ever showed cents. That is not a style choice, it is
  // a correctness bug: the columns are `Decimal(12,2)`, so three 0.50 expenses
  // rendered "PKR 1" three times beside a total of "PKR 2" — visible rows that
  // do not add up to the visible total, on a screen a founder is reconciling
  // against a bank statement. The .xlsx export carried the true cents the whole
  // time, so one click produced two disagreeing ledgers.
  //
  // The scale now comes from `currencyMinorUnits` in lib/format.ts, which holds
  // the argument and the per-currency table (and fails typecheck if a currency
  // is added to SUPPORTED_CURRENCIES without deciding). Both min and max are set
  // from it: `minimumFractionDigits` is what keeps "PKR 1,234.50" from printing
  // as "PKR 1,234.5" and misaligning a tabular-nums column.
  //
  // If a cramped surface (a chart axis tick) wants short money, the answer is
  // `formatCompact` from lib/format.ts — NOT a fraction-digit override here.
  // Overriding here is how this bug happened.
  //
  // The `en-US` locale pin stays, deliberately: Latin digits and one consistent
  // grouping for every currency, so a figure copied out of FounderFlow pastes
  // into a bank portal or a spreadsheet. rep-001 read the pin as the defect; the
  // defect was the rounding above. See the argument in lib/format.ts.
  //
  // Post-processing:
  //  • Hard spaces (NBSP U+00A0, NARROW NBSP U+202F) → regular space so
  //    copy-paste, downstream tests and CSV exports don't have to know about
  //    them. Done via lib/format.ts's `sanitizeNumericOutput`, which builds its
  //    character class from code points; the version here was a regex with a
  //    real NBSP pasted inside it, one careless autofix away from silently
  //    becoming a no-op.
  //  • Negative CLDR output is "-PKR 12,345.00"; the previous inline format was
  //    "PKR -12,345". Reorder so we don't regress the user-facing look while
  //    keeping the one Intl call for grouping + currency-code lookup. Note this
  //    only fires for currencies CLDR prefixes with an ISO CODE (PKR, AED) —
  //    symbol currencies keep ICU's own "-$1,234.56", which is already the
  //    conventional placement for them.
  const digits = currencyMinorUnits(currency);
  const formatted = sanitizeNumericOutput(
    ((): string => {
      try {
        return new Intl.NumberFormat("en-US", {
          style: "currency",
          currency,
          minimumFractionDigits: digits,
          maximumFractionDigits: digits,
        }).format(amount);
      } catch {
        // Guard for the pathological case where the caller passes a non-ISO
        // 4217 code (e.g. a stale seed value). Fall back to a plain number —
        // still at the decided scale, because a bad currency code is no reason
        // to drop a customer's cents.
        return `${currency} ${new Intl.NumberFormat("en-US", {
          minimumFractionDigits: digits,
          maximumFractionDigits: digits,
        }).format(amount)}`;
      }
    })()
  );
  if (amount < 0 && formatted.startsWith(`-${currency}`)) {
    return `${currency} -${formatted.slice(currency.length + 1).trimStart()}`;
  }
  return formatted;
}

/**
 * A wall-clock instant, rendered in the RUNTIME's timezone.
 *
 * Right for a TIMESTAMP — `User.createdAt`, an invite's `expiresAt`, a billing
 * period end. Wrong for a DATE-ONLY value, and that distinction is not academic:
 * `Transaction.date` and `Task.deadline` come from `<input type="date">`, so
 * "2026-01-15" is stored as 2026-01-15T00:00:00.000Z, and rendering that in
 * Bogota (UTC-5) prints **Jan 14** — the day before the one the customer typed,
 * on every ledger row and in every export. Use `formatUtcDate` for those.
 *
 * Deliberately NOT switched to UTC wholesale: half its ~20 call sites are real
 * timestamps, and a member who joined at 8pm local on the 14th should not read
 * "Joined Jan 15". The two cases need two functions, which is why there are now
 * two. See lib/date-range.ts for the same argument applied to month buckets
 * (money-007).
 */
export function formatDate(date: string | Date): string {
  return format(new Date(date), "MMM dd, yyyy");
}

/* ------------------------------------------------------------------------- *
 * UTC date rendering, for DATE-ONLY values (money-007).
 *
 * The boundary decision itself lives in lib/date-range.ts — read that file
 * first; these are its rendering half, kept here next to `formatDate` so the
 * choice between local and UTC is made by picking a name at the call site
 * rather than by remembering a rule. date-fns is deliberately not used: every
 * date-fns formatter renders in the local calendar, which is the trap.
 *
 * Constructed once at module scope. `Intl.DateTimeFormat` construction is
 * expensive and the PDF exporter formats one date per ledger row.
 * ------------------------------------------------------------------------- */

/** `"MMM dd, yyyy"` in UTC — the twin of `formatDate`, same output shape. */
const UTC_DATE = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "2-digit",
  year: "numeric",
  timeZone: "UTC",
});

/** `"MMM yy"` in UTC — a chart bucket label. */
const UTC_MONTH_YEAR = new Intl.DateTimeFormat("en-US", {
  month: "short",
  year: "2-digit",
  timeZone: "UTC",
});

/**
 * The stored calendar day of a date-only value: `"Jan 15, 2026"`.
 *
 * ICU emits "Jan 15, 2026" for this option set, matching date-fns'
 * `"MMM dd, yyyy"` exactly, so swapping a call site changes the DAY when the
 * viewer is west of UTC and changes nothing else.
 */
export function formatUtcDate(date: string | Date): string {
  return UTC_DATE.format(new Date(date));
}

/**
 * `"2026-01-15"` — the ISO day, for a spreadsheet cell that must sort and be
 * re-parsed. Built from the UTC parts rather than `toISOString().slice(0, 10)`
 * only because the latter reads as an accident; it is the same value.
 */
export function formatUtcDay(date: string | Date): string {
  const d = new Date(date);
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${d.getUTCFullYear()}-${month}-${day}`;
}

/** `"Oct 26"` for a month bucket whose start is UTC midnight on the 1st. */
export function formatUtcMonthYear(date: string | Date): string {
  return UTC_MONTH_YEAR.format(new Date(date));
}

export function formatRelativeTime(date: string | Date): string {
  const d = new Date(date);
  if (isToday(d)) {
    return `Today at ${format(d, "h:mm a")}`;
  }
  if (isYesterday(d)) {
    return `Yesterday at ${format(d, "h:mm a")}`;
  }
  const distance = formatDistanceToNow(d, { addSuffix: true });
  return distance;
}

export function generateAvatar(name: string): string {
  const initials = name
    .split(" ")
    .map((n) => n[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return initials || "U";
}

export function getAvatarColor(name: string): string {
  const colors = [
    "from-pink-500 to-rose-500",
    "from-purple-500 to-indigo-500",
    "from-blue-500 to-cyan-500",
    "from-emerald-500 to-teal-500",
    "from-amber-500 to-orange-500",
    "from-red-500 to-pink-500",
    "from-violet-500 to-purple-500",
    "from-sky-500 to-blue-500",
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

export function downloadFile(content: string | Blob, filename: string, type = "text/plain") {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
