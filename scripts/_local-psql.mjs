/*
 * The one module that knows how to run SQL against the LOCAL dev database from
 * a shell, and refuses to run it anywhere else.
 *
 * WHY THIS EXISTS (audit harness-004). `scripts/_local-db.mjs` closed the route
 * a script takes through Prisma: a bare `new PrismaClient()` auto-loads the root
 * `.env`, so `localDb()` proves the host is loopback first, and
 * `tests/lib/db/script-safety.test.ts` fails if any script builds its own
 * client. That guard read as complete for months, and it was not. Six smoke
 * scripts reached the same database down a second road:
 *
 *     execSync(`docker exec -i founderflow-postgres psql -U … -d …`, { input: sql })
 *
 * — issuing UPDATE and DELETE against seeded User rows, with no host check
 * anywhere on the path. `localDatabaseUrl()`'s loopback assertion, the thing
 * standing between a script and somebody's real financial records, was simply
 * never consulted. The only reason those six were safe was the hardcoded
 * container name, which means the guard's coverage was exactly as wide as a
 * container name: parameterise it, or swap `docker exec` for a `psql` on PATH
 * with PGHOST set, and six scripts start mutating whatever the environment says.
 *
 * TWO INDEPENDENT THINGS PIN THIS TO LOCAL, and they are not the same thing:
 *
 *   1. `docker exec` runs psql INSIDE the named container, so the connection
 *      never leaves that container's own Postgres. This is what actually decides
 *      which database is written. CONTAINER is a literal here and is assembled
 *      from nothing — no env var, no argument, no interpolation.
 *
 *   2. `localDatabaseUrl()` is consulted before every statement. It does NOT
 *      determine where psql connects — see (1) — and claiming it did would be a
 *      comment that lies. What it does is refuse the run when `.env.local` names
 *      a non-loopback host, which is the signal that the developer has
 *      deliberately repointed this checkout at hosted data (CLAUDE.md's "a
 *      one-off inspection"). Under exactly that condition, a smoke script that
 *      deletes rows should not run at all, whichever database it would hit.
 *
 * It follows that these helpers throw when `.env.local` is missing. That is
 * fail-closed and intended: the local-development flow in CLAUDE.md creates
 * `.env.local` as its second step, and every caller here also needs a dev server
 * on localhost, so an absent `.env.local` means the caller was not set up to run
 * in the first place.
 */

import { execSync } from "node:child_process";
import { localDatabaseUrl } from "./_local-db.mjs";

/**
 * The docker-compose service name from docker-compose.yml. A literal, and it
 * stays a literal: `script-safety.test.ts` asserts this file reads no host, port,
 * database or container out of the environment.
 */
const CONTAINER = "founderflow-postgres";
const PSQL_USER = "founderflow";
const PSQL_DB = "founderflow";

/**
 * Refuse the run if this checkout is currently pointed at a non-loopback
 * database. See (2) above for what this does and does not prove.
 */
function refuseIfPointedAtRealData() {
  localDatabaseUrl("DATABASE_URL"); // throws on a non-loopback host
}

/**
 * Run one or more statements and discard the output. SQL goes in on stdin, never
 * as an argument, so an identifier like `"User"` needs no shell quoting — quoting
 * it is what broke these calls under PowerShell before.
 *
 * @param {string} sql
 * @returns {void}
 * @throws if `.env.local` names a non-loopback host, or psql exits non-zero.
 */
export function psqlExec(sql) {
  refuseIfPointedAtRealData();
  execSync(`docker exec -i ${CONTAINER} psql -U ${PSQL_USER} -d ${PSQL_DB}`, {
    input: sql,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/**
 * Run one or more statements and return the output with `-tA` (tuples only,
 * unaligned), trimmed — the shape a single scalar comes back in.
 *
 * @param {string} sql
 * @returns {string}
 * @throws if `.env.local` names a non-loopback host, or psql exits non-zero.
 */
export function psqlScalar(sql) {
  refuseIfPointedAtRealData();
  return execSync(`docker exec -i ${CONTAINER} psql -U ${PSQL_USER} -d ${PSQL_DB} -tA`, {
    input: sql,
    encoding: "utf8",
  }).trim();
}
