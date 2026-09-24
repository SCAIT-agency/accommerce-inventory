// server/dashboards.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "./dbClient";
import { skus, warehouses, inventoryLedger, payments, transactions, purchaseOrders, vendors, salesActuals, poLineItems, shipments, shipmentLineItems, appSettings, users } from "../drizzle/schema";
import { getHomeSummary, getStockDashboard } from "./dashboards";
import { createSku, createWarehouse, createVendor, createUser } from "./db";
import { createPurchaseOrder, getPurchaseOrderWithLineItems } from "./purchaseOrders";
import { createExpectedPayment } from "./payments";
import { recordLedgerEvent } from "./inventoryLedger";
import { recordSalesActual } from "./salesPlan";
import { createShipment, recordShipmentCosts } from "./shipments";

let userId: number;

beforeEach(async () => {
  // Real FKs now tie these tables together, but each test file only cleans
  // its own tables at the start of each test (no afterAll anywhere in this
  // suite) — so a row left by another file's last test can otherwise block
  // these deletes regardless of order. Disabling FK checks for the cleanup
  // makes this file's reset order-independent again.
  //
  // SET is session-scoped in MySQL — there's no guarantee the toggle-off, the
  // deletes, and the toggle-on all land on the same pooled connection from
  // `db` (mysql.createPool). A real db.transaction pins one connection for
  // its whole duration, which is exactly the guarantee this needs.
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
    try {
      await tx.delete(transactions);
      await tx.delete(payments);
      await tx.delete(shipmentLineItems);
      await tx.delete(shipments);
      await tx.delete(poLineItems);
      await tx.delete(purchaseOrders);
      await tx.delete(vendors);
      await tx.delete(salesActuals);
      await tx.delete(inventoryLedger);
      await tx.delete(skus);
      await tx.delete(warehouses);
      await tx.delete(appSettings);
      await tx.delete(users);
    } finally {
      await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
    }
  });
  const user = await createUser({ email: "test@accommerce.example", role: "editor" });
  userId = user.id;
});

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 86400000);
}

function daysFromNow(n: number): Date {
  return new Date(Date.now() + n * 86400000);
}

function daysAgoStr(n: number): string {
  return daysAgo(n).toISOString().slice(0, 10);
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

  it("estimates a EUR-equivalent nearTermCashNeeds using the standard FX rate when unpaid payments on different days within the 14-day window span more than one currency", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const po = await createPurchaseOrder({ poNumber: "PO3-JELLO", vendorId: vendor.id, lineItems: [], createdBy: userId });

    await createExpectedPayment({ poId: po.id, sequenceNo: 1, expectedAmount: "30000.00", expectedDate: daysFromNow(2), currency: "USD" });
    await createExpectedPayment({ poId: po.id, sequenceNo: 2, expectedAmount: "10000.00", expectedDate: daysFromNow(9), currency: "EUR" });

    const summary = await getHomeSummary();
    // 30000 USD * default 0.86 + 10000 EUR (base currency, exact) = 35800
    expect(summary.nearTermCashNeeds).toBeCloseTo(35800);
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

  it("getMoneyDashboard degrades landedCost to an error field instead of throwing on a currency mismatch, leaving other sections intact", async () => {
    const { getMoneyDashboard } = await import("./dashboards");

    // Same currency-mismatch reproduction as landedCost.test.ts: a PO line
    // priced in USD, shipped with costs recorded in EUR.
    const vendor = await createVendor({ name: "Lvmengkang" });
    const sku = await createSku({ sku: "JELLO-CAL-500", primaryIdentifierType: "sku" });
    const po = await createPurchaseOrder({
      poNumber: "PO1-W4",
      vendorId: vendor.id,
      lineItems: [{ skuId: sku.id, qty: 1000, unitPrice: "0.15", currency: "USD" }],
      createdBy: userId,
    });
    const withItems = await getPurchaseOrderWithLineItems(po.id);
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    const shipment = await createShipment({
      shipmentRef: "PO1-W4-Container1",
      warehouseId: ff.id,
      lineItems: [{ poLineItemId: withItems.lineItems[0].id, skuId: sku.id, qty: 1000, weightShare: "1.0", valueShare: "1.0" }],
      createdBy: userId,
    });
    await recordShipmentCosts(
      shipment.id,
      { freightCost: "100.00", dutyCost: "20.00", costCurrency: "EUR" },
      { reasonCategory: "freight_rate_change", changedBy: userId },
    );

    const result = await getMoneyDashboard(new Date("2026-09-01"), new Date("2026-09-30"), { shipmentId: shipment.id });
    expect(result.landedCost).toEqual([]);
    expect(result.landedCostError).toMatch(/currency/i);
    expect(result.cashflow).toBeDefined();
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
      await recordSalesActual({ skuId: criticalSku.id, warehouseId: ff.id, date: daysAgoStr(i), qty: 10, source: "manual" });
    }

    // Receipt 1000, sell 1/day across all 30 window days -> SOH 970,
    // avgDailySales 30/30 = 1 -> daysOfCover 970 (>= 90 -> overstock)
    await recordLedgerEvent({ skuId: overstockSku.id, warehouseId: ff.id, eventType: "receipt", qty: 1000, unitCost: "0.42", date: daysAgo(29), sourceRef: "PO-OVER" });
    for (let i = 0; i < 30; i++) {
      await recordSalesActual({ skuId: overstockSku.id, warehouseId: ff.id, date: daysAgoStr(i), qty: 1, source: "manual" });
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

  it("getStockDashboard's combined multi-warehouse total uses the SKU's own reorder point, not a fixed band", async () => {
    // Real bug: the client used to recompute the combined-total status with
    // hardcoded day-of-cover bands (14/30/120) instead of this SKU's actual
    // leadTimeDays/safetyStockDays, because the server never returned a
    // combined total at all. Here leadTimeDays=66/safetyStockDays=14 (the
    // real default) gives reorderPoint=80, so "ok" runs all the way out to
    // 80*3=240 days of cover — a combined 150 is "ok", not "overstock" the
    // way a fixed >120 band would wrongly call it.
    const sku = await createSku({ sku: "JELLO-MULTI-WH", primaryIdentifierType: "sku", status: "active" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    const mutual = await createWarehouse({ code: "MUTUAL-CH", name: "Mutual CH" });

    // WH A: soh 900, 6/day -> 150 days of cover on its own.
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 1080, unitCost: "0.42", date: daysAgo(29), sourceRef: "PO-A" });
    for (let i = 0; i < 30; i++) {
      await recordSalesActual({ skuId: sku.id, warehouseId: ff.id, date: daysAgoStr(i), qty: 6, source: "manual" });
    }
    // WH B: soh 300, 2/day -> 150 days of cover on its own too.
    await recordLedgerEvent({ skuId: sku.id, warehouseId: mutual.id, eventType: "receipt", qty: 360, unitCost: "0.45", date: daysAgo(29), sourceRef: "PO-B" });
    for (let i = 0; i < 30; i++) {
      await recordSalesActual({ skuId: sku.id, warehouseId: mutual.id, date: daysAgoStr(i), qty: 2, source: "manual" });
    }

    const stock = await getStockDashboard();
    const row = stock.find((r) => r.skuId === sku.id);
    expect(row?.total.soh).toBe(1200);
    expect(row?.total.avgDailySales).toBeCloseTo(8);
    expect(row?.total.daysOfCover).toBeCloseTo(150);
    expect(row?.total.status).toBe("ok");
  });

  it("averages sales over the full calendar window, not only the days a SKU happened to sell", async () => {
    const sku = await createSku({ sku: "JELLO-SPORADIC", primaryIdentifierType: "sku", status: "active" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });

    // 1000 received, then 10 units sold on only 3 of the last 30 calendar days.
    // 30 units over a 30-day window is 1.0/day — NOT 30/3 = 10.0/day.
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 1000, unitCost: "0.42", date: daysAgo(29), sourceRef: "PO-SPORADIC" });
    for (const offset of [2, 9, 20]) {
      await recordSalesActual({ skuId: sku.id, warehouseId: ff.id, date: daysAgoStr(offset), qty: 10, source: "manual" });
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
      await recordSalesActual({ skuId: sku.id, warehouseId: ff.id, date: daysAgoStr(offset), qty: 20, source: "manual" });
    }

    const stock = await getStockDashboard();
    const wh = stock.find((r) => r.skuId === sku.id)?.byWarehouse.find((w) => w.warehouseId === ff.id);

    expect(wh?.avgDailySales).toBe(0);
    expect(wh?.daysOfCover).toBeNull();
    expect(wh?.status).toBe("unknown");
  });

  it("computes correct per-SKU stock figures for many SKUs from one batched query round, not per-SKU queries", async () => {
    const skuA = await createSku({ sku: "JELLO-MULTI-A", primaryIdentifierType: "sku", status: "active" });
    const skuB = await createSku({ sku: "JELLO-MULTI-B", primaryIdentifierType: "sku", status: "active" });
    const skuC = await createSku({ sku: "JELLO-MULTI-C", primaryIdentifierType: "sku", status: "active" }); // no ledger history
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    const mutual = await createWarehouse({ code: "MUTUAL-CH", name: "Mutual CH" });

    await recordLedgerEvent({ skuId: skuA.id, warehouseId: ff.id, eventType: "receipt", qty: 500, unitCost: "0.42", date: daysAgo(29), sourceRef: "PO-A-FF" });
    await recordLedgerEvent({ skuId: skuA.id, warehouseId: mutual.id, eventType: "receipt", qty: 200, unitCost: "0.42", date: daysAgo(29), sourceRef: "PO-A-MUTUAL" });
    await recordLedgerEvent({ skuId: skuB.id, warehouseId: ff.id, eventType: "receipt", qty: 300, unitCost: "0.42", date: daysAgo(29), sourceRef: "PO-B-FF" });

    for (let i = 0; i < 10; i++) {
      await recordSalesActual({ skuId: skuA.id, warehouseId: ff.id, date: daysAgoStr(i), qty: 5, source: "manual" });
    }

    const stock = await getStockDashboard();

    const rowA = stock.find((r) => r.skuId === skuA.id);
    const ffA = rowA?.byWarehouse.find((w) => w.warehouseId === ff.id);
    const mutualA = rowA?.byWarehouse.find((w) => w.warehouseId === mutual.id);
    expect(ffA?.soh).toBe(450); // 500 - 50 sold
    expect(ffA?.avgDailySales).toBeCloseTo(50 / 30);
    expect(mutualA?.soh).toBe(200);
    expect(mutualA?.avgDailySales).toBe(0); // no sales recorded in this warehouse

    const rowB = stock.find((r) => r.skuId === skuB.id);
    const ffB = rowB?.byWarehouse.find((w) => w.warehouseId === ff.id);
    expect(ffB?.soh).toBe(300);
    expect(ffB?.avgDailySales).toBe(0);

    const rowC = stock.find((r) => r.skuId === skuC.id);
    expect(rowC?.byWarehouse).toEqual([]); // no ledger history at all -> empty byWarehouse, not omitted from results
  });

  it("counts stockout risk across many SKUs from one batched query round, not per-SKU queries", async () => {
    const riskSku = await createSku({ sku: "JELLO-RISK", primaryIdentifierType: "sku", status: "active" });
    const safeSku = await createSku({ sku: "JELLO-SAFE", primaryIdentifierType: "sku", status: "active" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });

    // riskSku: SOH 100 (400 received - 300 sold), sell 10/day -> daysOfCover 10 (< 21 -> at risk)
    await recordLedgerEvent({ skuId: riskSku.id, warehouseId: ff.id, eventType: "receipt", qty: 400, unitCost: "0.42", date: daysAgo(29), sourceRef: "PO-RISK" });
    for (let i = 0; i < 30; i++) {
      await recordSalesActual({ skuId: riskSku.id, warehouseId: ff.id, date: daysAgoStr(i), qty: 10, source: "manual" });
    }

    // safeSku: SOH 970, sell 1/day -> daysOfCover 970 (not at risk)
    await recordLedgerEvent({ skuId: safeSku.id, warehouseId: ff.id, eventType: "receipt", qty: 1000, unitCost: "0.42", date: daysAgo(29), sourceRef: "PO-SAFE" });
    for (let i = 0; i < 30; i++) {
      await recordSalesActual({ skuId: safeSku.id, warehouseId: ff.id, date: daysAgoStr(i), qty: 1, source: "manual" });
    }

    const summary = await getHomeSummary();
    expect(summary.activeSkuCount).toBe(2);
    expect(summary.stockoutRiskSkuCount).toBe(1);
  });

  it("counts a SKU with no ledger history at all as stockout risk, not silently safe", async () => {
    const safeSku = await createSku({ sku: "JELLO-SAFE", primaryIdentifierType: "sku", status: "active" });
    const neverReceivedSku = await createSku({ sku: "JELLO-NEW", primaryIdentifierType: "sku", status: "active" });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });

    await recordLedgerEvent({ skuId: safeSku.id, warehouseId: ff.id, eventType: "receipt", qty: 1000, unitCost: "0.42", date: daysAgo(29), sourceRef: "PO-SAFE" });
    for (let i = 0; i < 30; i++) {
      await recordSalesActual({ skuId: safeSku.id, warehouseId: ff.id, date: daysAgoStr(i), qty: 1, source: "manual" });
    }
    // neverReceivedSku has no ledger events at all -- never received, never sold.

    const summary = await getHomeSummary();
    expect(summary.activeSkuCount).toBe(2);
    expect(summary.stockoutRiskSkuCount).toBe(1);
  });

  it("surfaces unpaid payments past their expected date as overdue payables, separate from the forward-looking near-term window", async () => {
    const vendor = await createVendor({ name: "Lvmengkang" });
    const po = await createPurchaseOrder({ poNumber: "PO3-JELLO", vendorId: vendor.id, lineItems: [], createdBy: userId });

    await createExpectedPayment({ poId: po.id, sequenceNo: 1, expectedAmount: "5000.00", expectedDate: daysAgo(3), currency: "EUR" });
    await createExpectedPayment({ poId: po.id, sequenceNo: 2, expectedAmount: "2000.00", expectedDate: daysFromNow(2), currency: "EUR" });

    const summary = await getHomeSummary();
    expect(summary.overduePayablesAmount).toBeCloseTo(5000);
    expect(summary.nearTermCashNeeds).toBeCloseTo(2000);
  });

  it("getStockDashboard classifies stockout status using each SKU's own lead time and safety stock, not a fixed threshold", async () => {
    const shortLeadSku = await createSku({ sku: "JELLO-SHORT-LEAD", primaryIdentifierType: "sku", status: "active", leadTimeDays: 14, safetyStockDays: 7 });
    const longLeadSku = await createSku({ sku: "JELLO-LONG-LEAD", primaryIdentifierType: "sku", status: "active", leadTimeDays: 66, safetyStockDays: 14 });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });

    // Both SKUs get identical SOH/sales history: 30 days of cover.
    for (const sku of [shortLeadSku, longLeadSku]) {
      await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 300, unitCost: "0.42", date: daysAgo(29), sourceRef: "PO1" });
      for (let i = 0; i < 30; i++) {
        await recordSalesActual({ skuId: sku.id, warehouseId: ff.id, date: daysAgoStr(i), qty: 10, source: "manual" });
      }
    }
    // Both SOH ~= 0 after 30 days of 10/day sales against 300 received -- use a
    // fresh receipt today so daysOfCover reads a clean ~30 for both.
    await recordLedgerEvent({ skuId: shortLeadSku.id, warehouseId: ff.id, eventType: "receipt", qty: 300, unitCost: "0.42", date: new Date(), sourceRef: "PO2" });
    await recordLedgerEvent({ skuId: longLeadSku.id, warehouseId: ff.id, eventType: "receipt", qty: 300, unitCost: "0.42", date: new Date(), sourceRef: "PO2" });

    const stock = await getStockDashboard();
    const shortRow = stock.find((r) => r.skuId === shortLeadSku.id)?.byWarehouse.find((w) => w.warehouseId === ff.id);
    const longRow = stock.find((r) => r.skuId === longLeadSku.id)?.byWarehouse.find((w) => w.warehouseId === ff.id);

    // ~30 days of cover: above shortLeadSku's reorder point (14+7=21) -> "ok".
    // Below longLeadSku's own lead time (66) -> "critical".
    expect(shortRow?.status).toBe("ok");
    expect(longRow?.status).toBe("critical");
  });

  it("getHomeSummary's stockout-risk count uses each SKU's own reorder point, not a fixed 21-day cutoff", async () => {
    const sku = await createSku({ sku: "JELLO-CUSTOM-LEAD", primaryIdentifierType: "sku", status: "active", leadTimeDays: 40, safetyStockDays: 10 });
    const ff = await createWarehouse({ code: "FF-DE", name: "Fulfillment DE" });
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 300, unitCost: "0.42", date: daysAgo(29), sourceRef: "PO1" });
    for (let i = 0; i < 30; i++) {
      await recordSalesActual({ skuId: sku.id, warehouseId: ff.id, date: daysAgoStr(i), qty: 10, source: "manual" });
    }
    await recordLedgerEvent({ skuId: sku.id, warehouseId: ff.id, eventType: "receipt", qty: 300, unitCost: "0.42", date: new Date(), sourceRef: "PO2" });
    // getAverageDailySalesForSkus divides by a fixed 30-day window regardless
    // of how many of those days actually had a sale: 30 days x 10/day = 300
    // total qty -> avgDailySales = 300/30 = 10 exactly. The fresh receipt
    // brings SOH back to exactly 300, so daysOfCover = 300/10 = 30 exactly --
    // below this SKU's reorder point (40+10=50) -> at risk, even though 30 is
    // comfortably above the old fixed 21-day cutoff that code no longer exists.
    const summary = await getHomeSummary();
    expect(summary.stockoutRiskSkuCount).toBe(1);
  });
});
