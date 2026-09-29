import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { isToday, isYesterday } from "date-fns";
import { currencyMinorUnits, sanitizeNumericOutput } from "@/lib/format";
import { numberingLocale } from "@/lib/i18n/numbering";
import type { Locale } from "@/lib/i18n/strings";

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

/* ------------------------------------------------------------------------- *
 * Money inside a string that outlives the render (money-001, persisted half).
 * ------------------------------------------------------------------------- */

/**
 * A grouped, fixed-scale amount for a string this app PERSISTS or MAILS:
 * `1234.5` -> `"1,234.50"`. No currency code — the sentence supplies that.
 *
 * WHAT IT REPLACES. `amount.toLocaleString()`, interpolated into three strings
 * in lib/actions/transactions.ts that are written once and then read by every
 * member of the workspace forever: the activity-log `message`, the notification
 * body (which leaves the app as an email subject and a lock-screen push), and
 * the delete entry. Two faults in one call:
 *
 *  1. NOT DETERMINISTIC. `Number.prototype.toLocaleString()` with no locale
 *     resolves to the RUNTIME's default, which on a server is ambient
 *     environment — LANG / LC_ALL / whatever the container image sets — not a
 *     product decision. In a de-DE container `1234.5` is persisted as
 *     `"1.234,5"`, a decimal comma and dot grouping, directly beside the
 *     literal code "PKR", in a customer's audit trail and in their inbox.
 *
 *  2. FLOATING SCALE. `toLocaleString()` defaults to `maximumFractionDigits: 3`
 *     with no minimum, so one workspace's history holds "1,234", "1,234.5" and
 *     "1,234.56" for amounts the columns all store at scale 2 — and "1,234.5"
 *     sits in the feed while `formatCurrency` renders the same row as
 *     "PKR 1,234.50" a panel away. Cents appear or vanish depending only on
 *     whether they happen to be zero.
 *
 * WHY NOT `formatNumber` FROM lib/format.ts. That one takes the VIEWER's locale,
 * and lib/format.ts explains why these strings must not have one: a row written
 * once is read by everybody, so there is no single viewer whose locale applies,
 * and localising only the digits of an English sentence half-translates it. The
 * answer is not "no locale" (that is the bug) but "the prose locale", pinned
 * here the same way `formatCurrency` pins it and for the same reason: a figure
 * copied out of FounderFlow should paste into a bank portal or a spreadsheet.
 *
 * The scale comes from `currencyMinorUnits`, so a zero-decimal currency does not
 * gain phantom cents, and the output goes through `sanitizeNumericOutput` so no
 * NBSP is baked into a stored row.
 */
const MESSAGE_AMOUNT_CACHE = new Map<number, Intl.NumberFormat>();

export function formatAmountForMessage(amount: number, currency: string): string {
  const digits = currencyMinorUnits(currency);
  let fmt = MESSAGE_AMOUNT_CACHE.get(digits);
  if (!fmt) {
    fmt = new Intl.NumberFormat("en-US", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
    MESSAGE_AMOUNT_CACHE.set(digits, fmt);
  }
  return sanitizeNumericOutput(fmt.format(amount));
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
 *
 * ## The locale argument (i18n-004)
 *
 * This used to be `format(d, "MMM dd, yyyy")` with no date-fns `locale` option,
 * so the month name came from date-fns' built-in English locale and an Urdu
 * workspace read "Sep 26, 2026" on every translated screen. It now routes
 * through `Intl`, which already knows Urdu, via `numberingLocale()` so the
 * DIGIT family stays the one lib/i18n/numbering.ts argues for (`latn`) rather
 * than whatever CLDR defaults to for a locale added later.
 *
 * NOT date-fns' own `locale` option, and not by preference: date-fns 3.6.0
 * ships 180-odd locales and `ur` is not among them (it has `ar`, `ar-*`, `hi`,
 * `fa-IR` — no Urdu at all). There was no version of this fix that stayed on
 * date-fns. `Intl` is also where the numbering-system pin already lives, so the
 * digit decision keeps its one address.
 *
 * `locale` is OPTIONAL and defaults to English, and that is a decision rather
 * than convenience:
 *
 *  • There is no server-reachable locale. Every rendering call site is a client
 *    component reading the Zustand store (`useLocale()`); the ONE server caller
 *    is lib/billing/billing-notify.ts, which feeds `formatDate` into
 *    lib/billing/plan.ts to build a string that is PERSISTED and mailed. That is
 *    the `formatAmountForMessage` case above, word for word: a row written once
 *    and read by everybody has no single viewer whose locale applies, and
 *    localising the date inside an English sentence half-translates it. It must
 *    keep getting English, so English is what an un-passed locale means.
 *  • A required parameter would have made every one of those call sites a
 *    compile error at once, in a shared tree, which is how the wrong one gets
 *    "fixed" by passing `"en"` to silence it.
 *
 * `en` output is byte-identical to the date-fns pattern it replaces —
 * `formatUtcDate` below has asserted that equivalence since money-007, and
 * tests/lib/utils.test.ts holds the two against each other.
 */
export function formatDate(date: string | Date, locale: Locale = "en"): string {
  return dateFormatter(locale).format(new Date(date));
}

/* ------------------------------------------------------------------------- *
 * Locale-aware date/time machinery (i18n-004).
 *
 * `Intl.*Format` construction is expensive and these render once per ledger
 * row, notification and activity entry, so every formatter is built once per
 * locale and cached. Keyed by `Locale`, not by tag string, because the tag is
 * derived and the locale is the input.
 * ------------------------------------------------------------------------- */

const DATE_FORMATTERS = new Map<Locale, Intl.DateTimeFormat>();
const TIME_FORMATTERS = new Map<Locale, Intl.DateTimeFormat>();
const NAMED_DAY_FORMATTERS = new Map<Locale, Intl.RelativeTimeFormat>();
const DISTANCE_FORMATTERS = new Map<Locale, Intl.RelativeTimeFormat>();

function dateFormatter(locale: Locale): Intl.DateTimeFormat {
  let fmt = DATE_FORMATTERS.get(locale);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(numberingLocale(locale), {
      month: "short",
      day: "2-digit",
      year: "numeric",
    });
    DATE_FORMATTERS.set(locale, fmt);
  }
  return fmt;
}

function timeFormatter(locale: Locale): Intl.DateTimeFormat {
  let fmt = TIME_FORMATTERS.get(locale);
  if (!fmt) {
    // No `hour12` override. CLDR's `ur` data is 12-hour with AM/PM markers,
    // which is what Pakistani software shows; forcing `hour12: false` here
    // would be this file overruling the locale data on the strength of nobody's
    // research. If a 24-hour clock is wanted it is a product preference and
    // belongs beside the theme and language pickers, not hardcoded here.
    fmt = new Intl.DateTimeFormat(numberingLocale(locale), {
      hour: "numeric",
      minute: "2-digit",
    });
    TIME_FORMATTERS.set(locale, fmt);
  }
  return fmt;
}

/** `numeric: "auto"` — the only setting that turns 0 and -1 days into words. */
function namedDayFormatter(locale: Locale): Intl.RelativeTimeFormat {
  let fmt = NAMED_DAY_FORMATTERS.get(locale);
  if (!fmt) {
    fmt = new Intl.RelativeTimeFormat(numberingLocale(locale), { numeric: "auto" });
    NAMED_DAY_FORMATTERS.set(locale, fmt);
  }
  return fmt;
}

/**
 * `numeric: "always"` — the distance branch must never emit a bare "yesterday",
 * because the today/yesterday branch above pairs that word with a clock time and
 * this one does not. Rounding 30-odd hours down to -1 day would otherwise print
 * a word the reader has been taught carries a time.
 */
function distanceFormatter(locale: Locale): Intl.RelativeTimeFormat {
  let fmt = DISTANCE_FORMATTERS.get(locale);
  if (!fmt) {
    fmt = new Intl.RelativeTimeFormat(numberingLocale(locale), { numeric: "always" });
    DISTANCE_FORMATTERS.set(locale, fmt);
  }
  return fmt;
}

/**
 * How a named day and a clock time are joined: `"Today at 3:45 PM"`.
 *
 * THE ONLY HAND-WRITTEN PER-LOCALE THING IN THIS FILE, AND IT CONTAINS NO
 * TRANSLATED WORDS. Everything the reader actually sees — the month name, the
 * word for "today", "10 days ago", the AM/PM marker — comes from ICU/CLDR, so
 * no unverified translation is shipped by this module. What ICU does not expose
 * is a pattern combining a RELATIVE day with a time; `Intl` has no such API, so
 * the join has to be made here.
 *
 * CLDR's own date-time glue is reachable (`{dateStyle, timeStyle}` +
 * `formatToParts` yields " at " for `en` and " کو " for `ur`) and using it was
 * the obvious move — but it is wrong for this input. Urdu's "کو" is a
 * postposition that attaches to a DATE ("پیر کو" — on Monday); "آج" is already
 * adverbial and takes none, so "آج کو 3:45 PM" is not a sentence. CLDR is
 * right about joining a full date to a time and simply is not being asked that
 * question here. Urdu therefore juxtaposes, which is the idiomatic form.
 *
 * `Record<Locale, …>` on purpose, the same shape and for the same reason as
 * `NUMBERING_SYSTEMS` in lib/i18n/numbering.ts: adding a locale without
 * deciding this fails `npm run typecheck` at the decision instead of silently
 * inheriting English's " at ".
 */
const NAMED_DAY_AT_TIME: Record<Locale, string> = {
  en: "{day} at {time}",
  ur: "{day} {time}",
};

/** Sentence case for the CLDR day word. A no-op in scripts without case. */
function capitalizeForLocale(word: string, locale: Locale): string {
  if (!word) return word;
  return word.charAt(0).toLocaleUpperCase(locale) + word.slice(1);
}

function namedDayAtTime(d: Date, locale: Locale, dayOffset: number): string {
  const day = capitalizeForLocale(namedDayFormatter(locale).format(dayOffset, "day"), locale);
  return NAMED_DAY_AT_TIME[locale]
    .replace("{day}", day)
    .replace("{time}", timeFormatter(locale).format(d));
}

/**
 * Coarsest-first unit ladder for the distance branch.
 *
 * Weeks are deliberately absent: date-fns' `formatDistanceToNow`, which this
 * replaces, says "10 days ago" rather than "1 week ago", and the notification
 * and activity feeds have shipped that wording for months. Including "week"
 * would have been a silent copy change dressed as an i18n fix.
 */
const RELATIVE_LADDER: { unit: Intl.RelativeTimeFormatUnit; ms: number }[] = [
  { unit: "year", ms: 365 * 24 * 60 * 60 * 1000 },
  { unit: "month", ms: 30 * 24 * 60 * 60 * 1000 },
  { unit: "day", ms: 24 * 60 * 60 * 1000 },
  { unit: "hour", ms: 60 * 60 * 1000 },
  { unit: "minute", ms: 60 * 1000 },
];

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

/**
 * A timestamp as a human would say it: `"Today at 3:45 PM"`, `"10 days ago"`.
 *
 * ## What it used to be, and why that was the bug (i18n-004)
 *
 * Two hardcoded English templates and `formatDistanceToNow(d, { addSuffix:
 * true })`, which also has no locale option wired. The notifications dropdown,
 * the activity feed, chat, comments and /team therefore read English on a fully
 * translated Urdu screen.
 *
 * Every visible token now comes from ICU: `Intl.RelativeTimeFormat` for the
 * word, `Intl.DateTimeFormat` for the clock. `locale` defaults to English for
 * the reasons set out on `formatDate` above — there is no server-reachable
 * locale, and the one server caller persists its output.
 *
 * `isToday` / `isYesterday` stay date-fns: they are CALENDAR predicates in the
 * viewer's zone, which is the right question ("is this the same day the reader
 * is having?") and has no locale in it. Only the WORDS were ever the problem.
 */
export function formatRelativeTime(date: string | Date, locale: Locale = "en"): string {
  const d = new Date(date);
  if (isToday(d)) {
    return namedDayAtTime(d, locale, 0);
  }
  if (isYesterday(d)) {
    return namedDayAtTime(d, locale, -1);
  }

  // Signed, so a future timestamp (an invite's expiry, a renewal date) reads
  // "in 3 days" instead of silently rendering as though it had already passed.
  const diff = d.getTime() - Date.now();
  const magnitude = Math.abs(diff);
  const fmt = distanceFormatter(locale);
  // Indexed loop rather than for…of / .find(): tsconfig sets `lib` but no
  // `target`, so tsc emits ES5 and the fancier forms are this repo's standing
  // trap (see CLAUDE.md).
  for (let i = 0; i < RELATIVE_LADDER.length; i++) {
    const step = RELATIVE_LADDER[i];
    if (magnitude >= step.ms) {
      return fmt.format(Math.round(diff / step.ms), step.unit);
    }
  }
  return fmt.format(Math.round(diff / 1000), "second");
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
