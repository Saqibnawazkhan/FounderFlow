/**
 * Behavioural tests for /api/cron/sweep-time-entries — the third nightly route,
 * and the last one still answering 206 with no heartbeat (cron-008,
 * prodready-003).
 *
 * WHAT WAS WRONG, IN THREE PARTS:
 *
 *   1. A partial failure answered `206 Partial Content`, with a comment saying
 *      Vercel's cron dashboard "sees the non-2xx". 206 IS a 2xx. Vercel read a
 *      permanently-failing sweep as a clean run every night and escalated
 *      nothing — the same defect already removed from the other two routes.
 *   2. There was no Sentry check-in, so the worst failure mode — the job never
 *      firing at all, because of a deploy window, a removed schedule or the
 *      Hobby cron limit — produced no response for anything to escalate on.
 *   3. A missing CRON_SECRET returned 500 in silence. A production deploy that
 *      loses the variable therefore fails every night for ever with nothing but
 *      a Vercel log line nobody reads.
 *
 * Nothing here touches a database: `@/lib/time/sweep` is replaced before the
 * route's module graph is built, so the handler runs for real against a
 * scripted sweep result. The schedule assertion reads vercel.json rather than
 * repeating it — a monitor whose crontab disagrees with the real one turns
 * Sentry's missed-beat alert into noise at a time nobody is awake.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SECRET = "sweep-secret-for-tests";

type SweepResult = { attempted: number; closed: string[]; failed: { id: string; error: string }[] };

const H = vi.hoisted(() => ({
  result: { attempted: 0, closed: [] as string[], failed: [] as { id: string; error: string }[] },
  fail: null as Error | null,
  runs: 0,
}));

vi.mock("@/lib/time/sweep", () => ({
  sweepAutoCloseEntries: async () => {
    H.runs += 1;
    if (H.fail) throw H.fail;
    return H.result;
  },
}));

const sentry = {
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  captureCheckIn: vi.fn(() => "check-in-id"),
};
vi.mock("@sentry/nextjs", () => sentry);

async function run(headers?: Record<string, string>) {
  const mod = await import("@/app/api/cron/sweep-time-entries/route");
  const res = await mod.GET(
    new Request("https://app.test/api/cron/sweep-time-entries", { headers })
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function authorized() {
  return { authorization: `Bearer ${SECRET}` };
}

function checkIns(): Array<{ status: string; monitorSlug: string }> {
  return (sentry.captureCheckIn.mock.calls as unknown as unknown[][]).map(
    (c) => c[0] as { status: string; monitorSlug: string }
  );
}

function setSweep(result: Partial<SweepResult>) {
  H.result = {
    attempted: result.attempted ?? 0,
    closed: result.closed ?? [],
    failed: result.failed ?? [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = SECRET;
  H.fail = null;
  H.runs = 0;
  setSweep({ attempted: 2, closed: ["te-1", "te-2"] });
});

describe("cron-008 — a half-failed sweep has to reach a human", () => {
  it("answers 5xx, not 206, when an entry could not be closed", async () => {
    setSweep({
      attempted: 3,
      closed: ["te-1", "te-2"],
      failed: [{ id: "te-3", error: "deadlock detected" }],
    });

    const { status, body } = await run(authorized());

    expect(
      status,
      "206 is a 2xx — Vercel's cron view read a permanently failing sweep as a successful run"
    ).toBeGreaterThanOrEqual(500);
    expect(body.ok).toBe(false);
    expect(body.entriesFailed).toBe(1);
    expect(body.entriesAutoClosed, "the rows that DID close are still reported").toBe(2);
  });

  it("still answers 200 for a clean night", async () => {
    const { status, body } = await run(authorized());
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.entriesAutoClosed).toBe(2);
  });

  it("sends a Sentry cron check-in, so a night that never runs also alerts", async () => {
    await run(authorized());

    const statuses = checkIns().map((c) => c.status);
    expect(statuses).toContain("in_progress");
    expect(statuses).toContain("ok");
    expect(checkIns()[0].monitorSlug).toContain("sweep-time-entries");
  });

  it("closes the check-in as an error when the sweep partially failed", async () => {
    setSweep({ attempted: 1, closed: [], failed: [{ id: "te-9", error: "row is locked" }] });
    await run(authorized());

    const statuses = checkIns().map((c) => c.status);
    expect(statuses).toContain("error");
    expect(statuses, "a partial failure is not a green heartbeat").not.toContain("ok");
  });

  it("closes the check-in as an error when the sweep throws outright", async () => {
    H.fail = new Error("Can't reach database server");
    const { status } = await run(authorized());

    expect(status).toBe(500);
    expect(sentry.captureException).toHaveBeenCalled();
    expect(checkIns().map((c) => c.status)).toContain("error");
  });

  it("registers the crontab from vercel.json, so a missed beat is a real alert", async () => {
    const vercel = JSON.parse(readFileSync(join(process.cwd(), "vercel.json"), "utf8")) as {
      crons: Array<{ path: string; schedule: string }>;
    };
    const scheduled = vercel.crons.filter((c) => c.path === "/api/cron/sweep-time-entries")[0];
    expect(scheduled, "vercel.json no longer schedules this route").toBeTruthy();

    await run(authorized());

    const config = (sentry.captureCheckIn.mock.calls as unknown as unknown[][])[0][1] as {
      schedule: { type: string; value: string };
    };
    expect(config.schedule.type).toBe("crontab");
    expect(
      config.schedule.value,
      "the monitor's crontab must equal the one Vercel fires on, or Sentry's missed-beat " +
        "alert is wrong at 00:10 UTC"
    ).toBe(scheduled.schedule);
  });
});

describe("the heartbeat belongs to the JOB, not to whoever hits the URL", () => {
  it("does not check in — or sweep — for a caller with the wrong secret", async () => {
    const { status } = await run({ authorization: "Bearer nope" });

    expect(status).toBe(401);
    expect(H.runs, "an unauthenticated probe must not run the sweep").toBe(0);
    expect(
      sentry.captureCheckIn,
      "a port scan that closed the heartbeat would page on-call, or worse, mark a night green"
    ).not.toHaveBeenCalled();
  });

  it("does not check in for a caller with no Authorization header at all", async () => {
    const { status } = await run();
    expect(status).toBe(401);
    expect(sentry.captureCheckIn).not.toHaveBeenCalled();
  });
});

describe("prodready-003 — a missing CRON_SECRET must not fail silently", () => {
  it("raises a Sentry event before answering 500", async () => {
    delete process.env.CRON_SECRET;

    const { status } = await run(authorized());

    expect(status).toBe(500);
    expect(
      sentry.captureException,
      "the variable disappearing after a green build means this job 500s every night for " +
        "ever; the only way anyone finds out is if it says so"
    ).toHaveBeenCalled();
    expect(H.runs).toBe(0);
  });
});

/* ── drift guard, over EVERY scheduled route ───────────────────────────── */

/**
 * The behavioural tests above cover one route. This covers the shape, for every
 * cron in vercel.json, because the defect they close took three separate fixes
 * over three waves and the third sat unnoticed for two of them: two routes were
 * repaired, the comment in lib/cron/monitor.ts recorded that the third was not,
 * and nothing failed while it stayed that way.
 *
 * Derived from vercel.json, so a FOURTH nightly job is covered the day it is
 * scheduled rather than the day someone remembers this file.
 */
describe("every scheduled cron route escalates the same way", () => {
  const ROOT = process.cwd();
  const crons = (
    JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf8")) as {
      crons: Array<{ path: string; schedule: string }>;
    }
  ).crons;

  /** `app/api/cron/<segment>/route.ts` for a `/api/cron/<segment>` cron path. */
  function sourceOf(path: string): string {
    const segments = path.replace(/^\//, "").split("/");
    return readFileSync(join(ROOT, "app", ...segments, "route.ts"), "utf8");
  }

  /**
   * Blank out comments and string contents, preserving length.
   *
   * Necessary, not fastidious: every one of these routes DISCUSSES 206 at
   * length in its header — that is where the reasoning for not returning one
   * lives — so a raw text search for "206" matches the explanation and the
   * assertion below would be permanently, silently red.
   */
  function codeOnly(src: string): string {
    const out = src.split("");
    let i = 0;
    let quote = "";
    while (i < src.length) {
      const c = src[i];
      const next = i + 1 < src.length ? src[i + 1] : "";
      if (quote) {
        if (c === "\\") {
          out[i] = " ";
          out[i + 1] = " ";
          i += 2;
          continue;
        }
        if (c === quote) quote = "";
        else out[i] = " ";
        i += 1;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        quote = c;
        i += 1;
        continue;
      }
      if (c === "/" && next === "/") {
        while (i < src.length && src[i] !== "\n") {
          out[i] = " ";
          i += 1;
        }
        continue;
      }
      if (c === "/" && next === "*") {
        while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
          out[i] = " ";
          i += 1;
        }
        out[i] = " ";
        out[i + 1] = " ";
        i += 2;
        continue;
      }
      i += 1;
    }
    return out.join("");
  }

  /** The body of `if (!expected) { … }` — the missing-secret branch. */
  function missingSecretBranch(src: string): string {
    const start = src.indexOf("if (!expected) {");
    if (start === -1) return "";
    let depth = 0;
    for (let i = src.indexOf("{", start); i < src.length; i += 1) {
      if (src[i] === "{") depth += 1;
      else if (src[i] === "}") {
        depth -= 1;
        if (depth === 0) return src.slice(start, i + 1);
      }
    }
    return "";
  }

  it("schedules at least the three nightly jobs", () => {
    expect(crons.length, "vercel.json lost its crons, so this whole block is vacuous").toBe(3);
  });

  for (const cron of crons) {
    describe(cron.path, () => {
      it("runs inside a Sentry check-in registered with ITS OWN crontab", () => {
        const src = sourceOf(cron.path);
        // Comments stripped: a route that merely MENTIONS the wrapper in a
        // docstring is precisely the state this whole block exists to catch.
        expect(codeOnly(src), "not wrapped — a night that never fires alerts nobody").toContain(
          "withCronCheckIn("
        );

        const monitor = /const MONITOR = \{ slug: "([^"]+)", schedule: "([^"]+)" \}/.exec(src);
        expect(monitor, "no MONITOR declaration to check the schedule against").toBeTruthy();
        const found = monitor as RegExpExecArray;
        expect(cron.path).toContain(found[1]);
        expect(
          found[2],
          "the monitor's crontab disagrees with vercel.json, so Sentry expects the beat at the " +
            "wrong time and alerts on a job that ran"
        ).toBe(cron.schedule);
      });

      it("never answers 206 to a partial failure", () => {
        expect(
          codeOnly(sourceOf(cron.path)),
          "206 is a 2xx: Vercel's cron view reads it as a successful invocation"
        ).not.toContain("206");
      });

      it("captures the missing-CRON_SECRET misconfiguration before answering 500", () => {
        const branch = missingSecretBranch(codeOnly(sourceOf(cron.path)));
        expect(branch, "no `if (!expected)` branch — is this route gated at all?").not.toBe("");
        expect(
          branch,
          "failing closed in silence means every night fails behind a Vercel log line"
        ).toContain("captureServerError");
      });

      it("opens the check-in AFTER the secret check", () => {
        const src = codeOnly(sourceOf(cron.path));
        expect(
          src.indexOf("withCronCheckIn("),
          "an unauthenticated probe must not be able to open or close the heartbeat"
        ).toBeGreaterThan(src.indexOf("if (!expected) {"));
      });
    });
  }
});

/* ── cron-011 ──────────────────────────────────────────────────────────── */

/**
 * cron-011 — the 100-row canary existed and neither nightly job was wired to it.
 *
 * `lib/safety/bulk-mutation-guard.ts` was built so that "an admin clicked
 * something and 12,000 rows disappeared" is visible in the ops feed. Nine call
 * sites use it — every workspace/project/task/transaction bulk mutation, and the
 * purge — and the two jobs that write across EVERY tenant with no ceiling did
 * not. A `lastActivityAt` regression could have closed every open timer in the
 * product in one night, silently.
 *
 * These assert the Sentry event, not the call: `@sentry/nextjs` is already faked
 * at the top of this file, and `warnBulkMutation` is telemetry — the event IS the
 * behaviour. A structural "does this file mention warnBulkMutation" assertion
 * would pass on an import.
 */
function bulkMutationEvents(): Array<{ message: string; tags: Record<string, string> }> {
  return (sentry.captureMessage.mock.calls as unknown as unknown[][])
    .map((c) => ({
      message: String(c[0]),
      tags: ((c[1] as { tags?: Record<string, string> })?.tags ?? {}) as Record<string, string>,
    }))
    .filter((e) => e.tags.boundary === "bulk-mutation");
}

describe("cron-011 — an outsized sweep trips the bulk-mutation canary", () => {
  it("fires the canary when one night closes more than a hundred timers", async () => {
    const many: string[] = [];
    for (let i = 0; i < 150; i += 1) many.push(`te-${i}`);
    setSweep({ attempted: 150, closed: many });

    const res = await run(authorized());
    expect(res.status).toBe(200);

    const events = bulkMutationEvents();
    expect(events).toHaveLength(1);
    expect(events[0].tags.action).toBe("sweepTimeEntries");
    expect(events[0].message).toMatch(/150 rows/);
  });

  it("stays quiet on an ordinary night — the canary must mean something", async () => {
    setSweep({ attempted: 3, closed: ["te-1", "te-2", "te-3"] });
    await run(authorized());
    expect(bulkMutationEvents()).toEqual([]);
  });

  it("counts what was CLOSED, not what was attempted", async () => {
    // A night that finds 400 stale entries and fails to close all but two has a
    // different problem, and the per-entry failures are already in Sentry. The
    // canary is about rows that changed.
    const attempted: string[] = [];
    for (let i = 0; i < 400; i += 1) attempted.push(`te-${i}`);
    setSweep({
      attempted: 400,
      closed: ["te-0", "te-1"],
      failed: attempted.slice(2).map((id) => ({ id, error: "boom" })),
    });
    await run(authorized());
    expect(bulkMutationEvents()).toEqual([]);
  });
});
