import { describe, it, expect, beforeAll } from "vitest";
import { computeFifoDailySeries } from "../../server/landedCost";
import { loadFixtureSnapshot, type ControlTowerSnapshot } from "./snapshot";
import {
  WAREHOUSES,
  readReceipts,
  readSalesActuals,
  readSalesPlan,
  readDailyCogsTarget,
  readStockByDay,
  readSohToday,
  readLandedCostTarget,
  seriesKey,
  skuCodes,
} from "./targets";

const FIXTURE_TODAY = "2026-09-19";
const FIRST_SALES_DAY = "2026-06-16";
const LAST_SALES_DAY = "2026-09-18";
const utc = (s: string) => new Date(`${s}T00:00:00.000Z`);

let snap: ControlTowerSnapshot;
beforeAll(async () => {
  snap = await loadFixtureSnapshot();
});

describe("target readers", () => {
  it("derives the SKU list from SKU Master", () => {
    expect(skuCodes(snap)).toEqual(["Jello", "Mixer", "Straw"]);
  });

  it("reads one receipt per landed shipment line, costed from Landed Cost Summary", () => {
    const receipts = readReceipts(snap);
    expect(receipts).toHaveLength(24);
    expect(receipts.find((r) => r.shipmentRef === "PO1-Wave1-Jello")).toEqual({
      shipmentRef: "PO1-Wave1-Jello", sku: "Jello", warehouse: "FF", date: "2026-07-06", qty: 50040, unitCost: 2.0259266586730615,
    });
    expect(receipts.some((r) => r.shipmentRef === "PO3 Jello")).toBe(false);
  });

  it("reads real daily sales up to today and ignores plan-only future rows", () => {
    const sales = readSalesActuals(snap, FIXTURE_TODAY);
    expect(sales.find((s) => s.sku === "Jello" && s.warehouse === "FF" && s.date === FIRST_SALES_DAY)?.qty).toBe(1720);
    expect(sales.every((s) => s.date <= LAST_SALES_DAY)).toBe(true);
    const ffJello = sales.filter((s) => s.sku === "Jello" && s.warehouse === "FF");
    expect(ffJello).toHaveLength(95);
    expect(ffJello.reduce((a, s) => a + s.qty, 0)).toBe(158415);
  });

  it("reads plan rows only where a plan value exists", () => {
    const plan = readSalesPlan(snap);
    const first = plan.filter((p) => p.sku === "Jello" && p.warehouse === "FF").map((p) => p.date).sort()[0];
    expect(first).toBe("2026-07-13");
  });

  it("reads the Daily COGS target and the StockModel stock series", () => {
    const cogs = readDailyCogsTarget(snap);
    expect(cogs.get(seriesKey("Jello", "FF", "2026-07-07"))).toEqual({
      openingQty: 12372, openingValue: 25064.76, soldQty: 1750, cogs: 3545.37, unpricedQty: 0,
    });
    const stock = readStockByDay(snap);
    expect(stock.get(seriesKey("Jello", "FF", "2026-07-07"))).toBe(12372);
    expect(stock.get(seriesKey("Jello", "FF", "2026-07-06"))).toBe(-35986);
  });

  it("reads SOH today and landed-cost targets", () => {
    expect(readSohToday(snap)).toContainEqual({ sku: "Jello", warehouse: "FF", qty: 228585 });
    expect(readSohToday(snap)).toHaveLength(6);
    expect(readLandedCostTarget(snap)).toContainEqual({ shipmentRef: "PO1-Wave1-Jello", sku: "Jello", qty: 50040, landedCost: 2.0259266586730615 });
  });
});

describe("golden: FIFO daily series vs the Sheet's Daily COGS", () => {
  it("matches every SKU/warehouse/day (qty exact, € within 0.01)", () => {
    const receipts = readReceipts(snap);
    const sales = readSalesActuals(snap, FIXTURE_TODAY);
    const target = readDailyCogsTarget(snap);
    const diffs: string[] = [];
    let compared = 0;

    for (const wh of WAREHOUSES) {
      for (const sku of skuCodes(snap)) {
        const rows = computeFifoDailySeries(
          receipts.filter((r) => r.sku === sku && r.warehouse === wh.code).map((r) => ({ qty: r.qty, unitCost: r.unitCost, date: utc(r.date) })),
          sales.filter((s) => s.sku === sku && s.warehouse === wh.code).map((s) => ({ qty: s.qty, date: utc(s.date) })),
          utc(FIRST_SALES_DAY),
          utc(LAST_SALES_DAY),
        );
        for (const row of rows) {
          const expected = target.get(seriesKey(sku, wh.code, row.date));
          if (!expected) continue;
          compared++;
          const check = (field: keyof typeof expected, tol: number) => {
            const got = row[field as keyof typeof row] as number;
            if (Math.abs(got - expected[field]) > tol) {
              diffs.push(`${sku}/${wh.code} ${row.date} ${field}: sheet ${expected[field]} platform ${got.toFixed(4)}`);
            }
          };
          check("openingQty", 0);
          check("soldQty", 0);
          check("unpricedQty", 0);
          check("openingValue", 0.01);
          check("cogs", 0.01);
        }
      }
    }

    expect(compared).toBe(6 * 95);
    expect(diffs.slice(0, 10)).toEqual([]);
    expect(diffs).toHaveLength(0);
  });
});
