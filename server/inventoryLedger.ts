import { and, eq, lte, sql } from "drizzle-orm";
import { db } from "./dbClient";
import { inventoryLedger, type InsertLedgerEvent } from "../drizzle/schema";

export async function recordLedgerEvent(event: Omit<InsertLedgerEvent, "id">) {
  await db.insert(inventoryLedger).values(event);
}

export async function getSoh(skuId: number, warehouseId: number, asOfDate?: Date): Promise<number> {
  const conditions = [eq(inventoryLedger.skuId, skuId), eq(inventoryLedger.warehouseId, warehouseId)];
  if (asOfDate) conditions.push(lte(inventoryLedger.date, asOfDate));

  const [row] = await db
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
