import { and, between, desc, eq } from "drizzle-orm";
import { db, type DbClient } from "./dbClient";
import { salesPlan, salesActuals, inventoryLedger } from "../drizzle/schema";
import { recordLedgerEvent } from "./inventoryLedger";
import { computeFifoCogs, type LandedBatch, type SaleEvent } from "./landedCost";

export interface CreateSalesPlanEntryInput {
  skuId: number;
  warehouseId: number;
  periodDate: string;
  plannedQty: number;
}

export interface RecordSalesActualInput {
  skuId: number;
  warehouseId: number;
  date: string;
  qty: number;
  source: "shopify_daily_pull" | "manual";
}

export async function createSalesPlanEntry(
  input: CreateSalesPlanEntryInput,
  dbClient: DbClient = db,
): Promise<typeof salesPlan.$inferSelect> {
  const [result] = await dbClient.insert(salesPlan).values(input);
  const [row] = await dbClient.select().from(salesPlan).where(eq(salesPlan.id, result.insertId));
  return row;
}

export async function recordSalesActual(input: RecordSalesActualInput): Promise<void> {
  // Both writes must land or neither does — recordLedgerEvent can now throw
  // (negative-stock guard), and an unguarded sequential write would leave a
  // sales_actuals row with no matching ledger event, breaking the
  // ledger-as-single-source-of-truth invariant silently.
  await db.transaction(async (tx) => {
    await tx.insert(salesActuals).values(input);
    await recordLedgerEvent(
      {
        skuId: input.skuId,
        warehouseId: input.warehouseId,
        eventType: "sale",
        qty: -input.qty,
        unitCost: null,
        date: new Date(input.date),
        sourceRef: `sales_actual:${input.source}`,
      },
      tx,
    );
  });
}

export async function getSalesVolatility(skuId: number, warehouseId: number, weeks: number): Promise<number> {
  const rows = await db
    .select()
    .from(salesActuals)
    .where(and(eq(salesActuals.skuId, skuId), eq(salesActuals.warehouseId, warehouseId)))
    .orderBy(desc(salesActuals.date))
    .limit(weeks);

  const qtys = rows.map((r) => r.qty);
  if (qtys.length === 0) return 0;
  const mean = qtys.reduce((a, b) => a + b, 0) / qtys.length;
  if (mean === 0) return 0;
  const variance = qtys.reduce((sum, q) => sum + (q - mean) ** 2, 0) / qtys.length;
  const stdev = Math.sqrt(variance);
  return stdev / mean;
}

export async function getPlanActualDeviation(skuId: number, warehouseId: number, from: string, to: string) {
  const plans = await db
    .select()
    .from(salesPlan)
    .where(and(eq(salesPlan.skuId, skuId), eq(salesPlan.warehouseId, warehouseId), between(salesPlan.periodDate, from, to)));
  const actuals = await db
    .select()
    .from(salesActuals)
    .where(and(eq(salesActuals.skuId, skuId), eq(salesActuals.warehouseId, warehouseId), between(salesActuals.date, from, to)));

  return plans.map((plan) => {
    const dateKey = plan.periodDate;
    const actual = actuals
      .filter((a) => a.date === dateKey)
      .reduce((sum, a) => sum + a.qty, 0);
    return { date: dateKey, planned: plan.plannedQty, actual, deviation: actual - plan.plannedQty };
  });
}

/**
 * Daily COGS at `date` = cumulative FIFO cost of everything sold through `date`,
 * minus cumulative FIFO cost of everything sold through the day before. Computing
 * each day in isolation against the full (un-depleted) receipt set would double-count
 * batches already consumed by earlier sales — this is the same class of bug the real
 * Jello buildDailyCogs() clamp had (it didn't gate on whether a batch had actually
 * landed by the date being evaluated).
 */
export async function getDailyCogs(skuId: number, warehouseId: number, date: Date): Promise<number> {
  const events = await db
    .select()
    .from(inventoryLedger)
    .where(and(eq(inventoryLedger.skuId, skuId), eq(inventoryLedger.warehouseId, warehouseId)))
    .orderBy(inventoryLedger.date);

  const dateKey = date.toISOString().slice(0, 10);
  const receipts: LandedBatch[] = events
    .filter((e) => e.eventType === "receipt" && e.date <= date)
    .map((e) => ({ qty: e.qty, unitCost: parseFloat(e.unitCost ?? "0"), date: e.date }));

  const salesUpToAndIncluding: SaleEvent[] = events
    .filter((e) => e.eventType === "sale" && e.date <= date)
    .map((e) => ({ qty: Math.abs(e.qty), date: e.date }));
  const salesBeforeDate: SaleEvent[] = salesUpToAndIncluding.filter(
    (s) => s.date.toISOString().slice(0, 10) !== dateKey,
  );

  if (salesUpToAndIncluding.length === salesBeforeDate.length) return 0;

  const cogsUpToDate = computeFifoCogs(receipts, salesUpToAndIncluding).totalCogs;
  const cogsBeforeDate = computeFifoCogs(receipts, salesBeforeDate).totalCogs;
  return cogsUpToDate - cogsBeforeDate;
}
