import { describe, expect, it } from "vitest";
import { findColumn, parseCSV } from "@/lib/transactions/csv";

describe("parseCSV", () => {
  it("parses a simple header + rows", () => {
    const out = parseCSV("date,amount,category\n2026-06-01,100,Marketing");
    expect(out).toEqual([
      ["date", "amount", "category"],
      ["2026-06-01", "100", "Marketing"],
    ]);
  });

  it("handles quoted fields with embedded commas", () => {
    const out = parseCSV('desc,amount\n"Rent, June",25000');
    expect(out[1]).toEqual(["Rent, June", "25000"]);
  });

  it("handles escaped quotes inside a quoted field", () => {
    const out = parseCSV('note\n"She said ""hi"""');
    expect(out[1]).toEqual(['She said "hi"']);
  });

  it("handles embedded newlines inside quotes", () => {
    const out = parseCSV('note,amount\n"line1\nline2",50');
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual(["line1\nline2", "50"]);
  });

  it("tolerates CRLF line endings", () => {
    const out = parseCSV("a,b\r\n1,2\r\n");
    expect(out).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("drops blank lines", () => {
    const out = parseCSV("a,b\n\n1,2\n   \n");
    expect(out).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("flushes a trailing row with no final newline", () => {
    const out = parseCSV("a\n1");
    expect(out).toEqual([["a"], ["1"]]);
  });
});

describe("findColumn", () => {
  const headers = ["date", "amount (pkr)", "category", "description"];
  it("matches by substring", () => {
    expect(findColumn(headers, ["amount", "value"])).toBe(1);
    expect(findColumn(headers, ["desc", "note"])).toBe(3);
  });
  it("returns -1 when nothing matches", () => {
    expect(findColumn(headers, ["vendor", "merchant"])).toBe(-1);
  });
});
