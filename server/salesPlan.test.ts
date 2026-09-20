import { describe, it, expect, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "./dbClient";
import { salesPlan, salesActuals, inventoryLedger, skus, warehouses } from "../drizzle/schema";
import { recordSalesActual, getSalesVolatility, getPlanActualDeviation, getDailyCogsForRange, createSalesPlanEntry } from "./salesPlan";
import { createSku, createWarehouse } from "./db";
import { recordLedgerEvent } from "./inventoryLedger";

beforeEach(async () => {
  // Real FKs now tie skus/warehouses to other tables, but each test file only
  // cleans its own tables at the start of each test (no afterAll anywhere in
  // this suite) — so a row left by another file's last test can otherwise
  // block these deletes regardless of order. Disabling FK checks for the
  // cleanup makes this file's reset order-independent again.
  //
  // SET is session-scoped in MySQL — there's no guarantee the toggle-off, the
  // deletes, and the toggle-on all land on the same pooled connection from
  // `db` (mysql.createPool). A real db.transaction pins one connection for
  // its whole duration, which is exactly the guarantee this needs.
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
    try {
      await tx.delete(salesActuals);
      await tx.delete(salesPlan);
      await tx.delete(inventoryLedger);
      await tx.delete(skus);
      await tx.delete(warehouses);
    } finally {
      await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
    }
  });
});

describe("sales plan/actuals", () => {
  it("recording a sales actual also writes a matching inventory_ledger sale event", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });

    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 2000, unitCost: "0.42", date: new Date("2026-09-01"), sourceRef: "PO1" });
    await recordSalesActual({ skuId: sku.id, warehouseId: ff.id, date: "2026-09-09", qty: 1162, source: "shopify_daily_pull" });

    const ledgerRows = await db.select().from(inventoryLedger);
    expect(ledgerRows).toHaveLength(2);
    expect(ledgerRows[1].qty).toBe(-1162);
    expect(ledgerRows[1].eventType).toBe("sale");
  });

  it("leaves no sales_actuals row behind if the matching ledger event is rejected (atomicity)", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });

    // No prior receipt — any sale drives SOH negative, so recordLedgerEvent throws.
    await expect(
      recordSalesActual({ skuId: sku.id, warehouseId: ff.id, date: "2026-09-09", qty: 1, source: "manual" }),
    ).rejects.toThrow(/negative/i);

    const rows = await db.select().from(salesActuals);
    expect(rows).toEqual([]);
  });

  it("computes coefficient-of-variation volatility from weekly actuals", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });

    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 10000, unitCost: "0.42", date: new Date("2026-08-01"), sourceRef: "PO1" });
    for (const [date, qty] of [
      ["2026-08-04", 1000], ["2026-08-11", 1200], ["2026-08-18", 900], ["2026-08-25", 1100],
    ] as const) {
      await recordSalesActual({ skuId: sku.id, warehouseId: ff.id, date, qty, source: "manual" });
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
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 50000, unitCost: "0.42", date: new Date("2026-06-01"), sourceRef: "PO1" });
    for (const [date, qty] of [
      ["2026-07-01", 1000], ["2026-07-08", 1000], ["2026-07-15", 1000],
      ["2026-07-22", 1000], ["2026-07-29", 3000], ["2026-08-05", 5000],
    ] as const) {
      await recordSalesActual({ skuId: sku.id, warehouseId: ff.id, date, qty, source: "manual" });
    }

    const cv = await getSalesVolatility(sku.id, ff.id, 4);
    expect(cv).toBeCloseTo(0.6633249580710799, 6);
  });

  it("computes per-SKU plan-vs-actual deviation, not just a warehouse aggregate", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });

    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 2000, unitCost: "0.42", date: new Date("2026-09-01"), sourceRef: "PO1" });
    await db.insert(salesPlan).values({ skuId: sku.id, warehouseId: ff.id, periodDate: "2026-09-09", plannedQty: 1000 });
    await recordSalesActual({ skuId: sku.id, warehouseId: ff.id, date: "2026-09-09", qty: 1162, source: "shopify_daily_pull" });

    const deviation = await getPlanActualDeviation(sku.id, ff.id, "2026-09-09", "2026-09-09");
    expect(deviation).toEqual([{ date: "2026-09-09", planned: 1000, actual: 1162, deviation: 162 }]);
  });

  it("computes daily COGS for a whole range in one call via a single forward FIFO pass, not each day in isolation", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });

    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 100, unitCost: "2.00", date: new Date("2026-09-01"), sourceRef: "PO1" });
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 100, unitCost: "2.50", date: new Date("2026-09-05"), sourceRef: "PO2" });
    await recordSalesActual({ skuId: sku.id, warehouseId: ff.id, date: "2026-09-03", qty: 80, source: "manual" });
    await recordSalesActual({ skuId: sku.id, warehouseId: ff.id, date: "2026-09-10", qty: 40, source: "manual" });

    const result = await getDailyCogsForRange(sku.id, ff.id, [
      "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06",
      "2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10",
    ]);

    expect(result).toHaveLength(8);
    // Sept 3 sale (80 units) is fully covered by the first batch (@2.00) — the second batch hasn't landed yet.
    expect(result.find((r) => r.date === "2026-09-03")?.cogs).toBeCloseTo(80 * 2.0, 2);
    // Sept 10 sale (40 units) drains the remaining 20 units of batch 1 (@2.00), then 20 units of batch 2 (@2.50).
    expect(result.find((r) => r.date === "2026-09-10")?.cogs).toBeCloseTo(20 * 2.0 + 20 * 2.5, 2);
    // A day inside the window with no sales must still appear, with zero cost, not be omitted.
    expect(result.find((r) => r.date === "2026-09-07")?.cogs).toBe(0);
  });

  it("returns an empty array for an empty dateKeys list, without querying the database", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    const result = await getDailyCogsForRange(sku.id, ff.id, []);
    expect(result).toEqual([]);
  });

  it("creates a sales plan entry with a direct insert, no audit trail", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });

    const entry = await createSalesPlanEntry({
      skuId: sku.id,
      warehouseId: ff.id,
      periodDate: "2026-10-01",
      plannedQty: 500,
    });

    expect(entry.plannedQty).toBe(500);
    expect(entry.skuId).toBe(sku.id);

    const rows = await db.select().from(salesPlan);
    expect(rows).toHaveLength(1);
  });

  it("creating a sales plan entry twice for the same SKU/warehouse/day updates it in place instead of duplicating", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });

    await createSalesPlanEntry({ skuId: sku.id, warehouseId: ff.id, periodDate: "2026-10-01", plannedQty: 500 });
    const updated = await createSalesPlanEntry({ skuId: sku.id, warehouseId: ff.id, periodDate: "2026-10-01", plannedQty: 750 });

    expect(updated.plannedQty).toBe(750);
    const rows = await db.select().from(salesPlan);
    expect(rows).toHaveLength(1);
    expect(rows[0].plannedQty).toBe(750);
  });

  it("stores and reads back a sales_actuals date as an exact calendar day, no time-of-day drift", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 1000, unitCost: "0.42", date: new Date("2026-09-01"), sourceRef: "PO1" });

    await recordSalesActual({ skuId: sku.id, warehouseId: ff.id, date: "2026-09-19", qty: 10, source: "manual" });

    const [row] = await db.select().from(salesActuals).where(eq(salesActuals.skuId, sku.id));
    expect(row.date).toBe("2026-09-19");
  });
});
