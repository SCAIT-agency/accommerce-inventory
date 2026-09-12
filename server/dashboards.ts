import { and, eq, gte } from "drizzle-orm";
import { db } from "./dbClient";
import { salesActuals } from "../drizzle/schema";
import { listSkus } from "./db";
import { getSohByWarehouse } from "./inventoryLedger";
import { listUnmatchedTransactions } from "./payments";
import { getCashflowForecast } from "./cashflow";
import { getDailyCogs } from "./salesPlan";
import { getShipmentLandedUnitCost } from "./landedCost";

function enumerateDates(from: Date, to: Date): Date[] {
  const dates: Date[] = [];
  const cursor = new Date(from);
  while (cursor <= to) {
    dates.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
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
async function getAverageDailySales(skuId: number, warehouseId: number, windowDays = 30): Promise<number> {
  const windowStart = new Date(Date.now() - windowDays * 86400000);
  const rows = await db
    .select()
    .from(salesActuals)
    .where(
      and(
        eq(salesActuals.skuId, skuId),
        eq(salesActuals.warehouseId, warehouseId),
        gte(salesActuals.date, windowStart),
      ),
    );
  if (rows.length === 0) return 0;
  const totalQty = rows.reduce((sum, r) => sum + r.qty, 0);
  return totalQty / windowDays;
}

function getStockStatus(daysOfCover: number | null): "critical" | "low" | "ok" | "overstock" | "unknown" {
  if (daysOfCover === null) return "unknown";
  const bucket = STOCK_STATUS_THRESHOLDS.find((t) => daysOfCover < t.maxDays);
  return bucket?.label ?? "overstock";
}

export async function getHomeSummary() {
  const activeSkus = await listSkus("active");
  const unmatched = await listUnmatchedTransactions();
  const forecast = await getCashflowForecast(new Date(), new Date(Date.now() + 14 * 86400000));
  const nearTermCashNeeds = forecast.reduce((sum, d) => sum + d.plannedOutflow, 0);

  let stockoutRiskSkuCount = 0;
  for (const sku of activeSkus) {
    const byWarehouse = await getSohByWarehouse(sku.id);
    let atRisk = false;
    for (const w of byWarehouse) {
      const avgDailySales = await getAverageDailySales(sku.id, w.warehouseId);
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
  const results = [];
  for (const sku of activeSkus) {
    const byWarehouse = await getSohByWarehouse(sku.id);
    const enriched = await Promise.all(
      byWarehouse.map(async (w) => {
        const avgDailySales = await getAverageDailySales(sku.id, w.warehouseId);
        const daysOfCover = avgDailySales > 0 ? w.soh / avgDailySales : null;
        return { ...w, avgDailySales, daysOfCover, status: getStockStatus(daysOfCover) };
      }),
    );
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
    const days = enumerateDates(from, to);
    dailyCogs = await Promise.all(
      days.map(async (date) => ({
        date: date.toISOString().slice(0, 10),
        cogs: await getDailyCogs(opts.skuId!, opts.warehouseId!, date),
      })),
    );
  }

  let landedCost: { skuId: number; landedUnitCost: number }[] = [];
  if (opts?.shipmentId) {
    landedCost = await getShipmentLandedUnitCost(opts.shipmentId);
  }

  return { cashflow, unmatchedTransactions: unmatched, dailyCogs, landedCost };
}
