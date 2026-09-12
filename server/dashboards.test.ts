// server/dashboards.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { db } from "./dbClient";
import { skus, warehouses, inventoryLedger, payments, transactions, purchaseOrders, vendors, salesActuals } from "../drizzle/schema";
import { getHomeSummary, getStockDashboard } from "./dashboards";
import { createSku, createWarehouse } from "./db";
import { recordLedgerEvent } from "./inventoryLedger";
import { recordSalesActual } from "./salesPlan";

beforeEach(async () => {
  await db.delete(transactions);
  await db.delete(payments);
  await db.delete(purchaseOrders);
  await db.delete(vendors);
  await db.delete(salesActuals);
  await db.delete(inventoryLedger);
  await db.delete(skus);
  await db.delete(warehouses);
});

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 86400000);
}

describe("dashboards", () => {
  it("Home summary reports active SKU count and current SOH-based fire count", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku", status: "active" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 100, unitCost: "0.42", date: new Date(), sourceRef: "PO1" });

    const summary = await getHomeSummary();
    expect(summary.activeSkuCount).toBe(1);
    expect(summary).toHaveProperty("stockoutRiskSkuCount");
    expect(summary).toHaveProperty("nearTermCashNeeds");
  });

  it("Stock dashboard reports SOH per warehouse, never blended", async () => {
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    const mutual = await createWarehouse({ code: "MUTUAL-CH", name: "Mutual CH" });
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 1000, unitCost: "0.42", date: new Date(), sourceRef: "PO1" });
    await recordLedgerEvent({ skuId: sku.id, warehouseId: mutual.id, eventType: "receipt", qty: 300, unitCost: "0.45", date: new Date(), sourceRef: "PO1-Local" });

    const stock = await getStockDashboard();
    const row = stock.find((r) => r.skuId === sku.id);
    expect(row?.byWarehouse).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ warehouseId: ff.id, soh: 1000 }),
        expect.objectContaining({ warehouseId: mutual.id, soh: 300 }),
      ]),
    );
  });

  it("Money dashboard always includes cashflow, and adds daily COGS / landed cost only when scoped to a SKU+warehouse / shipment", async () => {
    const { getMoneyDashboard } = await import("./dashboards");

    const unscoped = await getMoneyDashboard(new Date("2026-09-01"), new Date("2026-09-30"));
    expect(unscoped.dailyCogs).toEqual([]);
    expect(unscoped.landedCost).toEqual([]);
    expect(unscoped).toHaveProperty("cashflow");
  });

  it("Stock dashboard computes days-of-cover and status buckets from recent sales history, without dividing by zero", async () => {
    const criticalSku = await createSku({ sku: "JELLO-CRITICAL", primaryIdentifierType: "sku", status: "active" });
    const overstockSku = await createSku({ sku: "JELLO-OVERSTOCK", primaryIdentifierType: "sku", status: "active" });
    const noHistorySku = await createSku({ sku: "JELLO-NO-HISTORY", primaryIdentifierType: "sku", status: "active" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });

    // Dates are relative to now because the averaging window is a rolling
    // 30 calendar days — fixed calendar dates drift out of it over time.

    // Receipt 500, sell 10/day across all 30 window days -> SOH 200,
    // avgDailySales 300/30 = 10 -> daysOfCover 20 (< 21 -> critical)
    await recordLedgerEvent({ skuId: criticalSku.id, warehouseId: ff.id, eventType: "receipt", qty: 500, unitCost: "0.42", date: daysAgo(29), sourceRef: "PO-CRIT" });
    for (let i = 0; i < 30; i++) {
      await recordSalesActual({ skuId: criticalSku.id, warehouseId: ff.id, date: daysAgo(i), qty: 10, source: "manual" });
    }

    // Receipt 1000, sell 1/day across all 30 window days -> SOH 970,
    // avgDailySales 30/30 = 1 -> daysOfCover 970 (>= 90 -> overstock)
    await recordLedgerEvent({ skuId: overstockSku.id, warehouseId: ff.id, eventType: "receipt", qty: 1000, unitCost: "0.42", date: daysAgo(29), sourceRef: "PO-OVER" });
    for (let i = 0; i < 30; i++) {
      await recordSalesActual({ skuId: overstockSku.id, warehouseId: ff.id, date: daysAgo(i), qty: 1, source: "manual" });
    }

    // No sales history at all: SOH 500, no sales_actuals rows -> daysOfCover null, status unknown
    await recordLedgerEvent({ skuId: noHistorySku.id, warehouseId: ff.id, eventType: "receipt", qty: 500, unitCost: "0.42", date: daysAgo(29), sourceRef: "PO-NOHIST" });

    const stock = await getStockDashboard();

    const criticalRow = stock.find((r) => r.skuId === criticalSku.id);
    const criticalWh = criticalRow?.byWarehouse.find((w) => w.warehouseId === ff.id);
    expect(criticalWh?.avgDailySales).toBeCloseTo(10);
    expect(criticalWh?.daysOfCover).toBeCloseTo(20);
    expect(criticalWh?.status).toBe("critical");

    const overstockRow = stock.find((r) => r.skuId === overstockSku.id);
    const overstockWh = overstockRow?.byWarehouse.find((w) => w.warehouseId === ff.id);
    expect(overstockWh?.avgDailySales).toBeCloseTo(1);
    expect(overstockWh?.status).toBe("overstock");

    const noHistoryRow = stock.find((r) => r.skuId === noHistorySku.id);
    const noHistoryWh = noHistoryRow?.byWarehouse.find((w) => w.warehouseId === ff.id);
    expect(noHistoryWh?.avgDailySales).toBe(0);
    expect(noHistoryWh?.daysOfCover).toBeNull();
    expect(noHistoryWh?.status).toBe("unknown");
  });

  it("averages sales over the full calendar window, not only the days a SKU happened to sell", async () => {
    const sku = await createSku({ sku: "JELLO-SPORADIC", primaryIdentifierType: "sku", status: "active" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });

    // 1000 received, then 10 units sold on only 3 of the last 30 calendar days.
    // 30 units over a 30-day window is 1.0/day — NOT 30/3 = 10.0/day.
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 1000, unitCost: "0.42", date: daysAgo(29), sourceRef: "PO-SPORADIC" });
    for (const offset of [2, 9, 20]) {
      await recordSalesActual({ skuId: sku.id, warehouseId: ff.id, date: daysAgo(offset), qty: 10, source: "manual" });
    }

    const stock = await getStockDashboard();
    const wh = stock.find((r) => r.skuId === sku.id)?.byWarehouse.find((w) => w.warehouseId === ff.id);

    expect(wh?.soh).toBe(970);
    expect(wh?.avgDailySales).toBeCloseTo(1);
    expect(wh?.daysOfCover).toBeCloseTo(970);
    expect(wh?.status).toBe("overstock");
  });

  it("ignores sales history older than the averaging window instead of reporting a confident stale figure", async () => {
    const sku = await createSku({ sku: "JELLO-DORMANT", primaryIdentifierType: "sku", status: "active" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });

    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 500, unitCost: "0.42", date: daysAgo(800), sourceRef: "PO-DORMANT" });
    for (const offset of [400, 401, 402]) {
      await recordSalesActual({ skuId: sku.id, warehouseId: ff.id, date: daysAgo(offset), qty: 20, source: "manual" });
    }

    const stock = await getStockDashboard();
    const wh = stock.find((r) => r.skuId === sku.id)?.byWarehouse.find((w) => w.warehouseId === ff.id);

    expect(wh?.avgDailySales).toBe(0);
    expect(wh?.daysOfCover).toBeNull();
    expect(wh?.status).toBe("unknown");
  });
});
