// server/nightlyExport.ts
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { db } from "./dbClient";
import {
  skus,
  vendors,
  warehouses,
  purchaseOrders,
  poLineItems,
  shipments,
  shipmentLineItems,
  payments,
  transactions,
  inventoryLedger,
  salesPlan,
  salesActuals,
  changeLog,
  salesPlanWeeklyInputs,
  salesPlanWeeklyRecipeLines,
} from "../drizzle/schema";

export function generateCsvExport(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const escape = (value: unknown): string => {
    const str = value === null || value === undefined ? "" : String(value);
    return str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")
      ? `"${str.replace(/"/g, '""')}"`
      : str;
  };
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => escape(row[h])).join(","));
  }
  return lines.join("\n");
}

const CORE_TABLES = {
  skus, vendors, warehouses, purchase_orders: purchaseOrders, po_line_items: poLineItems,
  shipments, shipment_line_items: shipmentLineItems, payments, transactions,
  inventory_ledger: inventoryLedger, sales_plan: salesPlan, sales_actuals: salesActuals,
  change_log: changeLog,
} as const;

export async function runNightlyExport(outDir: string): Promise<string[]> {
  const timestamp = new Date().toISOString().slice(0, 10);
  const dayDir = join(outDir, timestamp);
  await mkdir(dayDir, { recursive: true });

  const writtenPaths: string[] = [];
  for (const [tableName, table] of Object.entries(CORE_TABLES)) {
    const rows = await db.select().from(table as any);
    const csv = generateCsvExport(rows as Record<string, unknown>[]);
    const path = join(dayDir, `${tableName}.csv`);
    await writeFile(path, csv, "utf-8");
    writtenPaths.push(path);
  }
  return writtenPaths;
}
