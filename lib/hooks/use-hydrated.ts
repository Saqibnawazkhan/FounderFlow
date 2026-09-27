"use client";

/**
 * The A14 hydration gate, in one place.
 *
 * Lived as five byte-identical copies — one inside each public auth page —
 * because a `page.tsx` cannot export an extra symbol (Next's generated page
 * type check rejects any export it does not recognise), so the agent that
 * closed A14 could not hoist it without a file it was allowed to create. Its
 * own risk note: "if someone fixes a bug in one copy they must fix five." This
 * is that file; the five now import it.
 */

import { useEffect, useState } from "react";

/**
 * Has React hydrated this tree yet? (FaultsAudit A14.)
 *
 * The bug it closes: a `<form>` whose submit button is already clickable in the
 * server HTML performs a NATIVE submit if the click lands before hydration, and
 * a native submit with no `method` defaults to GET. That is how
 * `GET /login?email=demo%40founderflow.app&password=demo123` reached a
 * dev-server access log — and from there it would reach browser history, the
 * `Referer` of the next request, and any proxy log in between. It needs only a
 * slow first paint: a cold compile, a bad network, a cheap phone. On the forms
 * with a single field it needs no click at all, because one field does not
 * block implicit submission: Enter in the email box was enough.
 *
 * `useState(false)` + `useEffect` is the only honest hydration signal. An
 * effect runs strictly AFTER hydration, so the server render and React's
 * hydration render both see `false` and the markup matches exactly.
 * `typeof window !== "undefined"` is NOT a substitute: it is already true
 * DURING hydration, so it would render a tree the server never sent, and React
 * discards the whole subtree on the mismatch — which would take the form with
 * it, on the exact slow-first-paint loads this gate exists to protect.
 *
 * Not to be confused with `useStoreHasHydrated` in lib/store.ts: that one
 * reports when Zustand's persist middleware has finished reading localStorage,
 * and its initial value can already be `true` on the very first render. It
 * answers a different question and would not close this hole.
 *
 * This is the prevention half of the fix; `method="post"` on each form is the
 * safety net that downgrades the failure to a request body if a native submit
 * ever happens anyway. Neither alone is enough: the gate depends on our own
 * correctness, the method attribute depends on nothing.
 *
 * Callers spell the gate `disabled={!hydrated || isSubmitting}`, and
 * `tests/components/auth-forms.test.tsx` sweeps the public route tree for
 * exactly that shape — so a sixth auth form written next year fails the suite
 * instead of shipping A14 again.
 */
export function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setHydrated(true);
  }, []);
  return hydrated;
}
