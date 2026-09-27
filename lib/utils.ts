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

export function formatDate(date: string | Date): string {
  return format(new Date(date), "MMM dd, yyyy");
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
