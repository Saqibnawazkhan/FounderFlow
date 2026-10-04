/**
 * Structural guard: the Node.js runtime this app declares must be one that is
 * still receiving security patches, and every place that declares it must name
 * the same major.
 *
 * WHY THIS FILE EXISTS (go-live audit prodready-017). The repo pinned Node 20
 * in six places — `engines.node` in package.json, the mirrored copy in
 * package-lock.json, `.nvmrc`, and three `node-version:` keys across
 * `.github/workflows/` — while the machine that every `npm run build`,
 * `npm test` and `scripts/smoke-*.mjs` actually runs on reports v24. Two dates
 * had already passed and nothing in the repo noticed either:
 *
 *   2026-04-30  Node 20 left support. No further security patches, on the
 *               runtime that serves customer financial data.
 *   2026-10-01  Vercel disabled Node 20 for new deployments —
 *               vercel.com/changelog/node-js-20-is-being-deprecated:
 *               "Existing projects using 20 as the version for Functions will
 *               display an error when a new deployment is created." There is no
 *               automatic upgrade.
 *
 * WHY `engines.node` IS THE DEPLOY TARGET, not a note about it. Vercel reads
 * that field and it OVERRIDES the Node.js Version selected in Project Settings
 * (vercel.com/docs/functions/runtimes/node-js/node-js-versions, "Version
 * overrides in `package.json`": a project set to 20.x in the dashboard that
 * declares `24.x` here "will be deployed with the latest 24.x version"). So the
 * value in package.json is not documentation that can lag behind a dashboard —
 * it is the thing production runs, which is why a stale major here is a
 * production fact rather than a local inconvenience, and why no dashboard
 * change is needed for this pin to take effect.
 *
 * The pin is therefore checked instead of remembered, in the shape CLAUDE.md
 * uses for every other guard here: the assertions read the real files, the
 * end-of-life dates are written down next to their source, and a release line
 * nobody has entered in the table yet fails with instructions rather than
 * passing silently.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const WORKFLOW_DIR = join(".github", "workflows");

function repoText(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

/**
 * Node.js release lines, each with the date it stops receiving security
 * patches (nodejs.org/en/about/previous-releases) and whether Vercel will
 * deploy it (vercel.com/docs/functions/runtimes/node-js/node-js-versions).
 *
 * `offeredByVercel: false` for 20 is deliberate and is NOT the same thing as
 * the docs table, which still lists 20.x as an available version: the changelog
 * above disabled it for new deployments on 2026-10-01, and an erroring deploy is
 * not an available version. When a new line appears, add it here with its own
 * EOL date — the assertions below fail on an unlisted major on purpose, because
 * the failure that matters is nobody having looked the date up.
 */
const NODE_LINES: Record<string, { eol: string; offeredByVercel: boolean }> = {
  "18": { eol: "2025-04-30", offeredByVercel: false },
  "20": { eol: "2026-04-30", offeredByVercel: false },
  "22": { eol: "2027-04-30", offeredByVercel: true },
  "24": { eol: "2028-04-30", offeredByVercel: true },
};

/** `engines.node`, read off package.json rather than out of a comment. */
function declaredEngine(): string {
  const pkg = JSON.parse(repoText("package.json")) as {
    engines?: { node?: string };
  };
  return pkg.engines?.node ?? "";
}

/** The copy npm writes into the lock file's root entry. */
function lockEngine(): string {
  const lock = JSON.parse(repoText("package-lock.json")) as {
    packages?: Record<string, { engines?: { node?: string } }>;
  };
  return lock.packages?.[""]?.engines?.node ?? "";
}

/**
 * Every `node-version:` value under .github/workflows, with the file and line
 * it came from. Discovered by reading the directory, so a workflow added later
 * is swept too — the partial-bump failure mode this guards against is somebody
 * fixing one of ci.yml's two pins and leaving the other.
 */
function workflowNodePins(): Array<{ where: string; raw: string }> {
  const pins: Array<{ where: string; raw: string }> = [];
  const files = readdirSync(join(ROOT, WORKFLOW_DIR)).filter(
    (name) => name.endsWith(".yml") || name.endsWith(".yaml")
  );

  for (const name of files) {
    const lines = repoText(join(WORKFLOW_DIR, name)).split("\n");
    for (let i = 0; i < lines.length; i++) {
      const match = /^\s*node-version:\s*(.+?)\s*$/.exec(lines[i]);
      if (!match) continue;
      pins.push({
        where: `.github/workflows/${name}:${i + 1}`,
        raw: match[1].replace(/^["']|["']$/g, ""),
      });
    }
  }
  return pins;
}

const ENGINE = declaredEngine();
const ENGINE_MAJOR = /^(\d+)\.x$/.exec(ENGINE)?.[1] ?? "";

describe("Node runtime pin", () => {
  it("declares engines.node as a single major-only range, the only form Vercel maps", () => {
    // "Only major versions are available" — Vercel resolves `24.x` to the
    // latest 24 it runs. An exact `24.13.0` is not a version it offers, and a
    // wide range like `>=20` hides exactly the four-major drift this file exists
    // to stop.
    expect(ENGINE).toMatch(/^\d+\.x$/);
    expect(ENGINE_MAJOR).not.toBe("");
  });

  it("pins a release line that still receives security patches", () => {
    expect(
      Object.prototype.hasOwnProperty.call(NODE_LINES, ENGINE_MAJOR),
      `Node ${ENGINE_MAJOR} is not in NODE_LINES. Add it with its end-of-life date ` +
        `from nodejs.org/en/about/previous-releases before pinning it.`
    ).toBe(true);

    const line = NODE_LINES[ENGINE_MAJOR];
    const eol = new Date(`${line.eol}T00:00:00Z`).getTime();
    expect(
      eol > Date.now(),
      `package.json pins Node ${ENGINE_MAJOR}, which left support on ${line.eol}. ` +
        `It receives no further security patches, and this field is what Vercel ` +
        `deploys. Move engines.node, package-lock.json's root copy, .nvmrc and every ` +
        `node-version: in .github/workflows to a supported line together.`
    ).toBe(true);
  });

  it("pins a release line Vercel will actually deploy", () => {
    const line = NODE_LINES[ENGINE_MAJOR];
    expect(
      line.offeredByVercel,
      `Vercel does not deploy Node ${ENGINE_MAJOR}. Because engines.node overrides the ` +
        `dashboard's Node.js Version, this value alone decides the build: a line Vercel ` +
        `has retired fails the next production deploy outright.`
    ).toBe(true);
  });

  it("keeps the lock file's mirrored engines field in step with package.json", () => {
    // npm copies engines into packages[""] on install. Changing one by hand and
    // not the other leaves the lock claiming a runtime the project no longer
    // declares, which is the kind of quiet disagreement nobody reads a lock file
    // to find.
    expect(lockEngine()).toBe(ENGINE);
  });

  it("matches .nvmrc, so a local shell gets the version production runs", () => {
    expect(repoText(".nvmrc").trim()).toBe(ENGINE_MAJOR);
  });

  it("matches every node-version: in every workflow", () => {
    const pins = workflowNodePins();

    // Guard the sweep itself: if the regex or the directory walk ever stops
    // finding pins, these assertions would pass over nothing at all. Three is
    // what exists today (ci.yml twice, verify-backup-restore.yml once).
    expect(pins.length).toBeGreaterThanOrEqual(3);

    for (const pin of pins) {
      expect(pin.raw, `${pin.where} should pin a bare major, e.g. "24"`).toMatch(/^\d+$/);
      expect(
        pin.raw,
        `${pin.where} runs CI on Node ${pin.raw} while production runs ${ENGINE_MAJOR}. ` +
          `A green pipeline on a different major than the deploy target does not prove ` +
          `the deployed artifact works.`
      ).toBe(ENGINE_MAJOR);
    }
  });
});
