import { and, eq, lte, sql } from "drizzle-orm";
import { db, type DbClient } from "./dbClient";
import { inventoryLedger, type InsertLedgerEvent } from "../drizzle/schema";

export async function recordLedgerEvent(event: Omit<InsertLedgerEvent, "id">, dbClient: DbClient = db) {
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

export async function getSohByWarehouse(skuId: number): Promise<{ warehouseId: number; soh: number }[]> {
  const rows = await db
    .select({
      warehouseId: inventoryLedger.warehouseId,
      soh: sql<number>`CAST(COALESCE(SUM(${inventoryLedger.qty}), 0) AS SIGNED)`,
    })
    .from(inventoryLedger)
    .where(eq(inventoryLedger.skuId, skuId))
    .groupBy(inventoryLedger.warehouseId);
  return rows;
}
