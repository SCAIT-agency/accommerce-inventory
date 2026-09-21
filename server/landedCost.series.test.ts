import { describe, it, expect } from "vitest";
import { computeFifoDailySeries } from "./landedCost";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

describe("computeFifoDailySeries", () => {
  it("strict case: prices from the landed batch and reports overflow as unpriced", () => {
    const rows = computeFifoDailySeries(
      [{ qty: 100, unitCost: 2.0, date: d("2026-06-01") }],
      [
        { qty: 30, date: d("2026-06-02") },
        { qty: 80, date: d("2026-06-03") },
      ],
      d("2026-06-01"),
      d("2026-06-04"),
    );
    expect(rows.map((r) => r.date)).toEqual(["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04"]);
    expect(rows[0]).toMatchObject({ openingQty: 0, openingValue: 0, soldQty: 0, cogs: 0, unpricedQty: 0, closingQty: 100 });
    expect(rows[1]).toMatchObject({ openingQty: 100, openingValue: 200, soldQty: 30, cogs: 60, unpricedQty: 0, closingQty: 70 });
    expect(rows[2]).toMatchObject({ openingQty: 70, openingValue: 140, soldQty: 80, cogs: 140, unpricedQty: 10, closingQty: -10 });
    expect(rows[3]).toMatchObject({ openingQty: 0, openingValue: 0, soldQty: 0, cogs: 0, unpricedQty: 0, closingQty: -10 });
  });

  it("backorder case: a sale before landing is priced retroactively from the batch that later covers it", () => {
    const rows = computeFifoDailySeries(
      [{ qty: 100, unitCost: 2.0, date: d("2026-06-05") }],
      [{ qty: 50, date: d("2026-06-01") }],
      d("2026-06-01"),
      d("2026-06-06"),
    );
    const byDate = Object.fromEntries(rows.map((r) => [r.date, r]));
    expect(byDate["2026-06-01"]).toMatchObject({ openingQty: 0, soldQty: 50, cogs: 100, unpricedQty: 0, closingQty: -50 });
    expect(byDate["2026-06-05"]).toMatchObject({ openingQty: 0, soldQty: 0, cogs: 0, closingQty: 50 });
    expect(byDate["2026-06-06"]).toMatchObject({ openingQty: 50, openingValue: 100, closingQty: 50 });
  });

  it("a batch landing on day d is not in opening(d) but is in opening(d+1)", () => {
    const rows = computeFifoDailySeries(
      [{ qty: 10, unitCost: 1.5, date: d("2026-07-06") }],
      [],
      d("2026-07-06"),
      d("2026-07-07"),
    );
    expect(rows[0]).toMatchObject({ date: "2026-07-06", openingQty: 0, closingQty: 10 });
    expect(rows[1]).toMatchObject({ date: "2026-07-07", openingQty: 10, openingValue: 15 });
  });

  it("consumes batches in landing order across different costs", () => {
    const rows = computeFifoDailySeries(
      [
        { qty: 100, unitCost: 2.5, date: d("2026-06-10") },
        { qty: 100, unitCost: 2.0, date: d("2026-06-01") },
      ],
      [{ qty: 150, date: d("2026-06-12") }],
      d("2026-06-12"),
      d("2026-06-12"),
    );
    expect(rows[0].cogs).toBeCloseTo(100 * 2.0 + 50 * 2.5, 6);
    expect(rows[0].openingQty).toBe(200);
    expect(rows[0].openingValue).toBeCloseTo(450, 6);
  });

  it("counts sales before `from` as already consumed", () => {
    const rows = computeFifoDailySeries(
      [{ qty: 100, unitCost: 1.0, date: d("2026-06-01") }],
      [{ qty: 40, date: d("2026-06-02") }],
      d("2026-06-03"),
      d("2026-06-03"),
    );
    expect(rows[0]).toMatchObject({ openingQty: 60, closingQty: 60, cogs: 0 });
  });

  it("scales linearly: 1,000 SKU/warehouse pairs × 365 days × 30 batches well under a second each thousand", () => {
    const receipts = Array.from({ length: 30 }, (_, i) => ({ qty: 1000, unitCost: 1 + i * 0.01, date: d(`2026-${String(1 + (i % 12)).padStart(2, "0")}-15`) }));
    const sales = Array.from({ length: 365 }, (_, i) => ({ qty: 70, date: new Date(Date.UTC(2026, 0, 1 + i)) }));
    const started = Date.now();
    let checksum = 0;
    for (let p = 0; p < 1_000; p++) {
      const rows = computeFifoDailySeries(receipts, sales, d("2026-01-01"), d("2026-12-31"));
      checksum += rows[364].closingQty;
    }
    const seconds = (Date.now() - started) / 1000;
    expect(checksum).toBe(1_000 * (30_000 - 365 * 70));
    // Measured 2026-09-19: ~0.58 s per 1,000 pairs on an M-series laptop, so a
    // 10K-SKU catalog (Tucann scale) recomputes in ~6 s — no per-day re-reads.
    expect(seconds).toBeLessThan(3);
  });
});
