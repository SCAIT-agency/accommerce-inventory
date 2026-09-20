import { and, between, desc, eq, inArray, lte } from "drizzle-orm";
import { db, type DbClient } from "./dbClient";
import { salesPlan, salesActuals, inventoryLedger, salesPlanWeeklyInputs, salesPlanWeeklyRecipeLines } from "../drizzle/schema";
import { recordLedgerEvent } from "./inventoryLedger";
import { enumerateDateStrings } from "./dates";
import type { LandedBatch, SaleEvent } from "./landedCost";

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
  await dbClient
    .insert(salesPlan)
    .values(input)
    .onDuplicateKeyUpdate({ set: { plannedQty: input.plannedQty } });
  const [row] = await dbClient
    .select()
    .from(salesPlan)
    .where(and(eq(salesPlan.skuId, input.skuId), eq(salesPlan.warehouseId, input.warehouseId), eq(salesPlan.periodDate, input.periodDate)));
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
 * Same FIFO semantics as the old day-by-day approach (daily COGS at `date` =
 * cumulative FIFO cost of everything sold through `date`, minus cumulative
 * FIFO cost of everything sold through the day before — computing each day in
 * isolation against the full un-depleted receipt set would double-count
 * batches already consumed by earlier sales, the same class of bug the real
 * Jello buildDailyCogs() clamp had), computed for a whole date range in one
 * query and one chronological forward pass instead of one query-plus-two-
 * full-FIFO-passes per day. Mathematically equivalent to computing each day
 * that way: consuming sales in chronological order against a single shared,
 * depleting `batches` array and bucketing each unit's cost by the sale's own
 * calendar day produces exactly the same per-day figure the old "cost up to
 * this day minus cost up to the day before" subtraction did, since by the
 * time a forward pass reaches a given day, the batches remaining are exactly
 * what "up to the day before" already implied.
 *
 * Two caveats on "exactly the same": (1) failure behavior is very slightly
 * different — the old per-day approach silently returned 0 for a day with no
 * sales at all, which could mask a genuine insufficient-stock condition
 * elsewhere in history; this single-pass version will surface that as a
 * thrown error instead, which is more correct, not a regression, but is a
 * real behavior change. (2) the two are numerically equivalent but not
 * literally bit-for-bit identical for a long history, since floating-point
 * accumulation order differs (direct running total here vs. subtracting two
 * large cumulative sums before) — this version's order is less
 * cancellation-prone, not less precise.
 *
 * `dateKeys` must be sorted ascending (the query's upper bound is derived
 * from its last element) and contain no duplicates — enumerateDateStrings,
 * this function's only caller, already guarantees both; an out-of-order or
 * duplicate array won't throw, it will just silently produce a wrong
 * per-day breakdown for the affected date(s).
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

export async function regenerateSalesPlanForWeek(weekStartDate: string, dbClient: DbClient = db): Promise<void> {
  const [weekInput] = await dbClient.select().from(salesPlanWeeklyInputs).where(eq(salesPlanWeeklyInputs.weekStartDate, weekStartDate));
  if (!weekInput) {
    throw new Error(`regenerateSalesPlanForWeek: no weekly input found for week starting ${weekStartDate}`);
  }

  const weekStart = new Date(weekStartDate);
  const weekEnd = new Date(weekStart);
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
  const weekDates = enumerateDateStrings(weekStart, weekEnd);
  const lastDayOfWeek = weekDates[weekDates.length - 1];
  const todayStr = new Date().toISOString().slice(0, 10);
  if (lastDayOfWeek < todayStr) {
    throw new Error(`regenerateSalesPlanForWeek: week starting ${weekStartDate} is entirely in the past — planning only applies to the current week or later`);
  }

  const revenue = parseFloat(weekInput.plannedRevenue);
  if (!Number.isFinite(revenue) || revenue < 0) {
    throw new Error(`regenerateSalesPlanForWeek: invalid plannedRevenue "${weekInput.plannedRevenue}" for week starting ${weekStartDate} — must be a non-negative number`);
  }
  const primaryPctRaw = parseFloat(weekInput.primaryPercent);
  if (!Number.isFinite(primaryPctRaw) || primaryPctRaw < 0 || primaryPctRaw > 100) {
    throw new Error(`regenerateSalesPlanForWeek: invalid primaryPercent "${weekInput.primaryPercent}" for week starting ${weekStartDate} — must be between 0 and 100`);
  }

  const recipeLines = await dbClient.select().from(salesPlanWeeklyRecipeLines).where(eq(salesPlanWeeklyRecipeLines.weeklyInputId, weekInput.id));
  const dailyRevenue = revenue / 7;
  const primaryPct = primaryPctRaw / 100;

  const rowsToInsert: { skuId: number; warehouseId: number; periodDate: string; plannedQty: number }[] = [];
  const skuIds = recipeLines.map((line) => line.skuId);

  for (const line of recipeLines) {
    const unitsPer1000 = parseFloat(line.unitsPer1000);
    if (!Number.isFinite(unitsPer1000) || unitsPer1000 < 0) {
      throw new Error(`regenerateSalesPlanForWeek: invalid unitsPer1000 "${line.unitsPer1000}" for SKU ${line.skuId} — must be a non-negative number`);
    }
  }

  for (const date of weekDates) {
    for (const line of recipeLines) {
      const rawUnits = (dailyRevenue / 1000) * parseFloat(line.unitsPer1000);
      const totalUnitsRounded = Math.round(rawUnits);
      const primaryUnits = Math.round(totalUnitsRounded * primaryPct);
      const secondaryUnits = totalUnitsRounded - primaryUnits;
      rowsToInsert.push({ skuId: line.skuId, warehouseId: weekInput.primaryWarehouseId, periodDate: date, plannedQty: primaryUnits });
      rowsToInsert.push({ skuId: line.skuId, warehouseId: weekInput.secondaryWarehouseId, periodDate: date, plannedQty: secondaryUnits });
    }
  }

  if (skuIds.length > 0) {
    await dbClient.delete(salesPlan).where(and(
      inArray(salesPlan.skuId, skuIds),
      inArray(salesPlan.warehouseId, [weekInput.primaryWarehouseId, weekInput.secondaryWarehouseId]),
      between(salesPlan.periodDate, weekStartDate, lastDayOfWeek),
    ));
  }
  if (rowsToInsert.length > 0) {
    await dbClient.insert(salesPlan).values(rowsToInsert);
  }
}

export interface UpsertWeeklyInputInput {
  weekStartDate: string;
  plannedRevenue: string;
  primaryWarehouseId: number;
  primaryPercent: string;
  secondaryWarehouseId: number;
  recipeLines: { skuId: number; unitsPer1000: string }[];
}

export async function upsertWeeklyInput(input: UpsertWeeklyInputInput): Promise<void> {
  await db.transaction(async (tx) => {
    // Capture the OLD warehouse pair and recipe before the upsert overwrites
    // them. regenerateSalesPlanForWeek (called below) always freshly writes
    // the CURRENT recipe's rows under the CURRENT warehouse pair regardless
    // of what existed before — so it's always correct, and simpler than
    // tracking "removed" vs "retained" SKUs separately, to unconditionally
    // delete every PREVIOUS-recipe SKU's rows under the PREVIOUS pair first:
    // a SKU still in the recipe under an unchanged pair gets deleted here
    // then immediately recreated by regenerateSalesPlanForWeek with the same
    // values (no data loss); a removed SKU just stays deleted; and a SKU
    // still in the recipe whose pair was reassigned stops being
    // double-counted under both the old and new warehouses. No existing row
    // means a brand-new week: nothing to clean up.
    const [existingWeekInput] = await tx.select().from(salesPlanWeeklyInputs).where(eq(salesPlanWeeklyInputs.weekStartDate, input.weekStartDate));

    const previousRecipeLines = existingWeekInput
      ? await tx.select().from(salesPlanWeeklyRecipeLines).where(eq(salesPlanWeeklyRecipeLines.weeklyInputId, existingWeekInput.id))
      : [];
    const previousSkuIds = previousRecipeLines.map((line) => line.skuId);

    if (previousSkuIds.length > 0 && existingWeekInput) {
      const weekStart = new Date(input.weekStartDate);
      const weekEnd = new Date(weekStart);
      weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
      const weekDates = enumerateDateStrings(weekStart, weekEnd);
      await tx.delete(salesPlan).where(and(
        inArray(salesPlan.skuId, previousSkuIds),
        inArray(salesPlan.warehouseId, [existingWeekInput.primaryWarehouseId, existingWeekInput.secondaryWarehouseId]),
        between(salesPlan.periodDate, input.weekStartDate, weekDates[weekDates.length - 1]),
      ));
    }

    await tx
      .insert(salesPlanWeeklyInputs)
      .values({
        weekStartDate: input.weekStartDate,
        plannedRevenue: input.plannedRevenue,
        primaryWarehouseId: input.primaryWarehouseId,
        primaryPercent: input.primaryPercent,
        secondaryWarehouseId: input.secondaryWarehouseId,
      })
      .onDuplicateKeyUpdate({
        set: {
          plannedRevenue: input.plannedRevenue,
          primaryWarehouseId: input.primaryWarehouseId,
          primaryPercent: input.primaryPercent,
          secondaryWarehouseId: input.secondaryWarehouseId,
        },
      });
    const [weekInput] = await tx.select().from(salesPlanWeeklyInputs).where(eq(salesPlanWeeklyInputs.weekStartDate, input.weekStartDate));

    await tx.delete(salesPlanWeeklyRecipeLines).where(eq(salesPlanWeeklyRecipeLines.weeklyInputId, weekInput.id));
    if (input.recipeLines.length > 0) {
      await tx.insert(salesPlanWeeklyRecipeLines).values(
        input.recipeLines.map((line) => ({ weeklyInputId: weekInput.id, skuId: line.skuId, unitsPer1000: line.unitsPer1000 })),
      );
    }

    await regenerateSalesPlanForWeek(input.weekStartDate, tx);
  });
}

export async function listWeeklyInputs(from: string, to: string): Promise<(typeof salesPlanWeeklyInputs.$inferSelect & { recipeLines: (typeof salesPlanWeeklyRecipeLines.$inferSelect)[] })[]> {
  const weekInputs = await db.select().from(salesPlanWeeklyInputs).where(between(salesPlanWeeklyInputs.weekStartDate, from, to));
  if (weekInputs.length === 0) return [];

  const weekInputIds = weekInputs.map((w) => w.id);
  const allRecipeLines = await db.select().from(salesPlanWeeklyRecipeLines).where(inArray(salesPlanWeeklyRecipeLines.weeklyInputId, weekInputIds));

  return weekInputs.map((weekInput) => ({
    ...weekInput,
    recipeLines: allRecipeLines.filter((line) => line.weeklyInputId === weekInput.id),
  }));
}
