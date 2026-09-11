import { describe, it, expect, beforeEach } from "vitest";
import { db } from "./dbClient";
import { salesPlan, salesActuals, inventoryLedger, skus, warehouses } from "../drizzle/schema";
import { recordSalesActual, getSalesVolatility, getPlanActualDeviation, getDailyCogs } from "./salesPlan";
import { createSku, createWarehouse } from "./db";
import { recordLedgerEvent } from "./inventoryLedger";

beforeEach(async () => {
  await db.delete(salesActuals);
  await db.delete(salesPlan);
  await db.delete(inventoryLedger);
  await db.delete(skus);
  await db.delete(warehouses);
});

describe("sales plan/actuals", () => {
  it("recording a sales actual also writes a matching inventory_ledger sale event", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });

    await recordSalesActual({ skuId: sku.id, warehouseId: ff.id, date: new Date("2026-09-09"), qty: 1162, source: "shopify_daily_pull" });

    const ledgerRows = await db.select().from(inventoryLedger);
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0].qty).toBe(-1162);
    expect(ledgerRows[0].eventType).toBe("sale");
  });

  it("computes coefficient-of-variation volatility from weekly actuals", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });

    for (const [date, qty] of [
      ["2026-08-04", 1000], ["2026-08-11", 1200], ["2026-08-18", 900], ["2026-08-25", 1100],
    ] as const) {
      await recordSalesActual({ skuId: sku.id, warehouseId: ff.id, date: new Date(date), qty, source: "manual" });
    }

    const cv = await getSalesVolatility(sku.id, ff.id, 4);
    expect(cv).toBeGreaterThan(0);
    expect(cv).toBeLessThan(1);
  });

  it("computes volatility from the most RECENT N weeks, not the oldest N, once history exceeds the window", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });

    // 6 weeks of history, but weeks=4 below. Oldest 4 (07-01..07-22) are all
    // 1000 -> CV=0. Newest 4 (07-15..08-05) are 1000,1000,3000,5000 -> CV≈0.6633.
    // An ascending-order-then-limit bug would return the oldest 4 and yield 0.
    for (const [date, qty] of [
      ["2026-07-01", 1000], ["2026-07-08", 1000], ["2026-07-15", 1000],
      ["2026-07-22", 1000], ["2026-07-29", 3000], ["2026-08-05", 5000],
    ] as const) {
      await recordSalesActual({ skuId: sku.id, warehouseId: ff.id, date: new Date(date), qty, source: "manual" });
    }

    const cv = await getSalesVolatility(sku.id, ff.id, 4);
    expect(cv).toBeCloseTo(0.6633249580710799, 6);
  });

  it("computes per-SKU plan-vs-actual deviation, not just a warehouse aggregate", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });

    await db.insert(salesPlan).values({ skuId: sku.id, warehouseId: ff.id, periodDate: new Date("2026-09-09"), plannedQty: 1000 });
    await recordSalesActual({ skuId: sku.id, warehouseId: ff.id, date: new Date("2026-09-09"), qty: 1162, source: "shopify_daily_pull" });

    const deviation = await getPlanActualDeviation(sku.id, ff.id, new Date("2026-09-09"), new Date("2026-09-09"));
    expect(deviation).toEqual([{ date: "2026-09-09", planned: 1000, actual: 1162, deviation: 162 }]);
  });

  it("computes daily COGS via FIFO consumption across the full ledger history, not each day in isolation", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });

    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 100, unitCost: "2.00", date: new Date("2026-09-01"), sourceRef: "PO1" });
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 100, unitCost: "2.50", date: new Date("2026-09-05"), sourceRef: "PO2" });
    await recordSalesActual({ skuId: sku.id, warehouseId: ff.id, date: new Date("2026-09-03"), qty: 80, source: "manual" });
    await recordSalesActual({ skuId: sku.id, warehouseId: ff.id, date: new Date("2026-09-10"), qty: 40, source: "manual" });

    // Sept 3 sale (80 units) is fully covered by the first batch (@2.00) — the second batch hasn't landed yet.
    const cogsSept3 = await getDailyCogs(sku.id, ff.id, new Date("2026-09-03"));
    expect(cogsSept3).toBeCloseTo(80 * 2.0, 2);

    // Sept 10 sale (40 units) drains the remaining 20 units of batch 1 (@2.00), then 20 units of batch 2 (@2.50).
    const cogsSept10 = await getDailyCogs(sku.id, ff.id, new Date("2026-09-10"));
    expect(cogsSept10).toBeCloseTo(20 * 2.0 + 20 * 2.5, 2);
  });
});
