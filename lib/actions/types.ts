/**
 * The single result envelope every server action returns.
 *
 * Deliberately NOT a `"use server"` module: Next.js only allows async
 * function exports from those, and this is types-only (erased at compile
 * time), so importing it from an action file costs nothing at runtime.
 *
 * Previously this exact declaration was copy-pasted into all 20 files under
 * `lib/actions/`, and `auth.ts` had drifted into a `data`-less fork. Consolidated
 * 2026-09-23 so the envelope can only change in one place.
 */
export type ActionResult<T = void> = { success: true; data: T } | { success: false; error: string };
