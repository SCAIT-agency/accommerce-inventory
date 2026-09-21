// Typed readers over a ControlTowerSnapshot for the facts the platform is
// compared against (and for the receipts/sales the golden test replays).
// Pure: no I/O, no DB. Every reader derives the SKU list from SKU Master and
// never hardcodes Jello/Mixer/Straw, so a fourth SKU in the Sheet needs no
// code change here.

import { normalizeDate, normalizeNumber } from "./csv";
import { cell, splitAtBlank, type ControlTowerSnapshot, type Tab, type TabKey } from "./snapshot";

export interface WarehouseTabs {
  code: string;
  salesPlan: TabKey;
  stockModel: TabKey;
}

// The Sheet keeps one Sales Plan and one StockModel tab per warehouse; the
// platform's warehouse code is the same short name the Sheet uses everywhere
// else (Shipments "Actual Warehouse", Inventory Ledger "Warehouse").
export const WAREHOUSES: readonly WarehouseTabs[] = [
  { code: "FF", salesPlan: "salesPlanFF", stockModel: "stockModelFF" },
  { code: "Mutual", salesPlan: "salesPlanMutual", stockModel: "stockModelMutual" },
];

export function skuCodes(snap: ControlTowerSnapshot): string[] {
  return snap.skuMaster.rows.map((r) => cell(snap.skuMaster, r, "SKU"));
}

export function num(tab: Tab, row: string[], column: string): number | null {
  const v = normalizeNumber(cell(tab, row, column));
  return v === null ? null : parseFloat(v);
}

export function date(tab: Tab, row: string[], column: string): string | null {
  return normalizeDate(cell(tab, row, column));
}

export const seriesKey = (sku: string, warehouse: string, day: string) => `${sku}|${warehouse}|${day}`;
export const pairKey = (sku: string, warehouse: string) => `${sku}|${warehouse}`;

export interface ReceiptFact {
  shipmentRef: string;
  sku: string;
  warehouse: string;
  date: string;
  qty: number;
  unitCost: number;
}

/** One receipt per landed shipment line, costed from the Landed Cost Summary (net of recoverable EUST/VAT). */
export function readReceipts(snap: ControlTowerSnapshot): ReceiptFact[] {
  const lcs = snap.landedCostSummary;
  const costByLine = new Map<string, number>();
  for (const r of lcs.rows) {
    const key = `${cell(lcs, r, "Shipment ID (Wave)")}::${cell(lcs, r, "SKU")}`;
    const cost = num(lcs, r, "Total Cost/unit (minus recoverable EUST/VAT)");
    if (cost !== null) costByLine.set(key, cost);
  }

  const sh = snap.shipments;
  const receipts: ReceiptFact[] = [];
  for (const r of sh.rows) {
    const landed = date(sh, r, "Actual Arrival Date");
    if (!landed) continue;
    const shipmentRef = cell(sh, r, "Shipment ID");
    const warehouse = cell(sh, r, "Actual Warehouse");
    for (const sku of skuCodes(snap)) {
      const qty = num(sh, r, `${sku} Qty`);
      if (qty === null || qty === 0) continue;
      const unitCost = costByLine.get(`${shipmentRef}::${sku}`);
      if (unitCost === undefined) {
        throw new Error(`Landed Cost Summary has no row for landed line ${shipmentRef} / ${sku}`);
      }
      receipts.push({ shipmentRef, sku, warehouse, date: landed, qty, unitCost });
    }
  }
  return receipts;
}

export interface SaleFact {
  sku: string;
  warehouse: string;
  date: string;
  qty: number;
}

/** Real daily sales per SKU/warehouse from the Sales Plan tabs' "Actual/day" columns, up to and including `today`. */
export function readSalesActuals(snap: ControlTowerSnapshot, today: string): SaleFact[] {
  const sales: SaleFact[] = [];
  for (const wh of WAREHOUSES) {
    const tab = snap[wh.salesPlan];
    for (const r of tab.rows) {
      const day = date(tab, r, "Date");
      if (!day || day > today) continue;
      for (const sku of skuCodes(snap)) {
        const qty = num(tab, r, `${sku} Actual/day`);
        if (qty === null || qty === 0) continue;
        sales.push({ sku, warehouse: wh.code, date: day, qty });
      }
    }
  }
  return sales;
}

export interface PlanFact {
  sku: string;
  warehouse: string;
  date: string;
  qty: number;
}

export function readSalesPlan(snap: ControlTowerSnapshot): PlanFact[] {
  const plan: PlanFact[] = [];
  for (const wh of WAREHOUSES) {
    const tab = snap[wh.salesPlan];
    for (const r of tab.rows) {
      const day = date(tab, r, "Date");
      if (!day) continue;
      for (const sku of skuCodes(snap)) {
        const qty = num(tab, r, `${sku} Plan/day`);
        if (qty === null) continue;
        plan.push({ sku, warehouse: wh.code, date: day, qty });
      }
    }
  }
  return plan;
}

export interface DailyCogsFact {
  openingQty: number;
  openingValue: number;
  soldQty: number;
  cogs: number;
  unpricedQty: number;
}

/** Daily COGS tab, keyed by seriesKey(sku, warehouse, date). Only dates with a non-blank Units Sold cell are included. */
export function readDailyCogsTarget(snap: ControlTowerSnapshot): Map<string, DailyCogsFact> {
  const tab = snap.dailyCogs;
  const out = new Map<string, DailyCogsFact>();
  for (const r of tab.rows) {
    const day = date(tab, r, "Date");
    if (!day) continue;
    for (const wh of WAREHOUSES) {
      for (const sku of skuCodes(snap)) {
        const p = `${wh.code} ${sku}`;
        const soldQty = num(tab, r, `${p} Units Sold`);
        if (soldQty === null) continue;
        out.set(seriesKey(sku, wh.code, day), {
          openingQty: num(tab, r, `${p} Opening Qty`) ?? 0,
          openingValue: num(tab, r, `${p} Opening Value €`) ?? 0,
          soldQty,
          cogs: num(tab, r, `${p} COGS €`) ?? 0,
          unpricedQty: num(tab, r, `${p} Unpriced Units (oversold)`) ?? 0,
        });
      }
    }
  }
  return out;
}

/** StockModel "<SKU> Stock" (start-of-day position, negative allowed), keyed by seriesKey. */
export function readStockByDay(snap: ControlTowerSnapshot): Map<string, number> {
  const out = new Map<string, number>();
  for (const wh of WAREHOUSES) {
    const { left } = splitAtBlank(snap[wh.stockModel]);
    for (const r of left.rows) {
      const day = date(left, r, "Date");
      if (!day) continue;
      for (const sku of skuCodes(snap)) {
        const stock = num(left, r, `${sku} Stock`);
        if (stock !== null) out.set(seriesKey(sku, wh.code, day), stock);
      }
    }
  }
  return out;
}

export interface SohFact {
  sku: string;
  warehouse: string;
  qty: number;
}

/** Inventory Ledger's "Current On-Hand" block (the right-hand table). */
export function readSohToday(snap: ControlTowerSnapshot): SohFact[] {
  const { right } = splitAtBlank(snap.inventoryLedger);
  return right.rows.map((r) => ({
    warehouse: cell(right, r, "Warehouse"),
    sku: cell(right, r, "SKU"),
    qty: num(right, r, "Qty On Hand") ?? 0,
  }));
}

export interface LandedCostFact {
  shipmentRef: string;
  sku: string;
  qty: number;
  landedCost: number;
}

export function readLandedCostTarget(snap: ControlTowerSnapshot): LandedCostFact[] {
  const lcs = snap.landedCostSummary;
  return lcs.rows.map((r) => ({
    shipmentRef: cell(lcs, r, "Shipment ID (Wave)"),
    sku: cell(lcs, r, "SKU"),
    qty: num(lcs, r, "Qty") ?? 0,
    landedCost: num(lcs, r, "Total Cost/unit (minus recoverable EUST/VAT)") ?? 0,
  }));
}
