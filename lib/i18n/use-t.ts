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
