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

import { useStore } from "@/lib/store";
import { DICTIONARIES, type Strings } from "./strings";

export function useT(): Strings {
  const locale = useStore((s) => s.locale);
  return DICTIONARIES[locale] ?? DICTIONARIES.en;
}
