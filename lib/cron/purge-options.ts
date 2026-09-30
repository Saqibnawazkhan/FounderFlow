/**
 * Per-request options for /api/cron/purge-soft-deleted (cron-012).
 *
 * THE PROBLEM. Whether the nightly purge erases anything came from one
 * process-wide env var, `PURGE_ENABLED`, and nothing else. So the only way to
 * find out what a live purge does to real customer data was to make every live
 * purge happen at once: flipping the var turned an irreversible multi-tenant
 * erasure on for every overdue workspace simultaneously, with no way to try it on
 * one workspace first. CLAUDE.md records the purge as "safe to enable" and the
 * memory note says "exercise the purge" — neither was actually possible.
 *
 * WHAT IS *NOT* THE PROBLEM ANY MORE, and the filing was out of date about it:
 * the run is no longer unbounded. `MAX_COMPANIES_PER_RUN` (10),
 * `MAX_PROJECTS_PER_RUN` (200), the `START_DEADLINE_MS` wind-down and the
 * `companiesDeferred` / `orphanProjectsDeferred` counters all landed earlier, so
 * a night already stops and reports what it left. What was still missing is the
 * ability to aim ONE run.
 *
 * THE ONE INVARIANT EVERYTHING HERE IS BUILT ON: A QUERY PARAMETER MAY ONLY
 * MAKE A RUN SAFER. Never the reverse.
 *
 *   • `?dryRun=1` forces a dry run. `?dryRun=0` is REFUSED and reported — a URL
 *     must never be able to turn on destruction that the deployment has not.
 *     That asymmetry is the whole design: the caller holds CRON_SECRET, and a
 *     secret in a Vercel env var is not a good enough reason to let a link
 *     erase customer workspaces.
 *   • `?companyId=` narrows the run to one workspace. It is ANDed with the
 *     90-day overdue filter at the call site, so it can only ever select a
 *     workspace the nightly run would have taken anyway — it is not a
 *     delete-by-id endpoint.
 *   • `?limit=` / `?projectLimit=` may only LOWER the built-in ceiling. A value
 *     above it is clamped and reported.
 *
 * REFUSALS ARE REPORTED, NOT SWALLOWED. Every rejected parameter comes back in
 * `refused` and the route puts it in the response body. An operator typing
 * `?dryRun=0` and getting a dry run with no explanation would reasonably assume
 * the parameter worked and the purge found nothing — which is the most dangerous
 * misreading available on this endpoint.
 *
 * Pure and I/O-free so the whole decision is unit-testable without a database:
 * the route handler itself cannot be reached by a test without a Prisma client.
 * See tests/lib/cron/purge-options.test.ts.
 */

export interface PurgeRunCaps {
  /** Built-in ceiling on workspaces started per run. */
  companies: number;
  /** Built-in ceiling on individually-deleted empty projects per run. */
  projects: number;
}

export interface PurgeRunOptions {
  /** True = count only, delete nothing. */
  dryRun: boolean;
  /**
   * Restrict scope 1 to a single workspace id. Null = every overdue workspace,
   * up to `companyLimit`. The id is still subject to the overdue cutoff.
   */
  onlyCompanyId: string | null;
  /** Effective ceiling for this run. Never greater than `caps.companies`. */
  companyLimit: number;
  /** Effective ceiling for scope 2. Never greater than `caps.projects`. */
  projectLimit: number;
  /**
   * Human-readable reasons a requested parameter was not honoured. Empty on an
   * ordinary cron invocation.
   */
  refused: string[];
  /**
   * `PURGE_ENABLED` held a value that is neither the one arming spelling
   * (`"true"`) nor a recognised way of saying off — `"TRUE"`, `"1"`, `"yes"`, a
   * stray trailing space. Null when there is nothing to report. cron-017.
   *
   * The fail-safe DIRECTION stays: only `"true"` arms the purge, and that is not
   * up for negotiation. What was missing was any signal at all. An owner who sets
   * `TRUE`, sees a green cron and reads `ok: true` believes 90-day erasure is
   * live, so their answer to "do you still hold my data?" is wrong in the
   * direction that matters — and the reverse typo is harmless, which is exactly
   * what makes this easy to miss for months.
   */
  ignoredPurgeEnabledValue: string | null;
}

/** Spellings that mean "yes" on a URL. Mirrors the truthiness used elsewhere. */
const TRUTHY = ["1", "true", "yes", "on"];
const FALSY = ["0", "false", "no", "off"];

/**
 * Parse a positive integer, or null. Deliberately strict: `"12abc"`, `"1e3"` and
 * `"-5"` are refusals rather than silently becoming 12, 1000 or a Prisma error,
 * because a mistyped ceiling that is quietly ignored reads as a ceiling that was
 * applied.
 */
function positiveInteger(raw: string): number | null {
  if (!/^[0-9]+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return null;
  return n;
}

export function decidePurgeOptions(
  params: URLSearchParams,
  env: Record<string, string | undefined>,
  caps: PurgeRunCaps
): PurgeRunOptions {
  const refused: string[] = [];

  // The env var is the ONLY thing that can authorise destruction.
  let dryRun = env.PURGE_ENABLED !== "true";

  // cron-017. A value that is set, is not the arming spelling, and is not a
  // recognised "off" either. `"false"` is the documented off-switch spelling in
  // this project (see RATE_LIMIT_DISABLED in scripts/vercel-build.mjs) so it is
  // not reported; everything else is.
  const purgeEnabled = env.PURGE_ENABLED;
  const ignoredPurgeEnabledValue =
    typeof purgeEnabled === "string" &&
    purgeEnabled.length > 0 &&
    purgeEnabled !== "true" &&
    purgeEnabled !== "false"
      ? purgeEnabled
      : null;

  const dryRunParam = params.get("dryRun");
  if (dryRunParam !== null) {
    const value = dryRunParam.trim().toLowerCase();
    if (TRUTHY.indexOf(value) !== -1) {
      dryRun = true;
    } else if (FALSY.indexOf(value) !== -1) {
      // Refused whether or not it would have changed anything, so the message is
      // the same on a deployment where the purge is already live. A parameter
      // that appears to work when it is a no-op is worse than one that is
      // always refused.
      refused.push("dryRun=false ignored: only PURGE_ENABLED=true can authorise a destructive run");
    } else {
      refused.push(`dryRun=${dryRunParam} is not a boolean; the run stayed as configured`);
    }
  }

  const companyParam = params.get("companyId");
  let onlyCompanyId: string | null = null;
  if (companyParam !== null) {
    const trimmed = companyParam.trim();
    if (trimmed.length === 0) {
      refused.push("companyId was empty; the run covered every overdue workspace");
    } else {
      onlyCompanyId = trimmed;
    }
  }

  const limits: Array<{ param: string; cap: number; assign: (n: number) => void }> = [];
  let companyLimit = caps.companies;
  let projectLimit = caps.projects;
  limits.push({
    param: "limit",
    cap: caps.companies,
    assign: (n) => {
      companyLimit = n;
    },
  });
  limits.push({
    param: "projectLimit",
    cap: caps.projects,
    assign: (n) => {
      projectLimit = n;
    },
  });

  for (const { param, cap, assign } of limits) {
    const raw = params.get(param);
    if (raw === null) continue;
    const parsed = positiveInteger(raw.trim());
    if (parsed === null) {
      refused.push(`${param}=${raw} is not a positive integer; the built-in cap of ${cap} applied`);
      continue;
    }
    if (parsed > cap) {
      refused.push(`${param}=${parsed} exceeds the built-in cap of ${cap}; ${cap} applied`);
      continue;
    }
    assign(parsed);
  }

  // A single-workspace run has no use for a workspace ceiling above one, and
  // leaving it at 10 would make the response's "purged 1 of 10" wording a lie.
  if (onlyCompanyId !== null) companyLimit = 1;

  return { dryRun, onlyCompanyId, companyLimit, projectLimit, refused, ignoredPurgeEnabledValue };
}
