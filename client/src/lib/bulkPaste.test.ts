import { describe, it, expect } from "vitest";
import { parseBulkPaste, type BulkPasteColumn } from "./bulkPaste";

interface TestRow {
  sku: string;
  qty: number;
}

const columns: BulkPasteColumn<TestRow>[] = [
  { key: "sku", label: "SKU", parse: (raw) => (raw.trim().length > 0 ? { ok: true, value: raw.trim() } : { ok: false, error: "required" }) },
  { key: "qty", label: "Qty", parse: (raw) => {
    const n = Number(raw.trim());
    return Number.isFinite(n) && n >= 0 ? { ok: true, value: n } : { ok: false, error: "must be a non-negative number" };
  } },
];

describe("parseBulkPaste", () => {
  it("parses well-formed tab-separated rows", () => {
    const rows = parseBulkPaste("JELLO-500\t120\nMIXER-90\t45", columns);
    expect(rows).toHaveLength(2);
    expect(rows[0].isValid).toBe(true);
    expect(rows[0].values).toEqual({ sku: "JELLO-500", qty: 120 });
    expect(rows[1].values).toEqual({ sku: "MIXER-90", qty: 45 });
  });

  it("flags a row with an invalid column value, without dropping other valid rows", () => {
    const rows = parseBulkPaste("JELLO-500\t120\nMIXER-90\tnot-a-number", columns);
    expect(rows[0].isValid).toBe(true);
    expect(rows[1].isValid).toBe(false);
    expect(rows[1].errors.qty).toBe("must be a non-negative number");
  });

  it("flags a row with the wrong number of columns instead of throwing", () => {
    const rows = parseBulkPaste("JELLO-500\t120\tEXTRA", columns);
    expect(rows[0].isValid).toBe(false);
    expect(rows[0].errors.sku).toMatch(/expected 2 columns, got 3/);
  });

  it("ignores blank lines", () => {
    const rows = parseBulkPaste("JELLO-500\t120\n\nMIXER-90\t45\n", columns);
    expect(rows).toHaveLength(2);
  });

  it("returns an empty array for empty input", () => {
    expect(parseBulkPaste("", columns)).toEqual([]);
    expect(parseBulkPaste("   \n  \n", columns)).toEqual([]);
  });

  it("flags a pasted header row as invalid instead of silently importing it", () => {
    // A real header ("SKU"/"Qty") fails the same per-column parse rules a bad
    // data row would — no special-casing needed, but this pins the behavior
    // explicitly so a future refactor can't accidentally special-case
    // row-index-0 in a way that skips it instead.
    const rows = parseBulkPaste("SKU\tQty\nJELLO-500\t120", columns);
    expect(rows[0].isValid).toBe(false);
    expect(rows[0].errors.qty).toBe("must be a non-negative number");
    expect(rows[1].isValid).toBe(true);
  });

  it("preserves every row's order and count on a large paste", () => {
    const lines = Array.from({ length: 250 }, (_, i) => `SKU-${i}\t${i}`);
    const rows = parseBulkPaste(lines.join("\n"), columns);
    expect(rows).toHaveLength(250);
    expect(rows.every((r) => r.isValid)).toBe(true);
    expect(rows[249].values).toEqual({ sku: "SKU-249", qty: 249 });
  });
});
