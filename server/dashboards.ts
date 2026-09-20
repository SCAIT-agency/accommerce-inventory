import { and, gte, inArray, sql } from "drizzle-orm";
import { db } from "./dbClient";
import { salesActuals } from "../drizzle/schema";
import { listSkus } from "./db";
import { getSohForSkus } from "./inventoryLedger";
import { listUnmatchedTransactions } from "./payments";
import { getCashflowForecast } from "./cashflow";
import { getDailyCogsForRange } from "./salesPlan";
import { getShipmentLandedUnitCost } from "./landedCost";

function enumerateDateStrings(from: Date, to: Date): string[] {
  const dates: string[] = [];
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

// In-code lookup for V1; move to app_settings-driven config when a real
// client needs to tune these thresholds — out of scope for this task.
const STOCK_STATUS_THRESHOLDS: { maxDays: number; label: "critical" | "low" | "ok" | "overstock" }[] = [
  { maxDays: 21, label: "critical" },
  { maxDays: 45, label: "low" },
  { maxDays: 90, label: "ok" },
  { maxDays: Infinity, label: "overstock" },
];

// shopifyDailyPull only writes a sales_actuals row on days a SKU actually
// sold, so the denominator must be calendar days in the window — not the
// number of rows that came back, which would inflate the average (and deflate
// days-of-cover) by the ratio of selling-days to calendar-days.
//
// One grouped query for every requested SKU at once, keyed by the composite
// string `${skuId}:${warehouseId}` (matching this codebase's existing
// composite-key convention, e.g. the migration reconciliation code's
// `${poNumber}::${sku}` keys) — replaces what used to be one query per
// SKU/warehouse pair.
async function getAverageDailySalesForSkus(skuIds: number[], windowDays = 30): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (skuIds.length === 0) return result;

  const windowStart = new Date(Date.now() - windowDays * 86400000).toISOString().slice(0, 10);
  const rows = await db
    .select({
      skuId: salesActuals.skuId,
      warehouseId: salesActuals.warehouseId,
      totalQty: sql<number>`CAST(COALESCE(SUM(${salesActuals.qty}), 0) AS SIGNED)`,
    })
    .from(salesActuals)
    .where(and(inArray(salesActuals.skuId, skuIds), gte(salesActuals.date, windowStart)))
    .groupBy(salesActuals.skuId, salesActuals.warehouseId);

  for (const row of rows) {
    result.set(`${row.skuId}:${row.warehouseId}`, row.totalQty / windowDays);
  }
  return result;
}

function getStockStatus(daysOfCover: number | null): "critical" | "low" | "ok" | "overstock" | "unknown" {
  if (daysOfCover === null) return "unknown";
  const bucket = STOCK_STATUS_THRESHOLDS.find((t) => daysOfCover < t.maxDays);
  return bucket?.label ?? "overstock";
}

export async function getHomeSummary() {
  const activeSkus = await listSkus("active");
  const skuIds = activeSkus.map((s) => s.id);
  const unmatched = await listUnmatchedTransactions();
  const forecast = await getCashflowForecast(new Date(), new Date(Date.now() + 14 * 86400000));
  const nearTermCashNeeds = forecast.reduce((sum, d) => sum + d.plannedOutflow, 0);

  const sohMap = await getSohForSkus(skuIds);
  const avgSalesMap = await getAverageDailySalesForSkus(skuIds);

  let stockoutRiskSkuCount = 0;
  for (const sku of activeSkus) {
    const byWarehouse = sohMap.get(sku.id) ?? [];
    let atRisk = false;
    for (const w of byWarehouse) {
      const avgDailySales = avgSalesMap.get(`${sku.id}:${w.warehouseId}`) ?? 0;
      const daysOfCover = avgDailySales > 0 ? w.soh / avgDailySales : null;
      if (daysOfCover !== null && daysOfCover < 21) {
        atRisk = true;
        break;
      }
    }
    if (atRisk) stockoutRiskSkuCount++;
  }

  return {
    activeSkuCount: activeSkus.length,
    stockoutRiskSkuCount,
    nearTermCashNeeds,
    unmatchedTransactionCount: unmatched.length,
  };
}

export async function getStockDashboard() {
  const activeSkus = await listSkus("active");
  const skuIds = activeSkus.map((s) => s.id);
  const sohMap = await getSohForSkus(skuIds);
  const avgSalesMap = await getAverageDailySalesForSkus(skuIds);

  const results = [];
  for (const sku of activeSkus) {
    const byWarehouse = sohMap.get(sku.id) ?? [];
    const enriched = byWarehouse.map((w) => {
      const avgDailySales = avgSalesMap.get(`${sku.id}:${w.warehouseId}`) ?? 0;
      const daysOfCover = avgDailySales > 0 ? w.soh / avgDailySales : null;
      return { ...w, avgDailySales, daysOfCover, status: getStockStatus(daysOfCover) };
    });
    results.push({ skuId: sku.id, sku: sku.sku, byWarehouse: enriched });
  }
  return results;
}

export async function getMoneyDashboard(
  from: Date,
  to: Date,
  opts?: { skuId?: number; warehouseId?: number; shipmentId?: number },
) {
  const cashflow = await getCashflowForecast(from, to);
  const unmatched = await listUnmatchedTransactions();

  let dailyCogs: { date: string; cogs: number }[] = [];
  if (opts?.skuId && opts?.warehouseId) {
    const dateKeys = enumerateDateStrings(from, to);
    dailyCogs = await getDailyCogsForRange(opts.skuId, opts.warehouseId, dateKeys);
  }

  let landedCost: { skuId: number; landedUnitCost: number }[] = [];
  let landedCostError: string | null = null;
  if (opts?.shipmentId) {
    try {
      landedCost = await getShipmentLandedUnitCost(opts.shipmentId);
    } catch (err) {
      landedCostError = err instanceof Error ? err.message : String(err);
    }
  }

  return { cashflow, unmatchedTransactions: unmatched, dailyCogs, landedCost, landedCostError };
}
