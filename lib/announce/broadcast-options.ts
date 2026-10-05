/**
 * Per-request options for /api/cron/announce-broadcast.
 *
 * Modelled directly on `lib/cron/purge-options.ts`, which exists for the same
 * reason: the decision "does this request actually do the irreversible thing?"
 * has to be readable, unit-testable and separate from the handler, because a
 * route handler cannot be reached by a test without a Prisma client.
 *
 * THE INVARIANT IS THE SAME, AND IT IS THE WHOLE DESIGN: A QUERY PARAMETER MAY
 * ONLY MAKE A RUN SAFER. The caller holds `CRON_SECRET`, and a secret in a
 * Vercel env var is not a good enough reason to let a link fire an unrecallable
 * notification at every paying customer's lock screen.
 *
 * WHY TWO KEYS WHERE THE PURGE HAS ONE. The purge is armed by `PURGE_ENABLED`
 * alone because Vercel's scheduler fires it; there is no human in the loop to
 * supply a second factor. This one is fired BY HAND, and the hazard is the
 * opposite shape: `ANNOUNCE_BROADCAST_ENABLED` will sit in the Production env
 * long after the announcement, because removing it is a chore nobody is
 * prompted to do. So arming is necessary but not sufficient:
 *
 *   env unset / anything but "true"      → dry run, and `?live=1` is REFUSED
 *   env "true", no `?live=1`             → dry run, reported as ARMED
 *   env "true" AND `?live=1`             → the real send
 *
 * That is the seed guard's two-key launch (prisma/seed.ts: `SEED_RESET` AND
 * `SEED_RESET_ALLOW_PROD`), applied to the one other irreversible action in
 * this product that a person triggers from a terminal.
 *
 * ONE AXIS, ONE PARAMETER. There is deliberately no `?dryRun=` alongside
 * `?live=`: two parameters controlling the same switch means a request can
 * state both and the reader has to know which wins. `?live=0` is the explicit
 * dry run and needs no refusal, because it is already the default.
 *
 * REFUSALS ARE REPORTED, NOT SWALLOWED. Every rejected parameter comes back in
 * `refused` and the route puts it in the response body. An operator who types
 * `?live=1`, gets a dry run and is told nothing would reasonably conclude the
 * broadcast went out and reached nobody — which is the most dangerous
 * misreading this endpoint offers.
 *
 * Pure and I/O-free. See tests/lib/announce/broadcast-route.test.ts.
 */

export interface BroadcastRunOptions {
  /** True = count only, send nothing. The default, and the safe direction. */
  dryRun: boolean;
  /**
   * The deployment has armed a real send. Surfaced even on a dry run, because
   * "armed but not fired" is the state the owner needs to see before they type
   * the second command — and the state they need to notice and clear afterwards.
   */
  armed: boolean;
  /** Human-readable reasons a requested parameter was not honoured. */
  refused: string[];
  /**
   * `ANNOUNCE_BROADCAST_ENABLED` held a value that is neither the one arming
   * spelling (`"true"`) nor the documented way of saying off (`"false"`).
   *
   * Lifted wholesale from cron-017, which was filed against `PURGE_ENABLED` for
   * exactly this: the fail-safe DIRECTION is right — only `"true"` arms — but an
   * owner who sets `TRUE`, sees a 200 and reads `ok: true` believes the
   * broadcast went out. The reverse typo is harmless, which is what makes it
   * easy to miss. Null when there is nothing to report.
   */
  ignoredEnabledValue: string | null;
}

/** The env var that, and only that, can authorise a real send. */
export const ARMING_ENV_VAR = "ANNOUNCE_BROADCAST_ENABLED";

/** Spellings that mean "yes" on a URL. Mirrors lib/cron/purge-options.ts. */
const TRUTHY = ["1", "true", "yes", "on"];
const FALSY = ["0", "false", "no", "off"];

export function decideBroadcastOptions(
  params: URLSearchParams,
  env: Record<string, string | undefined>
): BroadcastRunOptions {
  const refused: string[] = [];

  const raw = env[ARMING_ENV_VAR];
  const armed = raw === "true";

  const ignoredEnabledValue =
    typeof raw === "string" && raw.length > 0 && raw !== "true" && raw !== "false" ? raw : null;

  // Dry run until something takes it off, never the other way round.
  let dryRun = true;

  const liveParam = params.get("live");
  if (liveParam !== null) {
    const value = liveParam.trim().toLowerCase();
    if (TRUTHY.indexOf(value) !== -1) {
      if (armed) {
        dryRun = false;
      } else {
        // Refused whether or not it would have changed anything, so the message
        // reads the same on a deployment that is already armed. A parameter that
        // appears to work when it is a no-op is worse than one always refused.
        refused.push(
          `live=${liveParam} ignored: only ${ARMING_ENV_VAR}="true" in the deployment's own ` +
            `environment can authorise a real send. The run stayed a dry run.`
        );
      }
    } else if (FALSY.indexOf(value) !== -1) {
      // The default. Stating it explicitly is good practice, not an error.
      dryRun = true;
    } else {
      refused.push(`live=${liveParam} is not a boolean; the run stayed a dry run.`);
    }
  }

  return { dryRun, armed, refused, ignoredEnabledValue };
}
