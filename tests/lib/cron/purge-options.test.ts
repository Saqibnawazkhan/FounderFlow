/**
 * cron-012 — an irreversible multi-tenant erasure must be aimable at one
 * workspace before it is aimed at all of them.
 *
 * Whether the nightly purge destroyed anything came from one process-wide env
 * var and nothing else, so the first live run was simultaneously the first
 * measurement and the irreversible one, across every overdue workspace at once.
 * CLAUDE.md calls the purge "safe to enable" and the memory note says "exercise
 * the purge"; neither was possible.
 *
 * THE INVARIANT THESE TESTS EXIST FOR: a query parameter may only make a run
 * SAFER. The two directions are not symmetrical and the asymmetry is the point —
 * `?dryRun=1` is honoured, `?dryRun=0` is refused, because the caller holding
 * CRON_SECRET is not a good enough reason to let a URL erase customer
 * workspaces. The most dangerous single line this file guards is the one that
 * would read `dryRun = params.get("dryRun") === "1"`, which looks equivalent and
 * lets `?dryRun=0` turn destruction ON.
 *
 * The filing also claimed the run was unbounded. It is not, and has not been
 * since `MAX_COMPANIES_PER_RUN` landed — so nothing here re-litigates that; the
 * caps are treated as the numbers to be clamped against.
 */

import { describe, it, expect } from "vitest";
import { decidePurgeOptions, type PurgeRunCaps } from "@/lib/cron/purge-options";

/** The route's own ceilings, passed in so this module stays pure. */
const CAPS: PurgeRunCaps = { companies: 10, projects: 200 };

const LIVE = { PURGE_ENABLED: "true" };
const OFF = { PURGE_ENABLED: undefined };

function decide(query: string, env: Record<string, string | undefined> = LIVE) {
  return decidePurgeOptions(new URLSearchParams(query), env, CAPS);
}

describe("cron-012 — a parameter may only make the run safer", () => {
  it("lets ?dryRun=1 force a dry run on a deployment where the purge is live", () => {
    const o = decide("dryRun=1");
    expect(o.dryRun).toBe(true);
    expect(o.refused).toEqual([]);
  });

  it("accepts the other spellings of yes", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on", " true "]) {
      expect(decide(`dryRun=${encodeURIComponent(v)}`).dryRun, v).toBe(true);
    }
  });

  it("REFUSES ?dryRun=0 — a URL must never authorise destruction", () => {
    // The whole finding in one assertion. If this ever passes `dryRun: false`,
    // anyone holding the cron secret can erase every overdue workspace from a
    // browser address bar on a deployment that deliberately has the purge off.
    for (const v of ["0", "false", "no", "off"]) {
      const o = decide(`dryRun=${v}`, OFF);
      expect(o.dryRun, v).toBe(true);
      expect(o.refused.join(" "), v).toMatch(/PURGE_ENABLED/);
    }
  });

  it("reports the refusal on a LIVE deployment too, where it changes nothing", () => {
    // `dryRun=false` is never honoured — it is ignored, so the env var still
    // decides, and on a live deployment that means a live run. The refusal is
    // still reported, so the message does not depend on configuration the
    // operator cannot see from the response. Silence here would teach whoever
    // typed it that the parameter works.
    const o = decide("dryRun=false", LIVE);
    expect(o.dryRun).toBe(false);
    expect(o.refused).toHaveLength(1);
  });

  it("reports a value that is not a boolean instead of guessing", () => {
    const o = decide("dryRun=maybe", LIVE);
    expect(o.dryRun).toBe(false); // unchanged: the env var still decides
    expect(o.refused.join(" ")).toMatch(/not a boolean/);
  });

  it("keeps the env var as the default when no parameter is given", () => {
    expect(decide("", LIVE).dryRun).toBe(false);
    expect(decide("", OFF).dryRun).toBe(true);
    expect(decide("", { PURGE_ENABLED: "TRUE" }).dryRun).toBe(true); // cron-017: only "true"
  });
});

describe("cron-012 — one workspace at a time", () => {
  it("narrows the run to a single workspace id", () => {
    const o = decide("companyId=c_nimbus");
    expect(o.onlyCompanyId).toBe("c_nimbus");
    // A single-workspace run with a ceiling of 10 would make the response's own
    // counters misleading.
    expect(o.companyLimit).toBe(1);
  });

  it("treats an empty companyId as a mistake, not as 'all of them'", () => {
    const o = decide("companyId=");
    expect(o.onlyCompanyId).toBeNull();
    expect(o.refused.join(" ")).toMatch(/companyId was empty/);
  });

  it("combines with a forced dry run, which is how the first rehearsal is done", () => {
    const o = decide("companyId=c_nimbus&dryRun=1", LIVE);
    expect(o).toMatchObject({ dryRun: true, onlyCompanyId: "c_nimbus", companyLimit: 1 });
  });
});

describe("cron-012 — a limit may only come down", () => {
  it("lowers the workspace ceiling", () => {
    expect(decide("limit=3").companyLimit).toBe(3);
  });

  it("clamps a request above the built-in cap and says so", () => {
    const o = decide("limit=5000");
    expect(o.companyLimit).toBe(CAPS.companies);
    expect(o.refused.join(" ")).toMatch(/exceeds the built-in cap of 10/);
  });

  it("refuses a limit that is not a positive integer rather than coercing it", () => {
    for (const v of ["0", "-5", "abc", "1e3", "2.5", "12abc", ""]) {
      const o = decide(`limit=${encodeURIComponent(v)}`);
      expect(o.companyLimit, v).toBe(CAPS.companies);
      expect(o.refused.length, v).toBeGreaterThan(0);
    }
  });

  it("does the same for the orphan-project ceiling, independently", () => {
    const o = decide("projectLimit=25");
    expect(o.projectLimit).toBe(25);
    expect(o.companyLimit).toBe(CAPS.companies);
    expect(decide("projectLimit=999").projectLimit).toBe(CAPS.projects);
  });

  it("defaults both ceilings to the route's own caps", () => {
    const o = decide("");
    expect(o).toMatchObject({
      companyLimit: CAPS.companies,
      projectLimit: CAPS.projects,
      onlyCompanyId: null,
      refused: [],
    });
  });
});

describe("cron-012 — an ordinary cron invocation is unchanged", () => {
  it("behaves exactly as before when Vercel calls the URL with no parameters", () => {
    expect(decide("", OFF)).toEqual({
      dryRun: true,
      onlyCompanyId: null,
      companyLimit: CAPS.companies,
      projectLimit: CAPS.projects,
      refused: [],
      ignoredPurgeEnabledValue: null,
    });
  });
});

describe("cron-017 — a typo in PURGE_ENABLED must not be silent", () => {
  it("reports a value that plainly means 'on' but is not exactly true", () => {
    // The fail-safe DIRECTION is right and stays: only `"true"` arms the purge.
    // What was missing is any signal. An owner who sets TRUE, sees a green cron
    // and believes 90-day erasure is live now has a compliance answer that is
    // wrong in the direction of "we still have your data", and the reverse typo
    // is harmless — which is exactly what makes this easy to miss.
    for (const v of ["TRUE", "True", "1", "yes", "on", "true ", " true"]) {
      const o = decidePurgeOptions(new URLSearchParams(""), { PURGE_ENABLED: v }, CAPS);
      expect(o.dryRun, v).toBe(true);
      expect(o.ignoredPurgeEnabledValue, v).toBe(v);
    }
  });

  it("says nothing when the variable is exactly true, or absent, or a plain off", () => {
    for (const env of [{ PURGE_ENABLED: "true" }, {}, { PURGE_ENABLED: "" }] as Array<
      Record<string, string | undefined>
    >) {
      const o = decidePurgeOptions(new URLSearchParams(""), env, CAPS);
      expect(o.ignoredPurgeEnabledValue, JSON.stringify(env)).toBeNull();
    }
  });

  it("reports a deliberate off-value too, because it is still not a recognised spelling", () => {
    // "false" is the documented way to mean off elsewhere in this project, so it
    // is NOT reported; anything else is, including a value someone thought was
    // off but is not a spelling this code knows.
    expect(
      decidePurgeOptions(new URLSearchParams(""), { PURGE_ENABLED: "false" }, CAPS)
        .ignoredPurgeEnabledValue
    ).toBeNull();
    expect(
      decidePurgeOptions(new URLSearchParams(""), { PURGE_ENABLED: "disabled" }, CAPS)
        .ignoredPurgeEnabledValue
    ).toBe("disabled");
  });
});
