import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { NOTIFY_EVENTS } from "@/lib/notify/fan-out";

/**
 * Structural guards over the notification fan-out.
 *
 * FaultsAudit S9 (notification preferences) sat deferred for months with the
 * reasoning that a preference has to be *enforced*, and enforcing it across
 * ten hand-rolled `notification.create` call sites was not worth the risk of
 * missing one. These tests are what make that safe: they fail if anyone
 * reintroduces a direct write, or invents an event name the preferences UI
 * will not know about.
 *
 * All three walk the directory tree rather than checking a hardcoded file
 * list — a list stops covering whatever is added next week, which is exactly
 * the failure mode being guarded against.
 *
 * They walk `app/` as well as `lib/`. Scanning only `lib/` left the guard
 * with a hole the size of the App Router: a `"use server"` module or a route
 * handler under `app/` can reach Prisma exactly as well as anything in
 * `lib/`, and a direct `notification.create` there would have passed a green
 * suite. `.tsx` counts too — "use server" is legal in one, so the extension
 * is no protection.
 */

const ROOTS = [join(process.cwd(), "lib"), join(process.cwd(), "app")];

/** Every .ts/.tsx source file under `dir`, recursively. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry) && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/** Every scanned source file, across every root. */
function scanned(): string[] {
  return ROOTS.flatMap(sourceFiles);
}

function rel(path: string) {
  return path.slice(process.cwd().length + 1).replace(/\\/g, "/");
}

// The one file allowed to know how a notification row is written:
//   lib/notify/fan-out.ts — the helper itself
//
// lib/db.ts used to be exempt too, for the Prisma `$extends` hook that turned
// every notification write into a web-push send. Phase C deleted that hook
// (see the file's own header) and the exemption outlived it. A stale
// exemption is a hole, not a leftover: it is a standing licence for the
// single most convenient file in which to hand-roll a notification write.
const ALLOWED = new Set(["lib/notify/fan-out.ts"]);

describe("notification fan-out (the single write path)", () => {
  it("reaches every root it claims to scan", () => {
    // Guards the guard. Each check below passes vacuously if its input is
    // empty, so a root that is renamed, moved under src/, or simply typo'd
    // would turn all three into tests that cannot fail — silently, and in
    // green. Assert per-root rather than on a total so losing one root
    // cannot hide behind the other's file count.
    const empty = ROOTS.filter((root) => sourceFiles(root).length === 0);
    expect(
      empty.map(rel),
      "These scan roots yielded no source files, so the fan-out guards below " +
        "are inspecting nothing. Fix ROOTS in this file:"
    ).toEqual([]);
  });

  it("no module writes a notification directly — every fan-out goes through notifyUsers", () => {
    const direct = scanned()
      .map((f) => ({ file: rel(f), src: readFileSync(f, "utf8") }))
      .filter(({ file }) => !ALLOWED.has(file))
      .filter(({ src }) => /\.notification\.create(Many)?\s*\(/.test(src))
      .map(({ file }) => file);

    expect(
      direct,
      `These write Notification rows directly. Route them through notifyUsers() ` +
        `in lib/notify/fan-out.ts, or preferences and email will silently skip them:\n` +
        direct.map((f) => `  - ${f}`).join("\n")
    ).toEqual([]);
  });

  it("every notifyUsers call site names a known event", () => {
    const known = new Set<string>(NOTIFY_EVENTS);
    const unknown: string[] = [];

    for (const f of scanned()) {
      const file = rel(f);
      if (file === "lib/notify/fan-out.ts") continue;
      const src = readFileSync(f, "utf8");
      // `event:` is the first property at every call site by convention.
      const found = Array.from(src.matchAll(/notifyUsers\(\{\s*event:\s*"([^"]+)"/g));
      for (const m of found) {
        if (!known.has(m[1]!)) unknown.push(`${file}: "${m[1]}"`);
      }
    }

    expect(
      unknown,
      `Unknown NotifyEvent(s). Add them to NOTIFY_EVENTS so the preferences ` +
        `matrix can offer a switch for them:\n` +
        unknown.map((u) => `  - ${u}`).join("\n")
    ).toEqual([]);
  });

  it("every declared event is actually raised somewhere", () => {
    // A preference switch for an event nothing emits is a lie in the UI.
    const src = scanned()
      .filter((f) => rel(f) !== "lib/notify/fan-out.ts")
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");

    const unused = NOTIFY_EVENTS.filter((e) => !src.includes(`event: "${e}"`));
    expect(unused, `Declared but never raised: ${unused.join(", ")}`).toEqual([]);
  });
});
