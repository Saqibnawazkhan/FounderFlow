"use client";

/**
 * useT() — the client hook every component uses to pull translated strings.
 *
 *   const t = useT();
 *   <button>{t.common.save}</button>
 *
 * Returns the dictionary for the locale currently in the Zustand store.
 * Switching locales is reactive (Zustand subscription), so a component using
 * `t.nav.dashboard` re-renders the moment the user picks Urdu in Settings.
 */

import { useCallback } from "react";
import { useStore } from "@/lib/store";
import { formatCompact, formatNumber, formatPercent, type FractionDigits } from "@/lib/format";
import { formatDate, formatRelativeTime } from "@/lib/utils";
import { DICTIONARIES, type Locale, type Strings } from "./strings";

export function useT(): Strings {
  const locale = useStore((s) => s.locale);
  return DICTIONARIES[locale] ?? DICTIONARIES.en;
}

/**
 * The active locale code itself.
 *
 * `useT()` deliberately returns only the dictionary, so there was previously no
 * way for a component to ask *which* locale it was in — FaultsAudit S19 assumed
 * a `t.locale` that has never existed. Number formatting needs the code, not the
 * strings, so it gets its own accessor rather than a `locale` key smuggled into
 * the dictionary (which would collide with the `Strings = typeof en` derivation
 * that makes a missing Urdu translation a type error).
 */
export function useLocale(): Locale {
  const locale = useStore((s) => s.locale);
  return DICTIONARIES[locale] ? locale : "en";
}

/**
 * Number formatters bound to the active locale — the client-side counterpart to
 * `useMoney()`, and the way components should reach `lib/format.ts`.
 *
 *   const n = useNumberFormat();
 *   <span>{n.number(sessions)} {t.settings.sessionCount}</span>
 *
 * Returning bound functions (rather than the locale, for the caller to thread
 * through) keeps the numbering-system decision out of components entirely: no
 * component ever names a locale tag, so none can get it wrong.
 */
export function useNumberFormat(): {
  number: (value: number, digits?: FractionDigits) => string;
  percent: (ratio: number, digits?: FractionDigits) => string;
  compact: (value: number) => string;
} {
  const locale = useLocale();
  return {
    number: useCallback(
      (value: number, digits?: FractionDigits) => formatNumber(value, locale, digits),
      [locale]
    ),
    percent: useCallback(
      (ratio: number, digits?: FractionDigits) => formatPercent(ratio, locale, digits),
      [locale]
    ),
    compact: useCallback((value: number) => formatCompact(value, locale), [locale]),
  };
}

/**
 * Date formatters bound to the active locale — `useNumberFormat()`'s twin, in
 * the same shape and for the same reason.
 *
 *   const d = useDateFormat();
 *   <span>{d.relative(n.createdAt)}</span>
 *   <span>{d.date(user.createdAt)}</span>
 *
 * ## Why this exists (i18n-004, the reachability half)
 *
 * `formatDate` and `formatRelativeTime` in lib/utils.ts take an OPTIONAL
 * `locale` that defaults to English — deliberately, because one server caller
 * (lib/billing/billing-notify.ts) persists and mails its output and must keep
 * getting English. Optional meant that for a while not one of the fifteen
 * rendered call sites passed anything, so the helpers were correct, tested, and
 * invisible: an Urdu workspace still read "Sep 26, 2026" on every screen. The
 * helper was never the bug; the un-passed argument was.
 *
 * Threading `useLocale()` through each component by hand would have left the
 * same hole open for the sixteenth call site. Binding it here closes it the way
 * `useNumberFormat` closes the numbering-system decision: no component names a
 * locale tag, so none can get it wrong and none can forget. The invariant is
 * enforced rather than remembered — tests/lib/i18n/date-locale-reachability
 * fails if anything under app/ or components/ imports the bare helpers again.
 *
 * No import cycle: lib/utils.ts reaches only lib/format.ts, lib/i18n/numbering
 * and lib/i18n/strings, none of which import this module.
 */
export function useDateFormat(): {
  date: (value: string | Date) => string;
  relative: (value: string | Date) => string;
} {
  const locale = useLocale();
  return {
    date: useCallback((value: string | Date) => formatDate(value, locale), [locale]),
    relative: useCallback((value: string | Date) => formatRelativeTime(value, locale), [locale]),
  };
}
