import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { db, type DbClient } from "./dbClient";
import { inventoryLedger, type InsertLedgerEvent } from "../drizzle/schema";

export async function recordLedgerEvent(event: Omit<InsertLedgerEvent, "id">, dbClient: DbClient = db) {
  // Known, accepted TOCTOU race: the SOH check below and the insert after it
  // are not atomic against another concurrent write for the same SKU/
  // warehouse — two negative-qty events checked in parallel could each see
  // the same pre-write SOH and both pass, together driving it negative. Not
  // fixed: this is a single-operator system with no concurrent-write path in
  // practice today (the daily Shopify pull and manual entry aren't run
  // concurrently against the same SKU/warehouse), and a real fix (a
  // SELECT ... FOR UPDATE or a DB-level CHECK constraint) is more machinery
  // than the actual risk currently justifies. Revisit if a second writer
  // (e.g. a second operator, or a concurrent import) is ever introduced.
  if (event.qty < 0) {
    // Same-day ledger events have no reliable sub-day insertion order: a
    // whole-day sales aggregate (recordSalesActual) anchors at end-of-day,
    // while a receipt or manual correction keeps its true wall-clock time.
    // Evaluating solvency as of the END of this event's own calendar day
    // (not its exact timestamp) makes every same-day event visible to every
    // other same-day event's guard check, regardless of insertion order.
    const asOfDate = endOfDayUtc(event.date);
    const currentSoh = await getSoh(event.skuId, event.warehouseId, asOfDate, dbClient);
    if (currentSoh + event.qty < 0) {
      throw new Error(
        `recordLedgerEvent: this event would drive SOH negative for sku ${event.skuId}/warehouse ${event.warehouseId} ` +
        `(current: ${currentSoh}, event qty: ${event.qty}) — refusing to write`,
      );
    }
  }
  await dbClient.insert(inventoryLedger).values(event);
}

function endOfDayUtc(date: Date): Date {
  return new Date(`${date.toISOString().slice(0, 10)}T23:59:59.999Z`);
}

export async function getSoh(skuId: number, warehouseId: number, asOfDate?: Date, dbClient: DbClient = db): Promise<number> {
  const conditions = [eq(inventoryLedger.skuId, skuId), eq(inventoryLedger.warehouseId, warehouseId)];
  if (asOfDate) conditions.push(lte(inventoryLedger.date, asOfDate));

  const [row] = await dbClient
    .select({ total: sql<number>`CAST(COALESCE(SUM(${inventoryLedger.qty}), 0) AS SIGNED)` })
    .from(inventoryLedger)
    .where(and(...conditions));
  return row?.total ?? 0;
}

export async function getSohForSkus(skuIds: number[]): Promise<Map<number, { warehouseId: number; soh: number }[]>> {
  const result = new Map<number, { warehouseId: number; soh: number }[]>();
  if (skuIds.length === 0) return result;

  const rows = await db
    .select({
      skuId: inventoryLedger.skuId,
      warehouseId: inventoryLedger.warehouseId,
      soh: sql<number>`CAST(COALESCE(SUM(${inventoryLedger.qty}), 0) AS SIGNED)`,
    })
    .from(inventoryLedger)
    .where(inArray(inventoryLedger.skuId, skuIds))
    .groupBy(inventoryLedger.skuId, inventoryLedger.warehouseId);

  for (const row of rows) {
    const existing = result.get(row.skuId) ?? [];
    existing.push({ warehouseId: row.warehouseId, soh: row.soh });
    result.set(row.skuId, existing);
  }
  return result;
}
