import { recordSalesActual } from "./salesPlan";

export interface ShopifyExportRow {
  sku: string;
  warehouse_code: string;
  order_date: string;
  qty: string;
}

export interface ParsedSale {
  sku: string;
  warehouseCode: string;
  date: string;
  qty: number;
}

export function parseShopifyExport(rows: ShopifyExportRow[]): ParsedSale[] {
  const grouped = new Map<string, ParsedSale>();
  for (const row of rows) {
    const key = `${row.sku}|${row.warehouse_code}|${row.order_date}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.qty += parseInt(row.qty, 10);
    } else {
      grouped.set(key, { sku: row.sku, warehouseCode: row.warehouse_code, date: row.order_date, qty: parseInt(row.qty, 10) });
    }
  }
  return Array.from(grouped.values());
}

export interface SkippedRow {
  sku: string;
  reason: string;
}

export async function runDailyShopifyPull(
  rows: ShopifyExportRow[],
  skuLookup: Record<string, number>,
  warehouseLookup: Record<string, number>,
): Promise<{ imported: number; skipped: SkippedRow[] }> {
  const parsed = parseShopifyExport(rows);
  let imported = 0;
  const skipped: SkippedRow[] = [];

  for (const sale of parsed) {
    const skuId = skuLookup[sale.sku];
    const warehouseId = warehouseLookup[sale.warehouseCode];
    if (!skuId) {
      skipped.push({ sku: sale.sku, reason: "unknown SKU" });
      continue;
    }
    if (!warehouseId) {
      skipped.push({ sku: sale.sku, reason: "unknown warehouse" });
      continue;
    }
    await recordSalesActual({
      skuId,
      warehouseId,
      date: new Date(sale.date),
      qty: sale.qty,
      source: "shopify_daily_pull",
    });
    imported++;
  }

  return { imported, skipped };
}
