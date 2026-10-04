/**
 * transactions-ledger-010 — the row cap must SPLIT a large export, not refuse it.
 *
 * WHAT WAS WRONG. `ImportTransactionsSchema` caps a call at 1,000 rows and the
 * modal sent every valid row in one call, so a 3,000-row accounting export
 * produced one zod failure ("Import at most 1000 rows at a time") and zero
 * inserts — after the customer had picked the file, waited for the preview and
 * pressed Import.
 *
 * WHAT THIS FILE PINS, and why it is the pure half. The chunker is where the
 * finding can come back silently: a client that chunks at a number the server
 * does not accept is the same defect with the error moved one step earlier, and
 * nothing on screen would say which number is wrong. So the last test here runs
 * a full-size batch, and a batch one row larger, through the REAL
 * `ImportTransactionsSchema` — the action's own first gate
 * (lib/actions/transactions.ts:420) — rather than through a number copied into a
 * test.
 *
 * The modal half (the limits stated before the file picker, the batch plan shown
 * before you commit, the size and row ceilings, the truncated preview, one
 * duplicate question for the whole file) is
 * tests/components/import-modal-large-file.test.tsx.
 */

import { describe, it, expect } from "vitest";
import {
  chunkImportRows,
  IMPORT_MAX_FILE_BYTES,
  IMPORT_MAX_TOTAL_ROWS,
  IMPORT_PREVIEW_ROWS,
} from "@/lib/transactions/import-batches";
import { IMPORT_MAX_ROWS_PER_BATCH, ImportTransactionsSchema } from "@/lib/schemas/transaction";

type Row = { amount: number; category: string; description: string; date: string };

/** `n` rows that would each pass `ImportTransactionRowSchema` on their own. */
function rows(n: number): Row[] {
  const out: Row[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      amount: 100 + i,
      category: "Marketing",
      description: `Row ${i + 1}`,
      date: "2026-06-01T00:00:00.000Z",
    });
  }
  return out;
}

describe("chunkImportRows", () => {
  it("splits a 3,000-row export into three full batches, in file order", () => {
    const batches = chunkImportRows(rows(3000));

    expect(batches.map((b) => b.length)).toEqual([1000, 1000, 1000]);
    // Nothing lost, nothing sent twice, nothing reordered: the flattened
    // batches are the original list.
    const flattened = batches.reduce<Row[]>((all, b) => all.concat(b), []);
    expect(flattened.map((r) => r.description)).toEqual(rows(3000).map((r) => r.description));
  });

  it("splits one row over the cap rather than refusing the file", () => {
    expect(chunkImportRows(rows(IMPORT_MAX_ROWS_PER_BATCH + 1)).map((b) => b.length)).toEqual([
      IMPORT_MAX_ROWS_PER_BATCH,
      1,
    ]);
  });

  it("leaves an exactly-full file as one batch, with no empty tail", () => {
    expect(chunkImportRows(rows(IMPORT_MAX_ROWS_PER_BATCH))).toHaveLength(1);
  });

  it("returns no batches for an empty payload, so no empty call is made", () => {
    expect(chunkImportRows([])).toEqual([]);
  });

  it("keeps every batch of the largest acceptable file within the cap", () => {
    const batches = chunkImportRows(rows(IMPORT_MAX_TOTAL_ROWS));
    expect(batches).toHaveLength(Math.ceil(IMPORT_MAX_TOTAL_ROWS / IMPORT_MAX_ROWS_PER_BATCH));
    for (const batch of batches) {
      expect(batch.length).toBeLessThanOrEqual(IMPORT_MAX_ROWS_PER_BATCH);
    }
  });

  it("refuses a chunk size below one instead of looping forever", () => {
    expect(() => chunkImportRows(rows(3), 0)).toThrow();
  });
});

describe("the chunk size is the server's own cap", () => {
  const envelope = (batch: Row[]) => ({
    type: "expense" as const,
    projectId: "",
    allowDuplicates: false,
    rows: batch,
  });

  it("accepts a full-size batch", () => {
    const parsed = ImportTransactionsSchema.safeParse(envelope(rows(IMPORT_MAX_ROWS_PER_BATCH)));
    expect(parsed.success).toBe(true);
  });

  it("refuses one row more, which is why the client must chunk at this number", () => {
    const parsed = ImportTransactionsSchema.safeParse(
      envelope(rows(IMPORT_MAX_ROWS_PER_BATCH + 1))
    );
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toContain(String(IMPORT_MAX_ROWS_PER_BATCH));
    }
  });
});

describe("the ceilings the modal states before a file is picked", () => {
  it("bounds the whole file at a whole number of batches' worth of calls", () => {
    // Chunking turns one call into ceil(rows / cap) calls, and every server
    // action passes through `limiters.write` — 60 writes/minute/user
    // (lib/rate-limit.ts). The ceiling exists so a file cannot start importing
    // and then begin reporting "Too many requests" halfway down.
    expect(IMPORT_MAX_TOTAL_ROWS).toBeGreaterThan(IMPORT_MAX_ROWS_PER_BATCH);
    expect(Math.ceil(IMPORT_MAX_TOTAL_ROWS / IMPORT_MAX_ROWS_PER_BATCH)).toBeLessThanOrEqual(30);
  });

  it("previews fewer rows than one batch holds, so a large file cannot build a huge table", () => {
    expect(IMPORT_PREVIEW_ROWS).toBeLessThan(IMPORT_MAX_ROWS_PER_BATCH);
  });

  it("states the size ceiling in whole megabytes, because the copy says 'MB'", () => {
    expect(IMPORT_MAX_FILE_BYTES % (1024 * 1024)).toBe(0);
  });
});
