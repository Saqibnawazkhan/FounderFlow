/**
 * The document title of /projects/[id] is a cross-tenant read. Finding sec-003.
 *
 * WHY THIS TEST EXISTS. `generateMetadata` ran its own
 * `db.project.findUnique({ where: { id: params.id }, select: { name: true } })`
 * — no `companyId`, no `deletedAt: null`, no session check of any kind — and
 * used the row's name as the `<title>`. The page body below it 404s correctly
 * via `getProjectForUser`, but by then the metadata read has already fetched a
 * row from an arbitrary tenant. So a signed-in user who typed another
 * company's project URL got a page reading "not found" whose browser tab (and
 * `<head>`) carried the other company's project name — usually a client or a
 * deal name. It also made the deliberate 404-rather-than-403 choice pointless:
 * the title confirmed both that the id existed and what it was.
 *
 * WHY IT LOOKS LIKE THIS. Same reasoning as
 * tests/lib/queries/search-scoping.test.ts and
 * tests/lib/queries/projects-scope.test.ts: there is no database here, so
 * nothing below can assert which row came back. It does not need to. The
 * property at stake is a property of the QUESTION ASKED — every read driven by
 * a client-supplied id must carry the asker's own company id — and that is
 * visible in the calls the module makes. The Prisma client is replaced with a
 * recorder and the assertions run over the recording.
 *
 * lib/auth/** and lib/queries/projects.ts are deliberately NOT mocked: the
 * real scoped query is what this page is supposed to be going through.
 */

import { readFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScopedSession } from "@/lib/queries/session";

type RecordedCall = { delegate: string; method: string; args: unknown[] };

const prisma = vi.hoisted(() => {
  const calls: { delegate: string; method: string; args: unknown[] }[] = [];
  const answers = new Map<string, unknown>();

  function record(delegate: string, method: string, args: unknown[]) {
    calls.push({ delegate, method, args });
    const key = delegate + "." + method;
    if (answers.has(key)) return Promise.resolve(answers.get(key));
    return Promise.resolve(null);
  }

  // A Proxy, not a hand-written fake: a delegate added to this page's graph
  // later is recorded and scope-checked without this file being edited.
  const delegates = new Map<string, unknown>();
  function delegateFor(name: string) {
    const existing = delegates.get(name);
    if (existing) return existing;
    const made = new Proxy(
      {},
      {
        get(_target, method) {
          if (typeof method !== "string") return undefined;
          return (...args: unknown[]) => record(name, method, args);
        },
      }
    );
    delegates.set(name, made);
    return made;
  }

  const db = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== "string") return undefined;
        return delegateFor(prop);
      },
    }
  );

  return { calls, answers, db };
});

const session = vi.hoisted(() => ({
  current: {
    userId: "u_admin",
    userName: "Ayesha",
    email: "ayesha@nimbus.app",
    companyId: "c_nimbus",
    role: "admin",
  } as ScopedSession,
  /** True -> requireScopedSession rejects, the way it does with no cookie. */
  missing: false,
}));

vi.mock("@/lib/db", () => ({ db: prisma.db }));

vi.mock("@/lib/queries/session", () => ({
  requireScopedSession: () =>
    session.missing
      ? Promise.reject(new Error("Not authenticated"))
      : Promise.resolve(session.current),
}));

// The page's own client component is a leaf as far as this test is concerned;
// stubbing it keeps the whole component tree out of the module graph.
vi.mock("@/app/(app)/projects/[id]/project-detail-client", () => ({
  ProjectDetailClient: () => null,
}));

/** The other workspace's project name. Distinctive so a leak is unmistakable. */
const RIVAL_PROJECT_NAME = "Falcon acquisition diligence";

function ownProjectRow() {
  return {
    id: "p_nimbus",
    companyId: "c_nimbus",
    name: "Nimbus Rebuild",
    description: null,
    supervisorId: "u_admin",
    status: "active",
    color: "#fff",
    targetEndDate: null,
    createdBy: "u_admin",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    supervisor: { name: "Sana" },
  };
}

beforeEach(() => {
  prisma.calls.length = 0;
  prisma.answers.clear();
  session.missing = false;
  session.current = {
    userId: "u_admin",
    userName: "Ayesha",
    email: "ayesha@nimbus.app",
    companyId: "c_nimbus",
    role: "admin",
  };
});

function projectReads(): RecordedCall[] {
  return prisma.calls.filter((c) => c.delegate === "project");
}

describe("generateMetadata for /projects/[id]", () => {
  it("does not put another company's project name in the page title", async () => {
    // The unscoped `findUnique` this page used to run would find the row by id
    // alone, whatever tenant it belongs to. The fake client answers BOTH shapes
    // with the rival row, so the only way the title comes back generic is that
    // the read carried a companyId the row does not match — i.e. the scoped
    // query missed, which is the whole mechanism.
    prisma.answers.set("project.findUnique", {
      ...ownProjectRow(),
      id: "p_rival",
      companyId: "c_rival",
      name: RIVAL_PROJECT_NAME,
    });
    // What a SCOPED read gets for a foreign id: nothing.
    prisma.answers.set("project.findFirst", null);

    const { generateMetadata } = await import("@/app/(app)/projects/[id]/page");
    const meta = await generateMetadata({ params: { id: "p_rival" } });

    expect(meta.title).toBe("Project");
    expect(JSON.stringify(meta)).not.toContain(RIVAL_PROJECT_NAME);
  });

  it("scopes every project read it makes to the caller's own company and to live rows", async () => {
    prisma.answers.set("project.findFirst", ownProjectRow());

    const { generateMetadata } = await import("@/app/(app)/projects/[id]/page");
    await generateMetadata({ params: { id: "p_nimbus" } });

    const reads = projectReads();
    // Not vacuous: the metadata function did ask the database something.
    expect(reads.length).toBeGreaterThan(0);

    for (const read of reads) {
      const where = (read.args[0] as { where?: Record<string, unknown> } | undefined)?.where;
      expect(where, `${read.delegate}.${read.method} has no where clause`).toBeDefined();
      expect(where, `${read.delegate}.${read.method}`).toHaveProperty("companyId", "c_nimbus");
      expect(where, `${read.delegate}.${read.method}`).toHaveProperty("deletedAt", null);
    }
  });

  it("never reads a project by bare id — findUnique cannot carry a tenancy filter", async () => {
    // `findUnique` takes a unique selector, so there is no way to add
    // `companyId` to it. Its presence on this path IS the finding, and a
    // scoped rewrite that kept it would pass the test above by accident.
    prisma.answers.set("project.findFirst", ownProjectRow());

    const { generateMetadata } = await import("@/app/(app)/projects/[id]/page");
    await generateMetadata({ params: { id: "p_nimbus" } });

    expect(projectReads().map((r) => r.method)).not.toContain("findUnique");
  });

  it("titles the page with the project's own name for someone allowed to see it", async () => {
    // The converse, so the first test cannot pass by the title being broken
    // for everybody.
    prisma.answers.set("project.findFirst", ownProjectRow());

    const { generateMetadata } = await import("@/app/(app)/projects/[id]/page");
    const meta = await generateMetadata({ params: { id: "p_nimbus" } });

    expect(meta.title).toBe("Nimbus Rebuild");
  });

  it("returns the generic title instead of throwing when there is no session", async () => {
    // `generateMetadata` runs before the page body, and a throw here is a 500
    // on a page that would otherwise render its own not-found.
    session.missing = true;

    const { generateMetadata } = await import("@/app/(app)/projects/[id]/page");
    const meta = await generateMetadata({ params: { id: "p_nimbus" } });

    expect(meta.title).toBe("Project");
  });
});

/**
 * The structural half of the same fix.
 *
 * The behavioural tests above prove the title is scoped TODAY. This proves the
 * shape that produced sec-003 cannot come back: a route file that cannot reach
 * the Prisma client cannot issue an unscoped read. Every project read this
 * route group needs already exists as a scoped function in
 * lib/queries/projects.ts, so there is no legitimate reason for one of these
 * files to hold `db` — and the one that did held it ONLY for the metadata read.
 *
 * Scoped to this route group rather than to all of `app/**`: the unauthenticated
 * invite page (app/invite/[token]/page.tsx) looks a row up by token with no
 * session to scope by, which is correct there and would make a blanket rule a
 * false positive.
 */
describe("the projects route group", () => {
  const ROUTE_DIR = path.resolve(__dirname, "../../../app/(app)/projects");

  function routeFilesUnder(dir: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        for (const nested of routeFilesUnder(full)) found.push(nested);
      } else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) {
        found.push(full);
      }
    }
    return found;
  }

  it("never imports the Prisma client — reads go through lib/queries", () => {
    const files = routeFilesUnder(ROUTE_DIR);
    // Not vacuous: there are route files to check.
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const relative = path.relative(ROUTE_DIR, file);
      expect(source, `${relative} imports the Prisma client directly`).not.toMatch(
        /from\s+["']@\/lib\/db["']/
      );
    }
  });
});
