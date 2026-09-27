/**
 * Locale-aware number formatting, and the home of two numeric decisions:
 * FaultsAudit S19's numbering system (which digits) and money scale (how many
 * decimal places we show and accept).
 *
 * Digit shape routes through `lib/i18n/numbering.ts`, which argues WHY every
 * locale is pinned to Latin digits. Read that file before changing anything in
 * the locale half of this one; the interesting decision lives there, the
 * plumbing lives here. The money-scale decision lives at the bottom of THIS
 * file, next to the traps it exists to close.
 *
 * ## Why a module instead of `Intl.NumberFormat` at each call site
 *
 * Numbers reach the screen from ~20 places (chart ticks, percentage pills,
 * `{rows.length}` counts). Sprinkling `Intl.NumberFormat(locale)` across them
 * puts the numbering-system choice in twenty files, which means the twenty-first
 * call site gets it wrong and nobody notices until a screenshot shows 999 next
 * to ۹۹۹. One helper, one decision, one place to re-decide it.
 *
 * ## Money: the function is elsewhere, the decision is here
 *
 * An earlier version of this comment said "money is deliberately NOT here", and
 * that turned out to be the sentence that let money-001 live for months: with no
 * address for the money-scale decision, `maximumFractionDigits: 0` sat inline in
 * `lib/utils.ts` and nobody ever re-read it as a decision. So the split is now
 * explicit.
 *
 * `formatCurrency` (lib/utils.ts) and the `useMoney()` hook stay where they are —
 * 48 call sites import them from there, and moving the symbol buys nothing. What
 * moved here is the part worth arguing about: `MONEY_MINOR_UNITS` (how many
 * decimals each workspace currency renders) and `STORED_MONEY_SCALE` /
 * `isStorableMoneyScale` (how many the `Decimal(12,2)` columns can actually
 * hold). Display scale and storage scale are the same number on purpose; see the
 * argument at `MONEY_MINOR_UNITS`.
 *
 * The `en-US` LOCALE pin in `formatCurrency` is a separate, still-valid
 * decision: it is already Latin digits, already consistent with the decision
 * above, and re-pointing it at the viewer's locale would change grouping and
 * currency-symbol placement for every amount in the product on the strength of a
 * digit-shape bug that does not exist. (It is not costless — `en-US` groups INR
 * as ₹1,234,567 where `en-IN` would say ₹12,34,567 — but consistent, pasteable
 * grouping is the thing we chose.) If money ever does move to the viewer's
 * locale, it must come through `numberingLocale()` so it lands on the same side
 * of the decision as counts.
 *
 * ## Bidi control characters are stripped
 *
 * `Intl.NumberFormat("ur").format(-1234.5)` returns `"<U+200E>-1,234.5"` — an
 * invisible LEFT-TO-RIGHT MARK before the sign. CLDR emits it so the minus
 * stays left of the digits inside RTL prose, but it rides along on copy, and
 * a spreadsheet or a bank portal will not parse `<U+200E>-1234.5` as a number.
 * Since copyability is the whole reason we pinned Latin digits, leaving an
 * invisible character in the output would defeat the decision it serves. This
 * follows `formatCurrency`'s existing precedent of rewriting NBSP to a plain
 * space for exactly the same reason.
 *
 * The cost is honest: in an Urdu (RTL) run, a bare leading `-` is a
 * direction-neutral character and can be reordered to the right of the digits
 * by the browser's bidi algorithm. If an RTL review ever shows a real "42-" in
 * the wild, the fix is an isolating wrapper at the call site
 * (`<bdi>` / `unicode-bidi: isolate`), not putting the mark back — the mark
 * would only move the breakage from the screen to the clipboard.
 */

import type { Locale } from "./i18n/strings";
import { numberingLocale } from "./i18n/numbering";
// `import type` of a value declaration: erased entirely at compile time, so
// the currency table below is checked against the real `SUPPORTED_CURRENCIES`
// without pulling `lib/schemas/company.ts` — and zod with it — into every
// bundle that imports a formatter.
import type { SUPPORTED_CURRENCIES } from "./schemas/company";

/** The workspace currencies a formatter can be asked for. */
type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

/**
 * Invisible bidi controls ICU may emit: LRM, RLM, ARABIC LETTER MARK. Also
 * NBSP and NARROW NBSP, normalised to a plain space so copy-paste, CSV export
 * and test assertions don't have to know about them.
 */
const BIDI_MARK_CODES = [0x200e, 0x200f, 0x061c]; // LRM, RLM, ARABIC LETTER MARK
const HARD_SPACE_CODES = [0x00a0, 0x202f]; // NO-BREAK SPACE, NARROW NO-BREAK SPACE

/**
 * Built from code points rather than pasted literals. A character class with
 * real LRMs sitting inside it is one an editor, a lint autofix or a careless
 * copy-paste can silently eat — and it would take the sanitiser with it while
 * looking completely unchanged in review.
 */
function charClass(codes: number[]): RegExp {
  return new RegExp("[" + codes.map((c) => String.fromCharCode(c)).join("") + "]", "g");
}

const BIDI_MARKS = charClass(BIDI_MARK_CODES);
const HARD_SPACES = charClass(HARD_SPACE_CODES);

/**
 * Exported because `formatCurrency` (lib/utils.ts) needs exactly this and used
 * to do it with a regex containing a pasted NO-BREAK SPACE literal — the very
 * hazard the `charClass` comment above describes, sitting in the money
 * formatter. One code-point-built sanitiser, both callers.
 */
export function sanitizeNumericOutput(formatted: string): string {
  return formatted.replace(BIDI_MARKS, "").replace(HARD_SPACES, " ");
}

/**
 * `Intl.NumberFormat` construction is one of the more expensive things in the
 * standard library, and chart tick formatters call it per tick per render.
 * Cached by tag + options. Keys are read with `.get`/`.set` only — never
 * iterated, because tsconfig has no `downlevelIteration` (TS2802).
 */
const FORMATTER_CACHE = new Map<string, Intl.NumberFormat>();

function formatter(locale: Locale, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const tag = numberingLocale(locale);
  const key = `${tag}|${JSON.stringify(options)}`;
  const cached = FORMATTER_CACHE.get(key);
  if (cached) return cached;
  const made = new Intl.NumberFormat(tag, options);
  FORMATTER_CACHE.set(key, made);
  return made;
}

/** Fraction-digit control, the only Intl knob call sites actually vary. */
export type FractionDigits = {
  minimumFractionDigits?: number;
  maximumFractionDigits?: number;
};

/**
 * A plain grouped number: `1234567` → `"1,234,567"`.
 *
 * Replaces bare `{value}` and `value.toLocaleString()` interpolations. The
 * `toLocaleString()` calls in `lib/actions/*` and `lib/budgets/check.ts` are
 * deliberately NOT candidates: those bake a number into an activity-log or
 * notification `message` string that is persisted once and then read by every
 * member of the workspace, so there is no single viewer whose locale applies.
 * Those strings are English prose regardless; localising only their digits
 * would produce a half-translated sentence.
 *
 * Non-finite input is passed to ICU as-is and comes back as `"NaN"` or `"∞"`.
 * Callers that mean something by infinity (runway with no burn, say) should
 * branch before calling, as the dashboard already does.
 */
export function formatNumber(value: number, locale: Locale, digits: FractionDigits = {}): string {
  return sanitizeNumericOutput(formatter(locale, digits).format(value));
}

/**
 * A percentage: `formatPercent(0.423, "en")` → `"42.3%"`.
 *
 * **Takes a ratio in 0–1, not 0–100.** Every existing call site computes a
 * 0–100 number and appends a literal `"%"` (`pct.toFixed(1)}%` in
 * reports-client, revenue-client, investments-client, expenses-client), so
 * adopting this helper means dividing by 100 at the same time. The signature
 * matches `Intl`'s rather than the call sites' on purpose: a helper that
 * silently accepted both scales would turn a missed division into a plausible
 * -looking "4230%" that reviewers skim past.
 *
 * Also earns its keep beyond grouping — the `%` sign's placement relative to
 * the digits is locale data, not a string concatenation.
 */
export function formatPercent(ratio: number, locale: Locale, digits: FractionDigits = {}): string {
  return sanitizeNumericOutput(
    formatter(locale, { style: "percent", maximumFractionDigits: 1, ...digits }).format(ratio)
  );
}

/**
 * An abbreviated number for cramped surfaces like chart axis ticks:
 * `12345` → `"12K"` in English, `"12.3 ہزار"` in Urdu.
 *
 * This is the part of S19 that IS a real localisation gap, and it is a larger
 * one than the digit shape the row described. The five chart tick formatters
 * hardcode `(v / 1000).toFixed(0) + "K"`, and Urdu does not abbreviate on the
 * thousand/million/billion scale at all — it uses ہزار / لاکھ / کروڑ / ارب.
 * `1234567` is `"1.2M"` in English and `"12.3 لاکھ"` in Urdu: a different
 * grouping of the same quantity, not a translated suffix. No amount of digit
 * substitution gets you there; only `notation: "compact"` does.
 *
 * Caveat for adopters: the Urdu output is wider than `"1.2M"` and the suffix is
 * a real word, so a chart axis that fits English ticks may need more gutter in
 * RTL. Check it against a running app before wiring the tick formatters.
 */
export function formatCompact(value: number, locale: Locale): string {
  return sanitizeNumericOutput(
    formatter(locale, { notation: "compact", maximumFractionDigits: 1 }).format(value)
  );
}

/* ------------------------------------------------------------------------- *
 * Money scale — the decision behind money-001 / money-002 / money-009.
 * ------------------------------------------------------------------------- */

/**
 * The scale the database actually stores: `amount Decimal @db.Decimal(12, 2)`
 * (prisma/schema.prisma), same for `Budget.monthlyLimit` and
 * `RecurringRule.amount`.
 *
 * This constant is the reason the two halves below are one decision. Postgres
 * rounds a numeric to the column scale WITHOUT erroring, so every place that
 * disagrees with this number breaks quietly, and in a different direction:
 *
 *  • Showing FEWER places than we store (money-001: `maximumFractionDigits: 0`)
 *    means the ledger rows on screen do not add up to the total on the same
 *    screen. Three 0.50 expenses rendered "1", "1", "1" beside a total of "2".
 *  • Accepting MORE places than we store (money-002) means the amount the
 *    customer typed is not the amount the ledger holds, and 0.004 — which
 *    passes `.positive()` — lands in the column as 0.00: a transaction that
 *    counts in "N transactions" and contributes nothing to any total.
 *
 * Change this only together with a migration that changes the column scale AND
 * the display table below. Any one of the three moving alone is a silent bug.
 */
export const STORED_MONEY_SCALE = 2;

/**
 * Currency → how many decimal places we RENDER.
 *
 * `Record<SupportedCurrency, …>` is deliberate, copying the `NUMBERING_SYSTEMS`
 * precedent in `lib/i18n/numbering.ts`: adding a code to
 * `SUPPORTED_CURRENCIES` without deciding its scale fails `npm run typecheck`
 * right here, at the decision, instead of inheriting whatever the previous
 * entry happened to say.
 *
 * ## Why every entry is 2, including PKR
 *
 * `maximumFractionDigits: 0` was plausibly a PKR-market call — paisa coins are
 * long demonetised and Pakistani invoices are written in whole rupees — so the
 * obvious "explicit" version of this table would be `PKR: 0` with 2 for the
 * rest. It is not, and the reason is not typography:
 *
 *   The column stores 2 decimals for EVERY currency, and the amount input
 *   offers `step="0.01"` for every currency. A PKR workspace can therefore hold
 *   0.50 rows — and if we render them as whole rupees, that workspace gets
 *   exactly the money-001 defect the 0 was supposed to be a style choice about:
 *   visible rows that do not sum to the visible total.
 *
 * Whole-rupee DISPLAY is only honest once whole-rupee STORAGE is enforced — a
 * scale-0 column plus an integer-only amount schema. That is a migration and a
 * product decision, not a formatter flag, and it is filed as a follow-up. Until
 * it lands, display scale tracks `STORED_MONEY_SCALE`.
 *
 * So the rule for a future entry: a 0 here is a lie unless the amount schema and
 * the column agree. A genuinely zero-decimal currency (JPY, KRW, VND) needs all
 * three changed together.
 *
 * ## Why not just let Intl decide
 *
 * `Intl.NumberFormat(…, { currency }).resolvedOptions().maximumFractionDigits`
 * already knows each currency's minor units, and the audit's suggested fix was
 * to read it. We don't, for the table: ICU/CLDR data is versioned with the Node
 * and browser build, so "what the app shows" would become "whatever ICU the
 * server happens to run", and a server render could disagree with the client's.
 * The table is the decision; ICU is only the fallback for a code not in it.
 */
export const MONEY_MINOR_UNITS: Record<SupportedCurrency, number> = {
  PKR: STORED_MONEY_SCALE,
  USD: STORED_MONEY_SCALE,
  EUR: STORED_MONEY_SCALE,
  GBP: STORED_MONEY_SCALE,
  INR: STORED_MONEY_SCALE,
  AED: STORED_MONEY_SCALE,
};

/**
 * Decimal places to render `currency` with.
 *
 * `currency` is a plain `string` rather than `SupportedCurrency` because it
 * arrives from `Company.currency` — a database column, which can hold a stale
 * seed value or a code written before `SUPPORTED_CURRENCIES` existed. Unknown
 * codes ask ICU for the currency's own minor units, and fall back to the stored
 * scale if ICU has never heard of it either. Never 0 by default: an amount
 * that is wrong by a little is a support ticket, a silently rounded one is a
 * lost cent nobody reports.
 */
export function currencyMinorUnits(currency: string): number {
  const decided = MONEY_MINOR_UNITS[currency as SupportedCurrency];
  if (typeof decided === "number") return decided;
  try {
    const resolved = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
    }).resolvedOptions().maximumFractionDigits;
    return typeof resolved === "number" ? resolved : STORED_MONEY_SCALE;
  } catch {
    // Not a valid ISO 4217 code — `formatCurrency` has its own fallback for
    // rendering it, and that fallback should still show cents.
    return STORED_MONEY_SCALE;
  }
}

/**
 * How many decimal places `value` actually carries.
 *
 * Reads the number's own shortest round-trip representation (`String(value)`),
 * which is the only honest answer to "how many decimals did the user type":
 * `<input type="number">` + `valueAsNumber` gives 1234.567 for "1234.567" and
 * 0.3 for "0.30", and `String` reproduces exactly that.
 *
 * The arithmetic test the audit suggested — `|v*100 - round(v*100)| < 1e-9` — is
 * wrong in both directions, which is why it is not used here:
 *
 *     1234.57 * 100      === 123456.99999999999   (needs the tolerance)
 *     999999999.99 * 100 === 99999999998.99999    (off by 1e-5, so a legitimate
 *                                                  2-place amount is rejected)
 *
 * The second case is inside `.max(1_000_000_000)`, so it is reachable input.
 */
export function moneyDecimalPlaces(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const s = Math.abs(value).toString();
  const e = s.indexOf("e");
  if (e === -1) {
    const dot = s.indexOf(".");
    return dot === -1 ? 0 : s.length - dot - 1;
  }
  // Exponent form: JS uses it below 1e-6 ("1e-7", "1.5e-7") and above 1e20.
  // Places = the mantissa's own decimals plus however far a negative exponent
  // shifts the point right. Clamped at 0 for the large end.
  const mantissa = s.slice(0, e);
  const exponent = Number(s.slice(e + 1));
  const dot = mantissa.indexOf(".");
  const mantissaPlaces = dot === -1 ? 0 : mantissa.length - dot - 1;
  return Math.max(0, mantissaPlaces - exponent);
}

/**
 * Can `value` be stored without the database quietly changing it?
 *
 * Used by the zod amount schemas so the trust boundary, not Postgres, decides
 * what happens to 1234.567. We REJECT rather than round: rounding is what the
 * column already does, and the whole complaint in money-002 is that it happens
 * without telling anyone.
 *
 * This also rejects a float carrying binary dust (0.1 + 0.2 →
 * 0.30000000000000004, 17 places). Intentional, and currently unreachable: no
 * UI computes an amount and submits it, every amount comes from a typed string.
 * If one ever does, it must round to 2 places deliberately before it gets here.
 */
export function isStorableMoneyScale(value: number): boolean {
  return moneyDecimalPlaces(value) <= STORED_MONEY_SCALE;
}

/* ------------------------------------------------------------------------- *
 * Reading money OUT of text (CSV import) — money-009.
 * ------------------------------------------------------------------------- */

/**
 * Why a cell could not be read. The user-facing wording lives at the call site,
 * with the offending cell echoed; this is only the reason code.
 */
export type MoneyParseFailure =
  | "empty" // no digits at all
  | "ambiguous" // digits present, but the separators don't name one number
  | "negative" // a sign or accounting parentheses — we import magnitudes only
  | "scale"; // more precision than `STORED_MONEY_SCALE` can hold

export type MoneyParseResult =
  | { ok: true; amount: number }
  | { ok: false; reason: MoneyParseFailure };

/**
 * Integer-part forms we are willing to read. Both grouped forms require comma
 * separators and a final group of exactly three digits, which is what makes
 * them unambiguous — and what makes "1,00" (a European decimal comma) a
 * rejection rather than the 100 the old parser invented.
 */
const PLAIN_INTEGER = /^[0-9]+$/;
const WESTERN_GROUPED = /^[0-9]{1,3}(,[0-9]{3})+$/;
/**
 * Indian lakh/crore grouping: "12,34,567". INR is a supported workspace
 * currency and an en-IN spreadsheet export groups this way, so it has to stay
 * readable — the old strip-everything parser happened to get it right
 * ("12,34,567" → 1234567) and rejecting it now would be a regression for the
 * exact market that files this format. Unambiguous, and non-overlapping with
 * the western form: leading groups are exactly 2 digits, the last exactly 3.
 */
const INDIAN_GROUPED = /^[0-9]{1,2}(,[0-9]{2})+,[0-9]{3}$/;

/** Single-character digit test. `charAt` comparisons would also call `"٥"` a
 *  non-digit, which is right for our purposes, but this says so out loud. */
function isAsciiDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}

/**
 * Dashes a spreadsheet can emit where a minus sign belongs: MINUS SIGN, FIGURE
 * DASH, EN DASH, EM DASH. Built from code points (reusing `charClass` above)
 * because all four are visually indistinguishable from an ASCII hyphen in an
 * editor — a pasted literal here would be unreviewable, and reading one as
 * decoration rather than a sign imports a negative amount as a positive one.
 */
const DASHES = charClass([0x2212, 0x2012, 0x2013, 0x2014]);

/**
 * Read one spreadsheet cell as an amount, or say why not.
 *
 * Replaces `Number(raw.replace(/[^0-9.-]/g, ""))`, which did not parse so much
 * as delete: it kept every digit, dot and minus it found and trusted the
 * result. Verified outputs of that version, all of which passed the importer's
 * validation and were inserted (money-009):
 *
 *     "Rs. 1,000"   → 0.1       the dot of the abbreviation "Rs." survived
 *     "1.234,56"    → 1.23456   European decimal comma dropped
 *     "1 234,56"    → 123456    French group space dropped
 *     "(1,234.00)"  → 1234      accounting negative became a positive
 *     "1,00"        → 100       decimal comma read as a thousands separator
 *
 * The rule here is that a parser which cannot parse must refuse. Four of those
 * five now return `ok: false` with a reason. The exception is "Rs. 1,000", this
 * product's home-market format, which now reads as 1000: currency decoration is
 * stripped AS decoration (everything before the first digit and after the last),
 * so the abbreviation dot goes with the "Rs" where it belongs instead of
 * becoming a decimal point.
 *
 * Deliberately NOT locale-aware. A cell only says "1.234,56"; it does not say
 * which locale wrote it, and guessing from the workspace currency would make the
 * same file import differently in two workspaces. Ambiguity is refused here, not
 * resolved.
 */
export function parseMoneyInput(raw: string): MoneyParseResult {
  // Unicode dashes → ASCII hyphen FIRST, so a sign written as U+2212 is read as
  // a sign instead of being stripped as decoration, which would import a
  // negative amount as a positive one.
  let body = raw.trim().replace(DASHES, "-");
  if (body === "") return { ok: false, reason: "empty" };

  // Accounting negatives first, before any stripping: "(1,234.00)" is -1234 in
  // every spreadsheet export, and the parentheses are the only thing saying so.
  let negative = false;
  if (body.length >= 2 && body.charAt(0) === "(" && body.charAt(body.length - 1) === ")") {
    negative = true;
    body = body.slice(1, -1).trim();
  }
  // Parentheses that did NOT form a clean wrapper — "(1,234.00) USD" is the one
  // that matters, because the pair check above misses it and the decoration
  // stripping below would drop both brackets and import +1234. Two brackets
  // still means accounting notation, so say "negative"; one lone bracket is
  // just unreadable.
  if (body.indexOf("(") !== -1 || body.indexOf(")") !== -1) {
    const bracketed = body.indexOf("(") !== -1 && body.indexOf(")") !== -1;
    return { ok: false, reason: bracketed ? "negative" : "ambiguous" };
  }
  // Signs, leading or trailing — some bank exports write "1,234.00-". Taken
  // before decoration stripping so "-Rs. 5" reads as negative five instead of
  // being refused as unreadable.
  if (body.charAt(0) === "-" || body.charAt(0) === "+") {
    negative = negative || body.charAt(0) === "-";
    body = body.slice(1).trim();
  }
  if (body.charAt(body.length - 1) === "-") {
    negative = true;
    body = body.slice(0, -1).trim();
  }

  // Currency decoration = everything outside the digits: symbols, ISO codes, an
  // abbreviation dot, NBSP from a spreadsheet. Anything BETWEEN the first and
  // last digit is part of the number and survives to be judged below.
  const first = body.search(/[0-9]/);
  if (first === -1) return { ok: false, reason: "empty" };
  let last = body.length - 1;
  while (last > first && !isAsciiDigit(body.charAt(last))) last--;
  let core = body.slice(first, last + 1);

  // A dot in front of the first digit is the one character that can be either.
  // In "Rs. 1,000" it belongs to the abbreviation; in ".50" it is the decimal
  // point, and dropping it would read fifty paisa as fifty rupees — the same
  // factor-of-100 error, just in the other direction.
  const head = body.slice(0, first).replace(/\s+$/, "");
  if (head === ".") {
    core = "." + core; // ".50" → 0.50
  } else if (head !== "" && head.charAt(head.length - 1) === "." && !/[A-Za-z]/.test(head)) {
    // "$.50", "₨.50": a symbol then a dot. An abbreviation dot comes after
    // LETTERS ("Rs.", "kr."); after a bare symbol we cannot tell a decimal point
    // from decoration, so we refuse instead of picking. Guessing wrong here is
    // exactly the money-009 failure.
    return { ok: false, reason: "ambiguous" };
  }

  const parts = core.split(".");
  // Two or more dots can only be thousands separators, i.e. a locale we refuse
  // to guess at ("1.234.567").
  if (parts.length > 2) return { ok: false, reason: "ambiguous" };
  // ".50" leaves an empty integer part, which means zero — but only when there
  // IS a fraction; a bare "." never reaches here (no digits → "empty").
  const integerPart = parts[0] === "" && parts.length === 2 ? "0" : parts[0];
  const fractionPart = parts.length === 2 ? parts[1] : "";
  if (parts.length === 2 && !PLAIN_INTEGER.test(fractionPart)) {
    return { ok: false, reason: "ambiguous" }; // "1.234,56"
  }
  if (fractionPart.length > STORED_MONEY_SCALE) {
    // "1234.567" — real precision the column cannot hold. Refusing is the
    // point: it would have been rounded, silently (money-002).
    return { ok: false, reason: "scale" };
  }
  if (
    !PLAIN_INTEGER.test(integerPart) &&
    !WESTERN_GROUPED.test(integerPart) &&
    !INDIAN_GROUPED.test(integerPart)
  ) {
    return { ok: false, reason: "ambiguous" }; // "1,00", "1 234,56"
  }

  const amount = Number(integerPart.replace(/,/g, "") + (fractionPart ? "." + fractionPart : ""));
  if (!Number.isFinite(amount)) return { ok: false, reason: "ambiguous" };
  // A zero magnitude is not "negative", but it is not an amount either — the
  // caller's own `> 0` rule reports that. Sign gets its own reason code so the
  // UI can say "negative" instead of the useless "invalid amount".
  if (negative && amount !== 0) return { ok: false, reason: "negative" };
  return { ok: true, amount };
}
