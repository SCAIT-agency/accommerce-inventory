import { and, between, desc, eq, lte } from "drizzle-orm";
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
        // Anchored at end-of-day, not midnight: sales_actuals rows are whole-day
        // aggregates, and must sort after any real-timestamped event (e.g. a
        // same-day receipt) for the negative-SOH guard's same-day ordering to hold.
        date: new Date(`${input.date}T23:59:59.999Z`),
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
export async function getDailyCogs(skuId: number, warehouseId: number, dateKey: string): Promise<number> {
  const events = await db
    .select()
    .from(inventoryLedger)
    .where(and(eq(inventoryLedger.skuId, skuId), eq(inventoryLedger.warehouseId, warehouseId)))
    .orderBy(inventoryLedger.date);

  // Calendar-day comparison, not a raw timestamp <=: sale-derived ledger events
  // are now anchored at end-of-day (23:59:59.999), so a same-day sale would
  // fail a naive `e.date <= date` check against a midnight-anchored `date` arg.
  const receipts: LandedBatch[] = events
    .filter((e) => e.eventType === "receipt" && e.date.toISOString().slice(0, 10) <= dateKey)
    .map((e) => ({ qty: e.qty, unitCost: parseFloat(e.unitCost ?? "0"), date: e.date }));

  const salesUpToAndIncluding: SaleEvent[] = events
    .filter((e) => e.eventType === "sale" && e.date.toISOString().slice(0, 10) <= dateKey)
    .map((e) => ({ qty: Math.abs(e.qty), date: e.date }));
  const salesBeforeDate: SaleEvent[] = salesUpToAndIncluding.filter(
    (s) => s.date.toISOString().slice(0, 10) !== dateKey,
  );

  if (salesUpToAndIncluding.length === salesBeforeDate.length) return 0;

  const cogsUpToDate = computeFifoCogs(receipts, salesUpToAndIncluding).totalCogs;
  const cogsBeforeDate = computeFifoCogs(receipts, salesBeforeDate).totalCogs;
  return cogsUpToDate - cogsBeforeDate;
}

/**
 * Same FIFO semantics as getDailyCogs, computed for a whole date range in one
 * query and one chronological forward pass instead of one query-plus-two-
 * full-FIFO-passes per day. Mathematically equivalent to calling getDailyCogs
 * once per day: consuming sales in chronological order against a single
 * shared, depleting `batches` array and bucketing each unit's cost by the
 * sale's own calendar day produces exactly the same per-day figure the old
 * "cost up to this day minus cost up to the day before" subtraction did,
 * since by the time a forward pass reaches a given day, the batches
 * remaining are exactly what "up to the day before" already implied.
 */
export async function getDailyCogsForRange(skuId: number, warehouseId: number, dateKeys: string[]): Promise<{ date: string; cogs: number }[]> {
  if (dateKeys.length === 0) return [];

  const windowEnd = new Date(`${dateKeys[dateKeys.length - 1]}T23:59:59.999Z`);
  const events = await db
    .select()
    .from(inventoryLedger)
    .where(and(eq(inventoryLedger.skuId, skuId), eq(inventoryLedger.warehouseId, warehouseId), lte(inventoryLedger.date, windowEnd)))
    .orderBy(inventoryLedger.date);

  const batches: LandedBatch[] = events
    .filter((e) => e.eventType === "receipt")
    .map((e) => ({ qty: e.qty, unitCost: parseFloat(e.unitCost ?? "0"), date: e.date }));

  const sales: SaleEvent[] = events
    .filter((e) => e.eventType === "sale")
    .map((e) => ({ qty: Math.abs(e.qty), date: e.date }));

  const dailyCogs = new Map<string, number>(dateKeys.map((d) => [d, 0]));

  for (const sale of sales) {
    const dateKey = sale.date.toISOString().slice(0, 10);
    let remainingToConsume = sale.qty;
    let consumedCost = 0;
    while (remainingToConsume > 0) {
      const batch = batches.find((b) => b.qty > 0 && b.date <= sale.date);
      if (!batch) {
        throw new Error(`insufficient stock: cannot consume ${remainingToConsume} units for sale on ${sale.date.toISOString()}`);
      }
      const consumed = Math.min(batch.qty, remainingToConsume);
      consumedCost += consumed * batch.unitCost;
      batch.qty -= consumed;
      remainingToConsume -= consumed;
    }
    if (dailyCogs.has(dateKey)) {
      dailyCogs.set(dateKey, dailyCogs.get(dateKey)! + consumedCost);
    }
  }

  return dateKeys.map((date) => ({ date, cogs: dailyCogs.get(date)! }));
}
