/**
 * Which numbering system each UI locale renders digits in.
 *
 * ## The bug this file exists to prevent
 *
 * FaultsAudit S19 recorded "999 sessions not ۹۹۹ for Urdu" and prescribed an
 * `Intl.NumberFormat(t.locale)` sweep. That prescription is a no-op, and the
 * premise behind it is wrong. CLDR's default numbering system for `ur` — which
 * resolves to `ur-PK` — is already `latn`:
 *
 *     new Intl.NumberFormat("ur").resolvedOptions().numberingSystem  // "latn"
 *     new Intl.NumberFormat("ur").format(999)                        // "999"
 *
 * Only `ur-IN` defaults to `arabext` (۹۹۹). So passing the locale through to
 * Intl would have changed nothing, and the row would have been closed with a
 * diff that shipped zero behaviour change.
 *
 * ## The decision
 *
 * Every supported locale is pinned to `latn`, EXPLICITLY, rather than left to
 * inherit whatever CLDR happens to default to.
 *
 * Latin digits are the right call for this product, not merely the status quo:
 * FounderFlow is Pakistan-first (PKR default currency; LemonSqueezy as merchant
 * of record precisely because Stripe won't onboard Pakistani sellers), and
 * Pakistani business software overwhelmingly renders Latin digits alongside
 * Urdu text. The numbers on these screens are amounts, counts and dates that
 * get copied into bank portals, spreadsheets and WhatsApp messages. A figure
 * a founder cannot paste into Meezan's transfer form is a broken figure, however
 * typographically authentic it looks.
 *
 * Pinning — rather than relying on the CLDR default — is the load-bearing part:
 *
 *  1. Adding a locale silently changes digit family. `ur-IN`, `fa`, `ar` and
 *     `ps` all default to a non-Latin system. The moment one lands, screens
 *     render ۹۹۹ from the handful of values that pass through Intl and 999 from
 *     every raw `{rows.length}` interpolation that doesn't — mixed digit
 *     families in one sentence, which is worse than consistent ASCII and is the
 *     actual failure mode this codebase is exposed to.
 *  2. It gives the decision one address. Someone re-deciding it edits this
 *     table and reads the argument, instead of discovering the behaviour
 *     empirically from a screenshot.
 *
 * ## What would change it
 *
 * A locale whose audience genuinely expects Arabic-Indic digits in prose —
 * an `ur-IN` or `ar-*` market. That is not a one-line flip of this table: it
 * splits every call site into "prose numbers" (localised digits) and "copyable
 * numbers" (money, ids, anything with a copy button), which today are the same
 * call. Change this table only together with that split.
 *
 * ## The sibling decision
 *
 * `MONEY_MINOR_UNITS` in `lib/format.ts` is the same shape for the same reason:
 * a `Record<>` keyed by a closed union, so adding a currency without deciding
 * its decimal places fails `npm run typecheck` at the decision. It was written
 * after money-001 — a hardcoded `maximumFractionDigits: 0` in `formatCurrency`
 * that nobody re-read as a decision because it had no address. This file was the
 * precedent; that is the argument for keeping the pattern.
 */

import type { Locale } from "./strings";

/**
 * The Unicode numbering-system identifiers we are willing to render. Kept as a
 * closed union so a typo like "latin" is a compile error rather than a subtag
 * ICU silently ignores while falling back to the locale default.
 */
export type NumberingSystem = "latn" | "arabext";

/**
 * Locale → numbering system. `Record<Locale, …>` is deliberate: adding a code
 * to `SUPPORTED_LOCALES` without deciding its digits fails `npm run typecheck`
 * right here, at the decision, instead of shipping CLDR's guess.
 */
export const NUMBERING_SYSTEMS: Record<Locale, NumberingSystem> = {
  en: "latn",
  // Pinned, not inherited. `ur` already resolves to latn today — this line is
  // what stops a future ICU/CLDR revision, or a switch to `ur-IN`, from moving
  // it without anyone deciding to. See the argument above.
  ur: "latn",
};

/**
 * The BCP-47 tag to hand `Intl`, with the numbering system pinned via the `-u-nu-`
 * extension so the output never depends on the CLDR default for the base locale.
 *
 * Returns e.g. `"ur-u-nu-latn"`. Unknown locales fall back to English rather
 * than to the platform default, because "whatever the server's ICU thinks" is
 * how you get one digit family in SSR output and another after hydration.
 */
export function numberingLocale(locale: Locale): string {
  const system = NUMBERING_SYSTEMS[locale] ?? NUMBERING_SYSTEMS.en;
  return `${locale}-u-nu-${system}`;
}
