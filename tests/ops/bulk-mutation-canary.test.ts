/**
 * `warnBulkMutation` — the Tier 3 canary, tested directly for the first time.
 *
 * WHY (audit harness-014, item 5). This is the last line of defence against "a
 * bug wiped 10,000 rows overnight and nobody noticed until a customer wrote in".
 * It is wired into nine mutation paths including all four stages of the nightly
 * purge, and until now it appeared in the suite exclusively as a `vi.mock`
 * target:
 *
 *     vi.mock("@/lib/safety/bulk-mutation-guard", () => ({ warnBulkMutation: vi.fn() }));
 *
 * — in seven files (account-security-notices, auth-gate-wiring,
 * bulk-task-selection-limit, last-member-race, project-update-concurrency,
 * soft-delete, workspace-lifecycle; an eighth grep hit is the illustrative line
 * just above, inside this comment). That asserts that a caller calls a stub,
 * seven times over. It says nothing about
 * whether the real function fires, what it tags the event with, or whether it can
 * throw. Its whole job runs unattended at 03:15 UTC with no human behind it, so
 * "does it actually report?" is not a question anyone would discover the answer
 * to by using the product.
 *
 * THREE PROPERTIES, and each is a way this could be useless without anyone
 * noticing:
 *   1. It is SILENT at and below the threshold. A canary that cries on every
 *      ordinary mutation gets its alert rule muted within a week, and then it is
 *      gone for the one night that matters.
 *   2. It fires ABOVE the threshold with the tags the alert rule keys on. The
 *      rule pages on-call off `boundary: bulk-mutation`; a renamed tag is a
 *      silently disabled pager.
 *   3. It NEVER THROWS, even when Sentry does. It is called AFTER the mutation
 *      has already committed, so throwing here turns a successful delete into a
 *      500 for the user and, in the cron, aborts the remaining purge stages.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mocks: the module under test imports both of these at load time.
const captureMessage = vi.hoisted(() => vi.fn());
const captureServerError = vi.hoisted(() => vi.fn());

vi.mock("@sentry/nextjs", () => ({ captureMessage }));
vi.mock("@/lib/sentry-server", () => ({ captureServerError }));

import { BULK_MUTATION_THRESHOLD, warnBulkMutation } from "@/lib/safety/bulk-mutation-guard";

beforeEach(() => {
  captureMessage.mockReset();
  captureServerError.mockReset();
});

afterEach(() => {
  captureMessage.mockReset();
  captureServerError.mockReset();
});

describe("warnBulkMutation — silence below the threshold", () => {
  it("says nothing for an ordinary mutation", () => {
    warnBulkMutation(1, { action: "deleteTransaction" });
    warnBulkMutation(42, { action: "bulkDeleteTasks" });
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it("says nothing AT the threshold, only above it", () => {
    // The boundary, spelled out: `count <= threshold` returns. 100 rows is the
    // documented normal ceiling for a first-week workspace, so firing at exactly
    // 100 would page on-call for a legitimate delete.
    warnBulkMutation(BULK_MUTATION_THRESHOLD, { action: "deleteWorkspace" });
    expect(captureMessage).not.toHaveBeenCalled();

    warnBulkMutation(BULK_MUTATION_THRESHOLD + 1, { action: "deleteWorkspace" });
    expect(captureMessage).toHaveBeenCalledTimes(1);
  });

  it("honours a caller-supplied threshold in both directions", () => {
    warnBulkMutation(10, { action: "purgeCompanies" }, 10);
    expect(captureMessage).not.toHaveBeenCalled();
    warnBulkMutation(11, { action: "purgeCompanies" }, 10);
    expect(captureMessage).toHaveBeenCalledTimes(1);
  });
});

describe("warnBulkMutation — what the alert rule keys on", () => {
  it("tags the event so one Sentry rule can page on-call", () => {
    // `boundary: bulk-mutation` is the tag the rule matches. Renaming it does not
    // break a single other thing in the repo, which is exactly why it needs a
    // test: the pager just stops.
    warnBulkMutation(12_000, {
      action: "purgeSoftDeleted",
      userId: "demo-saqib",
      companyId: "demo-nimbus",
      extra: { tables: ["Transaction", "Task"] },
    });

    expect(captureMessage).toHaveBeenCalledTimes(1);
    const [message, options] = captureMessage.mock.calls[0]!;

    expect(message).toContain("purgeSoftDeleted");
    expect(message).toContain("12000");
    expect(options.level).toBe("warning");
    expect(options.tags.boundary).toBe("bulk-mutation");
    expect(options.tags.action).toBe("purgeSoftDeleted");
    expect(options.tags.companyId).toBe("demo-nimbus");
    expect(options.user).toEqual({ id: "demo-saqib" });
    // The row count has to be IN the event, not only in the message string: the
    // message is a title and gets grouped, the extra is what you read.
    expect(options.extra.rowCount).toBe(12_000);
    expect(options.extra.threshold).toBe(BULK_MUTATION_THRESHOLD);
    expect(options.extra.tables).toEqual(["Transaction", "Task"]);
  });

  it("omits companyId and user rather than tagging them undefined", () => {
    // The cron has no user behind it. A tag whose value is the string
    // "undefined" is worse than an absent one: it groups every unattended run
    // together under a fake identity.
    warnBulkMutation(500, { action: "materializeRecurring" });
    const [, options] = captureMessage.mock.calls[0]!;
    expect(Object.prototype.hasOwnProperty.call(options.tags, "companyId")).toBe(false);
    expect(options.user).toBeUndefined();
  });
});

describe("warnBulkMutation — it must not punish its caller", () => {
  it("does not throw when Sentry throws", () => {
    // It is called AFTER the mutation commits. Throwing here turns a successful
    // workspace delete into a 500, and in the purge cron it aborts every
    // remaining stage — so a telemetry outage would become data left unpurged.
    captureMessage.mockImplementation(() => {
      throw new Error("Sentry transport is down");
    });

    expect(() => warnBulkMutation(9_000, { action: "deleteWorkspace" })).not.toThrow();

    // ...and it reports its own failure through the local helper, which no-ops
    // when SENTRY_DSN is unset. Swallowing silently would make a broken canary
    // indistinguishable from a quiet night.
    expect(captureServerError).toHaveBeenCalledTimes(1);
    const [err, ctx] = captureServerError.mock.calls[0]!;
    expect((err as Error).message).toBe("Sentry transport is down");
    expect(ctx).toEqual({ action: "warnBulkMutation" });
  });

  it("does not call the fallback when Sentry behaves", () => {
    warnBulkMutation(9_000, { action: "deleteWorkspace" });
    expect(captureServerError).not.toHaveBeenCalled();
  });
});

describe("the threshold itself", () => {
  it("is a real number the callers can read", () => {
    // Exported so nine call sites do not each pick their own. A caller passing a
    // literal is how the nine drift apart.
    expect(BULK_MUTATION_THRESHOLD).toBe(100);
  });
});
