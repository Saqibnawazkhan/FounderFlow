// @vitest-environment node
/**
 * prodready-014 — a Sentry event must say WHICH deployment it came from.
 *
 * `next build` sets `NODE_ENV=production` for PREVIEW deploys too, so an
 * `environment: process.env.NODE_ENV` files every pull-request failure under
 * Sentry's "production" environment. On-call then cannot tell a paying
 * customer's error from a teammate poking a branch, and alert rules plus
 * release-health metrics are computed over a mixed population — so either the
 * alerts get muted or a real spike hides inside preview traffic.
 *
 * This asserts the real options handed to `Sentry.init` by all THREE runtime
 * configs with an injected env, rather than grepping the source for
 * "VERCEL_ENV", because the trap has two halves:
 *
 *   (a) a preview deploy must not report itself as "production", and
 *   (b) local dev has no VERCEL_ENV at all, so the fallback must still read
 *       "development" rather than `undefined` — an event with no environment is
 *       no more triageable than one in the wrong environment.
 *
 * All three are in the loop deliberately. The edge config is the one that
 * initialises Sentry for middleware (the `auth.config.ts` route gate), and a
 * fix that lands in two of three files is the exact shape of half-configured
 * Sentry this repo already treats as worse than no Sentry at all.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const { initMock } = vi.hoisted(() => ({ initMock: vi.fn() }));

vi.mock("@sentry/nextjs", () => ({
  init: initMock,
  replayIntegration: vi.fn(() => ({ name: "Replay" })),
}));

const DSN = "https://examplePublicKey@o0.ingest.sentry.io/0";

/**
 * The three runtime inits, as thunks so `vi.resetModules()` can re-evaluate
 * them under a different env. Static specifiers: a dynamic `import(variable)`
 * is not resolvable through the "@" alias.
 */
const CONFIGS = [
  {
    label: "node runtime (sentry.server.config.ts)",
    load: () => import("@/sentry.server.config"),
  },
  {
    label: "browser (sentry.client.config.ts)",
    load: () => import("@/sentry.client.config"),
  },
  {
    label: "edge runtime (sentry.edge.config.ts)",
    load: () => import("@/sentry.edge.config"),
  },
] as const;

type Deployment = {
  /** What Vercel exposes. `undefined` models local dev / self-hosting. */
  vercelEnv?: string;
  nodeEnv: string;
};

/** Load one config under `deployment` and return the `environment` it reported. */
async function environmentReportedBy(
  config: (typeof CONFIGS)[number],
  deployment: Deployment
): Promise<unknown> {
  initMock.mockClear();
  vi.unstubAllEnvs();
  // Every config no-ops without a DSN, so both halves are set throughout.
  vi.stubEnv("SENTRY_DSN", DSN);
  vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", DSN);
  // Vercel sets the public mirror alongside the bare name when "Automatically
  // expose System Environment Variables" is on, which it is by default.
  vi.stubEnv("VERCEL_ENV", deployment.vercelEnv);
  vi.stubEnv("NEXT_PUBLIC_VERCEL_ENV", deployment.vercelEnv);
  vi.stubEnv("NODE_ENV", deployment.nodeEnv);
  vi.resetModules();
  await config.load();
  expect(initMock, `${config.label} never called Sentry.init with a DSN set`).toHaveBeenCalledTimes(
    1
  );
  return (initMock.mock.calls[0][0] as { environment?: unknown }).environment;
}

afterEach(() => {
  vi.unstubAllEnvs();
  initMock.mockClear();
});

describe("prodready-014 — Sentry's environment names the deployment, not NODE_ENV", () => {
  for (const config of CONFIGS) {
    describe(config.label, () => {
      it("reports a preview deploy as 'preview', not as 'production'", async () => {
        expect(
          await environmentReportedBy(config, { vercelEnv: "preview", nodeEnv: "production" }),
          `${config.label} files preview-deploy errors under Sentry's "production" environment, ` +
            "so on-call cannot separate real customer impact from a branch nobody has merged"
        ).toBe("preview");
      });

      it("reports a production deploy as 'production'", async () => {
        expect(
          await environmentReportedBy(config, { vercelEnv: "production", nodeEnv: "production" }),
          `${config.label} mislabels the customer-facing deployment`
        ).toBe("production");
      });

      it("still reports 'development' locally, where there is no VERCEL_ENV", async () => {
        expect(
          await environmentReportedBy(config, { nodeEnv: "development" }),
          `${config.label} loses the NODE_ENV fallback, so local dev and self-hosted ` +
            "deployments report an empty environment"
        ).toBe("development");
      });

      it("never reports an undefined environment", async () => {
        for (const deployment of [
          { vercelEnv: "production", nodeEnv: "production" },
          { vercelEnv: "preview", nodeEnv: "production" },
          { vercelEnv: "development", nodeEnv: "development" },
          { nodeEnv: "production" },
          { nodeEnv: "test" },
        ] satisfies Deployment[]) {
          expect(
            await environmentReportedBy(config, deployment),
            `${config.label} reported no environment at all for ${JSON.stringify(deployment)}`
          ).toBeTruthy();
        }
      });
    });
  }

  it("reads the browser-visible mirror in the browser bundle", async () => {
    // A bare `VERCEL_ENV` is not inlined into the client bundle, so the client
    // config must check `NEXT_PUBLIC_VERCEL_ENV` — otherwise every browser
    // crash falls through to NODE_ENV and says "production" on a preview.
    const client = CONFIGS[1];
    initMock.mockClear();
    vi.unstubAllEnvs();
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", DSN);
    vi.stubEnv("VERCEL_ENV", undefined);
    vi.stubEnv("NEXT_PUBLIC_VERCEL_ENV", "preview");
    vi.stubEnv("NODE_ENV", "production");
    vi.resetModules();
    await client.load();
    expect(
      (initMock.mock.calls[0][0] as { environment?: unknown }).environment,
      "the browser config ignores NEXT_PUBLIC_VERCEL_ENV, which is the only one of the two " +
        "that survives into the client bundle"
    ).toBe("preview");
  });
});
