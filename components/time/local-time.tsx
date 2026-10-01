"use client";

/**
 * <LocalTime> — a timestamp rendered in the VIEWER's timezone, exactly once.
 *
 * WHY THIS EXISTS (time-011). /time's table is a `"use client"` component that is
 * still SERVER-rendered, and it formatted its cells with
 * `format(startedAt, "MMM dd · HH:mm")` — date-fns against the HOST clock. On
 * Vercel that host is UTC; in the browser it is the viewer's zone. This product is
 * built for a PKT (UTC+5) market, so every row showed a five-hour-wrong time on
 * first paint and then silently changed. React also logged a hydration mismatch
 * for the differing text, and in production a mismatch makes it discard and
 * re-render the subtree, which is the "flash the empty state" the audit describes.
 *
 * THE FIX IS NOT `suppressHydrationWarning`. That hides the warning and keeps the
 * wrong first paint. Instead the FIRST render — server, and the client's hydration
 * pass — deliberately prints no wall clock at all: there is then nothing for the
 * two zones to disagree about, hydration matches by construction, and the local
 * value appears on mount. The cost is one frame of `placeholder`, which is the
 * honest trade for never showing a time that is wrong by five hours.
 *
 * The markup is never actually missing the timestamp: `<time dateTime>` carries
 * the ISO instant in both renders, so a crawler and `document.querySelector` see
 * it before mount.
 *
 * NOT A SCREEN READER, and an earlier version of this comment claimed otherwise.
 * No assistive technology announces the `dateTime` attribute — a screen reader
 * reads the element's TEXT, which before mount is the placeholder. The practical
 * cost is one frame, the same frame a sighted reader sees; the claim was simply
 * wrong, and an a11y claim that is wrong is worse than none, because it is the
 * reason the next person stops looking.
 *
 * THE OTHER FIX, NOT AVAILABLE HERE. Formatting identically on both sides needs a
 * zone both sides know — `date-fns-tz` plus a stored company/user IANA timezone.
 * That is a schema change (a `timezone` column), which is out of scope for this
 * wave, and it would be the better answer: no placeholder frame, and correct
 * calendar-day bucketing in shared/team views regardless of who is looking.
 * Recorded, not built.
 */

import { useEffect, useState } from "react";
import { format } from "date-fns";

/**
 * True only after the component has mounted in a browser.
 *
 * The initial `false` is the point: it is what the server renders AND what the
 * client's hydration render produces, so the two agree.
 */
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}

export function LocalTime({
  value,
  pattern,
  placeholder = "—",
  className,
}: {
  /** An ISO string (what crosses the RSC boundary) or a Date. */
  value: string | Date;
  /** A date-fns format pattern, e.g. "MMM dd · HH:mm". */
  pattern: string;
  /** What the server render shows in place of the clock. */
  placeholder?: string;
  className?: string;
}) {
  const mounted = useMounted();
  const date = value instanceof Date ? value : new Date(value);
  const iso = Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  return (
    <time dateTime={iso} className={className}>
      {mounted && iso ? format(date, pattern) : placeholder}
    </time>
  );
}
