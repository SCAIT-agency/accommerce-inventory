// server/nightlyExport.ts
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { gt } from "drizzle-orm";
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

function csvEscape(value: unknown): string {
  const str = value === null || value === undefined ? "" : String(value);
  return str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")
    ? `"${str.replace(/"/g, '""')}"`
    : str;
}

function csvLine(headers: string[], row: Record<string, unknown>): string {
  return headers.map((h) => csvEscape(row[h])).join(",");
}

export function generateCsvExport(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(csvLine(headers, row));
  }
  return lines.join("\n");
}

const CORE_TABLES = {
  skus, vendors, warehouses, purchase_orders: purchaseOrders, po_line_items: poLineItems,
  shipments, shipment_line_items: shipmentLineItems, payments, transactions,
  inventory_ledger: inventoryLedger, sales_plan: salesPlan, sales_actuals: salesActuals,
  change_log: changeLog,
  sales_plan_weekly_inputs: salesPlanWeeklyInputs,
  sales_plan_weekly_recipe_lines: salesPlanWeeklyRecipeLines,
} as const;

const EXPORT_PAGE_SIZE = 5000;

/**
 * Streams one table to a CSV file in bounded-size pages (keyset pagination on
 * `id`, which every CORE_TABLES table has as an autoincrement primary key),
 * instead of loading the whole table into memory as JS objects and building
 * one giant CSV string before writing it out in a single call — the previous
 * approach, which will OOM once a table (inventory_ledger especially) grows
 * past what fits comfortably in memory at once.
 *
 * `pageSize` defaults to EXPORT_PAGE_SIZE; overridable for tests, matching
 * this codebase's existing `dbClient: DbClient = db` DI convention.
 */
export async function exportTableToCsv(
  table: any,
  path: string,
  pageSize: number = EXPORT_PAGE_SIZE,
): Promise<void> {
  const stream = createWriteStream(path, { encoding: "utf-8" });
  const finished = new Promise<void>((resolve, reject) => {
    stream.on("finish", resolve);
    stream.on("error", reject);
  });

  let cursor = 0;
  let headers: string[] | null = null;
  let isFirstLine = true;
  const writeLine = (line: string) => {
    stream.write((isFirstLine ? "" : "\n") + line);
    isFirstLine = false;
  };

  while (true) {
    const rows = (await db
      .select()
      .from(table)
      .where(gt(table.id, cursor))
      .orderBy(table.id)
      .limit(pageSize)) as Record<string, unknown>[];
    if (rows.length === 0) break;

    if (headers === null) {
      headers = Object.keys(rows[0]);
      writeLine(headers.join(","));
    }
    for (const row of rows) {
      writeLine(csvLine(headers, row));
    }
    cursor = rows[rows.length - 1].id as number;
  }

  stream.end();
  await finished;
}

export async function runNightlyExport(outDir: string): Promise<string[]> {
  const timestamp = new Date().toISOString().slice(0, 10);
  const dayDir = join(outDir, timestamp);
  await mkdir(dayDir, { recursive: true });

  const writtenPaths: string[] = [];
  for (const [tableName, table] of Object.entries(CORE_TABLES)) {
    const path = join(dayDir, `${tableName}.csv`);
    await exportTableToCsv(table, path);
    writtenPaths.push(path);
  }
  return writtenPaths;
}
