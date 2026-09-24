import { and, gte, inArray, sql } from "drizzle-orm";
import { db } from "./dbClient";
import { salesActuals } from "../drizzle/schema";
import { listSkus } from "./db";
import { getSohForSkus } from "./inventoryLedger";
import { listUnmatchedTransactions } from "./payments";
import { getCashflowForecast } from "./cashflow";
import { getDailyCogsForRange } from "./salesPlan";
import { getShipmentLandedUnitCost } from "./landedCost";
import { enumerateDateStrings } from "./dates";

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

// Reorder point = leadTimeDays + safetyStockDays: the days of cover below
// which a fresh order can no longer arrive before stock runs out, plus the
// buffer this business already plans around. Per-SKU rather than a fixed
// bucket, since different SKUs can have genuinely different vendor lead
// times (skus.leadTimeDays/safetyStockDays, editable per SKU in Catalog).
function getStockStatus(daysOfCover: number | null, leadTimeDays: number, safetyStockDays: number): "critical" | "low" | "ok" | "overstock" | "unknown" {
  if (daysOfCover === null) return "unknown";
  const reorderPoint = leadTimeDays + safetyStockDays;
  if (daysOfCover < leadTimeDays) return "critical";
  if (daysOfCover < reorderPoint) return "low";
  if (daysOfCover < reorderPoint * 3) return "ok";
  return "overstock";
}

export async function getHomeSummary() {
  const activeSkus = await listSkus("active");
  const skuIds = activeSkus.map((s) => s.id);
  const unmatched = await listUnmatchedTransactions();

  // Split strictly at "today": [epoch, yesterday] is payables already past
  // their expected date (overdue -- unpaid and should have been settled
  // already), [today, +14d] is the forward-looking near-term window. Reusing
  // getCashflowForecast for both keeps the mixed-currency estimate/flag logic
  // in one place rather than re-summing payments.expectedAmount here too.
  const todayStart = new Date(new Date().toISOString().slice(0, 10));
  const yesterday = new Date(todayStart.getTime() - 86400000);
  const [forecast, overdueForecast] = await Promise.all([
    getCashflowForecast(todayStart, new Date(todayStart.getTime() + 14 * 86400000)),
    getCashflowForecast(new Date(0), yesterday),
  ]);
  const nearTermCashNeeds = forecast.reduce((sum, d) => sum + d.plannedOutflow, 0);
  const overduePayablesAmount = overdueForecast.reduce((sum, d) => sum + d.plannedOutflow, 0);
  const overduePayablesIsEstimated = overdueForecast.some((d) => d.plannedOutflowIsEstimated);

  const sohMap = await getSohForSkus(skuIds);
  const avgSalesMap = await getAverageDailySalesForSkus(skuIds);

  let stockoutRiskSkuCount = 0;
  for (const sku of activeSkus) {
    const byWarehouse = sohMap.get(sku.id) ?? [];
    // A SKU with no ledger history at all has no stock and no visibility into
    // demand — that's the highest-risk state, not a safe one, so it must not
    // be silently excluded just because the inner loop below never runs.
    let atRisk = byWarehouse.length === 0;
    for (const w of byWarehouse) {
      const avgDailySales = avgSalesMap.get(`${sku.id}:${w.warehouseId}`) ?? 0;
      const daysOfCover = avgDailySales > 0 ? w.soh / avgDailySales : null;
      if (daysOfCover !== null && daysOfCover < sku.leadTimeDays + sku.safetyStockDays) {
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
    overduePayablesAmount,
    overduePayablesIsEstimated,
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
      return { ...w, avgDailySales, daysOfCover, status: getStockStatus(daysOfCover, sku.leadTimeDays, sku.safetyStockDays) };
    });
    // Combined across every warehouse, using this SKU's own reorder point —
    // never a fixed day-of-cover band. Computed here so the client never has
    // to reimplement (and risk drifting from) getStockStatus's thresholds.
    const totalSoh = enriched.reduce((sum, w) => sum + w.soh, 0);
    const totalAvgDailySales = enriched.reduce((sum, w) => sum + w.avgDailySales, 0);
    const totalDaysOfCover = totalAvgDailySales > 0 ? totalSoh / totalAvgDailySales : null;
    const total = {
      soh: totalSoh,
      avgDailySales: totalAvgDailySales,
      daysOfCover: totalDaysOfCover,
      status: getStockStatus(totalDaysOfCover, sku.leadTimeDays, sku.safetyStockDays),
    };
    results.push({ skuId: sku.id, sku: sku.sku, byWarehouse: enriched, total });
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
  let dailyCogsError: string | null = null;
  if (opts?.skuId && opts?.warehouseId) {
    const dateKeys = enumerateDateStrings(from, to);
    try {
      dailyCogs = await getDailyCogsForRange(opts.skuId, opts.warehouseId, dateKeys);
    } catch (err) {
      dailyCogsError = err instanceof Error ? err.message : String(err);
    }
  }

  let landedCost: { lineItemId: number; skuId: number; landedUnitCost: number }[] = [];
  let landedCostError: string | null = null;
  if (opts?.shipmentId) {
    try {
      landedCost = await getShipmentLandedUnitCost(opts.shipmentId);
    } catch (err) {
      landedCostError = err instanceof Error ? err.message : String(err);
    }
  }

  return { cashflow, unmatchedTransactions: unmatched, dailyCogs, dailyCogsError, landedCost, landedCostError };
}
