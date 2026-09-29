/**
 * `useDateFormat()` — the binding half of i18n-004.
 *
 * tests/lib/utils/date-locale.test.ts already proves the HELPERS render Urdu.
 * This file proves the only thing that was actually missing: that a component
 * gets the viewer's locale into them without naming a locale tag, and that the
 * result moves when the viewer switches language.
 *
 * So there is deliberately no re-test of month names or CLDR wording here —
 * every Urdu expectation below is stated as "identical to calling the helper
 * with the locale the store holds", because the hook's entire contract is that
 * it is that call and nothing else.
 *
 * WHY THE STORE IS DRIVEN RATHER THAN MOCKED. Mocking `useStore` would prove
 * the hook forwards whatever a mock returns, which is the shape of test this
 * repo keeps writing and keeps regretting. `useStore.setState` is the real
 * store, so what is under test is the real subscription — including that a
 * locale change re-renders the consumer, which is the behaviour a user
 * experiences as "the dates changed when I picked اردو".
 */

import { describe, it, expect, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useStore } from "@/lib/store";
import { useDateFormat } from "@/lib/i18n/use-t";
import { formatDate, formatRelativeTime } from "@/lib/utils";

/** Midday UTC: the same calendar day under the suite's Bogota pin. */
const MIDDAY = "2026-05-24T12:00:00Z";
const DAY_MS = 24 * 60 * 60 * 1000;

describe("useDateFormat binds the date helpers to the viewer's locale", () => {
  beforeEach(() => {
    act(() => {
      useStore.setState({ locale: "en" });
    });
  });

  it("is byte-identical to the bare helpers in English", () => {
    // The no-regression half. Nineteen of the twenty-odd rendered dates in the
    // product are English today and must not move by a character.
    const { result } = renderHook(() => useDateFormat());
    const yesterday = new Date(Date.now() - DAY_MS);

    expect(result.current.date(MIDDAY)).toBe("May 24, 2026");
    expect(result.current.date(MIDDAY)).toBe(formatDate(MIDDAY));
    expect(result.current.relative(yesterday)).toBe(formatRelativeTime(yesterday));
    expect(result.current.relative(yesterday)).toMatch(/^Yesterday at \d/);
  });

  it("renders Urdu once the store is in Urdu, with no English left", () => {
    act(() => {
      useStore.setState({ locale: "ur" });
    });
    const { result } = renderHook(() => useDateFormat());

    expect(result.current.date(MIDDAY)).toBe(formatDate(MIDDAY, "ur"));
    expect(
      result.current.date(MIDDAY),
      `still Latin on an Urdu screen: ${result.current.date(MIDDAY)}`
    ).not.toMatch(/[A-Za-z]/);

    const tenDaysAgo = new Date(Date.now() - 10 * DAY_MS);
    expect(result.current.relative(tenDaysAgo)).toBe(formatRelativeTime(tenDaysAgo, "ur"));
    expect(result.current.relative(tenDaysAgo)).not.toMatch(/[A-Za-z]/);
  });

  it("follows a language switch without a remount", () => {
    // This is what the user does: they are on /settings, they pick اردو, and
    // the join date beside them has to change with the labels. A hook that read
    // the locale once at mount would pass every assertion above and fail this.
    const { result } = renderHook(() => useDateFormat());
    expect(result.current.date(MIDDAY)).toBe("May 24, 2026");

    act(() => {
      useStore.getState().setLocale("ur");
    });

    expect(result.current.date(MIDDAY)).toBe(formatDate(MIDDAY, "ur"));
    expect(result.current.date(MIDDAY)).not.toBe("May 24, 2026");
  });

  it("falls back to English for a locale the dictionary does not have", () => {
    // `locale` is persisted to localStorage, so a stale or hand-edited value
    // can arrive from a previous build. `useLocale()` already guards this for
    // strings; the dates must not diverge from the strings.
    act(() => {
      useStore.setState({ locale: "fr" as never });
    });
    const { result } = renderHook(() => useDateFormat());

    expect(result.current.date(MIDDAY)).toBe("May 24, 2026");
  });
});
