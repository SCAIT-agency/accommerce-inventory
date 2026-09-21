// A typed, validated, scrubbed snapshot of the Control Tower Sheet.
//
// This is the only module that knows tab titles and header layouts. Everything
// downstream (export, targets, reconcile) reads cells by column name through
// `cell()` and never touches raw CSV. Bank-account columns are dropped here, at
// the boundary, so they cannot reach a fixture, a snapshot file, or the database.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseCsv } from "./csv";

export const TAB_NAMES = {
  skuMaster: "SKU Master",
  vendors: "Vendors",
  purchaseOrders: "Purchase Orders",
  shipments: "Shipments",
  inventoryLedger: "Inventory Ledger",
  landedCostSummary: "Landed Cost Summary",
  salesPlanFF: "Sales Plan — FF",
  salesPlanMutual: "Sales Plan — Mutual",
  stockModelFF: "StockModel — FF",
  stockModelMutual: "StockModel — Mutual",
  dailyCogs: "Daily COGS",
  transactions: "Transactions",
} as const;

export type TabKey = keyof typeof TAB_NAMES;

export interface Tab {
  header: string[];
  rows: string[][];
}

export type ControlTowerSnapshot = Record<TabKey, Tab>;

// Columns that never leave this module. `drop` removes named columns; `keep`
// removes everything else. Vendors carries contact details and bank accounts
// the platform has no use for — only the names are needed to key vendors.
const SCRUB: Partial<Record<TabKey, { drop?: string[]; keep?: string[] }>> = {
  transactions: { drop: ["Our bank/account", "Vendor bank/account"] },
  vendors: { keep: ["Vendor Name", "Type", "Product 1", "Product 2", "Product 3", "Active?"] },
};

// Headers as captured 2026-09-19 (after scrubbing). The Sheet is rebuilt by
// Apps Script; any drift is a hard failure — column changes are exactly what a
// migration must notice, not paper over.
export const EXPECTED_HEADERS: Record<TabKey, readonly string[]> = {
  skuMaster: ["SKU", "Product Name", "Bundle?", "Units per Carton", "CBM per Carton", "Kg gross per Carton", "Factory / Vendor"],
  vendors: ["Vendor Name", "Type", "Product 1", "Product 2", "Product 3", "Active?"],
  purchaseOrders: ["PO#", "Vendor", "SKU", "Planned Qty — FF", "Planned Qty — Mutual", "Planned Ready Date", "Actual Ready Date", "Qty ordered", "Qty Produced", "Qty Remaining to Produce", "Qty Remaining to Ship", "EXW/unit", "Lab-Test Amount", "Inspection Amount", "Add-on Amount", "Total PO value", "Full Factory Cost/unit", "Currency", "Order date", "Payment 1 — Amount", "Payment 1 — Planned Date", "Payment 1 — Actual Date", "Payment 1 — Days Late", "Payment 1 — Paid?", "Payment 2 — Amount", "Payment 2 — Planned Date", "Payment 2 — Actual Date", "Payment 2 — Days Late", "Payment 2 — Paid?", "Payment 3 — Amount", "Payment 3 — Planned Date", "Payment 3 — Actual Date", "Payment 3 — Days Late", "Payment 3 — Paid?", "Payments Sum Check", "Match?", "Payment Status", "Status", "Contract Link", "Invoice Link", "Add-on Link", "Standard Landed Cost/unit — FF", "Standard Landed Cost/unit — Mutual", "Actual Landed Cost/unit — FF", "Actual Landed Cost/unit — Mutual", "PPV/unit — FF", "PPV/unit — Mutual", "PPV % — FF", "PPV % — Mutual", "PPV — Freight", "PPV — Duty", "PPV — Factory", "PPV Trigger — FF", "PPV Trigger — Mutual"],
  shipments: ["Shipment ID", "PO#", "Wave#", "Ship method", "Planned Warehouse", "Actual Warehouse", "Depart Date (planned)", "Actual Depart Date", "ETA (planned)", "Projected ETA", "Effective ETA", "Actual Arrival Date", "Jello Qty", "Mixer Qty", "Straw Qty", "Payment 1 (Freight) — Amount", "Payment 1 (Freight) — Planned Date", "Payment 1 (Freight) — Actual Date", "Payment 1 (Freight) — Paid?", "Payment 2 (Freight) — Amount", "Payment 2 (Freight) — Planned Date", "Payment 2 (Freight) — Actual Date", "Payment 2 (Freight) — Paid?", "Customs — Estimated Amount", "Customs — Amount", "Customs — Planned Date", "Customs — Actual Date", "Customs — Paid?", "Customs Status", "Quote Link", "Quote Date", "Invoice Link", "Invoice Date", "Customs Invoice Link", "Customs Invoice Date", "Customs Declaration Link", "Total Qty", "Projected Shipping+Taxes Cost/unit", "Customs Declared Value/unit", "Actual — Delivery", "Actual — Admin Fees", "Actual — Duty (non-refundable)", "Implied Duty Rate", "Actual — EUST (refundable)", "Actual — VAT (refundable)", "Gross Cost/unit", "Net Cost/unit"],
  // First cell is a live TODAY()-based title in the Sheet ("CURRENT ON-HAND (as
  // of YYYY-MM-DD) Shipment ID") — normalised to "Shipment ID" in normalizeHeader.
  // The blank "" column separates the per-batch table from the Current On-Hand
  // summary block; the second "Warehouse" belongs to that block (see splitAtBlank).
  inventoryLedger: ["Shipment ID", "Warehouse", "Date Landed", "Jello Qty Received", "Jello Cumulative Received", "Jello Landed Cost/unit", "Jello Qty Remaining", "Jello Value Remaining", "Mixer Qty Received", "Mixer Cumulative Received", "Mixer Landed Cost/unit", "Mixer Qty Remaining", "Mixer Value Remaining", "Straw Qty Received", "Straw Cumulative Received", "Straw Landed Cost/unit", "Straw Qty Remaining", "Straw Value Remaining", "", "Warehouse", "SKU", "Qty On Hand", "Value On Hand", "Weighted Cost/unit", "Oversold Qty"],
  landedCostSummary: ["Shipment ID (Wave)", "Warehouse", "SKU", "Qty", "Product Cost/unit", "Logistics Cost/unit", "Total Cost/unit", "Total Cost/unit (minus recoverable EUST/VAT)"],
  salesPlanFF: ["Date", "Jello Plan/day", "Jello Actual/day", "Jello Delta/day", "Jello Cumulative Sold Before", "Mixer Plan/day", "Mixer Actual/day", "Mixer Delta/day", "Mixer Cumulative Sold Before", "Straw Plan/day", "Straw Actual/day", "Straw Delta/day", "Straw Cumulative Sold Before", "Plan Revenue €/day", "Actual Revenue €/day", "Delta Revenue €/day"],
  salesPlanMutual: ["Date", "Jello Plan/day", "Jello Actual/day", "Jello Delta/day", "Jello Cumulative Sold Before", "Mixer Plan/day", "Mixer Actual/day", "Mixer Delta/day", "Mixer Cumulative Sold Before", "Straw Plan/day", "Straw Actual/day", "Straw Delta/day", "Straw Cumulative Sold Before", "Plan Revenue €/day", "Actual Revenue €/day", "Delta Revenue €/day"],
  stockModelFF: ["Date", "Jello IN", "Jello Batch", "Jello /day", "Jello Stock", "Jello Trans d", "Jello Prod d", "Jello Stk d", "Jello Pipeline d", "Mixer IN", "Mixer Batch", "Mixer /day", "Mixer Stock", "Mixer Trans d", "Mixer Prod d", "Mixer Stk d", "Mixer Pipeline d", "Straw IN", "Straw Batch", "Straw /day", "Straw Stock", "Straw Trans d", "Straw Prod d", "Straw Stk d", "Straw Pipeline d", "Status", "", "SKU", "Actual/day", "Plan/day", "Rate Δ%"],
  stockModelMutual: ["Date", "Jello IN", "Jello Batch", "Jello /day", "Jello Stock", "Jello Trans d", "Jello Prod d", "Jello Stk d", "Jello Pipeline d", "Mixer IN", "Mixer Batch", "Mixer /day", "Mixer Stock", "Mixer Trans d", "Mixer Prod d", "Mixer Stk d", "Mixer Pipeline d", "Straw IN", "Straw Batch", "Straw /day", "Straw Stock", "Straw Trans d", "Straw Prod d", "Straw Stk d", "Straw Pipeline d", "Status", "", "SKU", "Actual/day", "Plan/day", "Rate Δ%"],
  dailyCogs: ["Date", "FF Jello Opening Qty", "FF Jello Opening Value €", "FF Jello Units Sold", "FF Jello COGS €", "FF Jello Unpriced Units (oversold)", "FF Mixer Opening Qty", "FF Mixer Opening Value €", "FF Mixer Units Sold", "FF Mixer COGS €", "FF Mixer Unpriced Units (oversold)", "FF Straw Opening Qty", "FF Straw Opening Value €", "FF Straw Units Sold", "FF Straw COGS €", "FF Straw Unpriced Units (oversold)", "FF Total Opening Value €", "FF Total COGS €", "Mutual Jello Opening Qty", "Mutual Jello Opening Value €", "Mutual Jello Units Sold", "Mutual Jello COGS €", "Mutual Jello Unpriced Units (oversold)", "Mutual Mixer Opening Qty", "Mutual Mixer Opening Value €", "Mutual Mixer Units Sold", "Mutual Mixer COGS €", "Mutual Mixer Unpriced Units (oversold)", "Mutual Straw Opening Qty", "Mutual Straw Opening Value €", "Mutual Straw Units Sold", "Mutual Straw COGS €", "Mutual Straw Unpriced Units (oversold)", "Mutual Total Opening Value €", "Mutual Total COGS €", "Grand Total Opening Value €", "Grand Total COGS €"],
  transactions: ["Transaction ID", "Due/Scheduled date", "Date paid", "Type", "Amount", "Currency", "FX rate on transaction date", "Amount (EUR)", "Counterparty", "Expense category", "Channel/warehouse", "Status", "Reconciled", "Supporting document", "Notes", "PO#/Shipment Ref"],
};

const LIVE_TITLE_PATTERN = /^CURRENT ON-HAND \(as of \d{4}-\d{2}-\d{2}\) Shipment ID$/;

function normalizeHeader(key: TabKey, header: string[]): string[] {
  if (key !== "inventoryLedger") return header;
  return header.map((h, i) => (i === 0 && LIVE_TITLE_PATTERN.test(h) ? "Shipment ID" : h));
}

function scrub(key: TabKey, header: string[], rows: string[][]): { header: string[]; rows: string[][] } {
  const rule = SCRUB[key];
  if (!rule) return { header, rows };
  const keepIdx = header
    .map((_, i) => i)
    .filter((i) => (rule.keep ? rule.keep.includes(header[i]) : !rule.drop!.includes(header[i])));
  return {
    header: keepIdx.map((i) => header[i]),
    rows: rows.map((r) => keepIdx.map((i) => r[i] ?? "")),
  };
}

function validateHeader(key: TabKey, header: string[]): void {
  const expected = EXPECTED_HEADERS[key];
  const missing = expected.filter((c) => !header.includes(c));
  const extra = header.filter((c) => !expected.includes(c));
  const sameOrder = expected.length === header.length && expected.every((c, i) => c === header[i]);
  if (!sameOrder) {
    throw new Error(
      `${TAB_NAMES[key]}: header drifted — missing [${missing.join(", ")}], extra [${extra.join(", ")}], ` +
        `expected ${expected.length} columns in a fixed order, got ${header.length}`,
    );
  }
}

// Template padding: the Sheet pre-builds hundreds of formula rows below the real
// data, and those are not blank (checkbox columns read "FALSE", derived cells
// read "0"). A row is real only if its key column is filled. Inventory Ledger
// has no single key (two tables side by side), so it keeps any non-empty row
// and splitAtBlank() filters each half.
const KEY_COLUMN: Partial<Record<TabKey, string>> = {
  skuMaster: "SKU",
  vendors: "Vendor Name",
  purchaseOrders: "PO#",
  shipments: "Shipment ID",
  landedCostSummary: "Shipment ID (Wave)",
  salesPlanFF: "Date",
  salesPlanMutual: "Date",
  stockModelFF: "Date",
  stockModelMutual: "Date",
  dailyCogs: "Date",
  transactions: "Transaction ID",
};

function isRealRow(key: TabKey, header: string[], row: string[]): boolean {
  const keyColumn = KEY_COLUMN[key];
  if (!keyColumn) return row.some((v) => v.trim() !== "");
  return (row[header.indexOf(keyColumn)] ?? "").trim() !== "";
}

export function parseTab(key: TabKey, parsed: string[][]): Tab {
  if (parsed.length === 0) throw new Error(`${TAB_NAMES[key]}: empty tab`);
  const [rawHeader, ...rawRows] = parsed;
  const { header, rows } = scrub(key, normalizeHeader(key, rawHeader), rawRows);
  validateHeader(key, header);
  return { header, rows: rows.filter((r) => isRealRow(key, header, r)) };
}

/** `fetchRows` returns the tab as header + rows of canonical cell strings (see gviz.ts canonicalCell). */
export async function buildSnapshot(fetchRows: (title: string) => Promise<string[][]>): Promise<ControlTowerSnapshot> {
  const entries = await Promise.all(
    (Object.keys(TAB_NAMES) as TabKey[]).map(async (key) => [key, parseTab(key, await fetchRows(TAB_NAMES[key]))] as const),
  );
  return Object.fromEntries(entries) as ControlTowerSnapshot;
}

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

/** Fixtures are the canonical rows captured from the live Sheet on 2026-09-19, stored as CSV. */
export async function fixtureRows(title: string): Promise<string[][]> {
  const key = (Object.keys(TAB_NAMES) as TabKey[]).find((k) => TAB_NAMES[k] === title);
  if (!key) throw new Error(`no fixture for tab "${title}"`);
  return parseCsv(await readFile(join(FIXTURES_DIR, `${key}.csv`), "utf-8"));
}

export function loadFixtureSnapshot(): Promise<ControlTowerSnapshot> {
  return buildSnapshot(fixtureRows);
}

/** Read a cell by column name. Throws on an unknown column so a typo cannot read as blank. */
export function cell(tab: Tab, row: string[], column: string): string {
  const idx = tab.header.indexOf(column);
  if (idx === -1) throw new Error(`unknown column "${column}" (have: ${tab.header.join(" | ")})`);
  return row[idx] ?? "";
}

/**
 * Some tabs place a second, unrelated table to the right of a blank "" column
 * (Inventory Ledger's Current On-Hand block; StockModel's rate side-table).
 * Returns both halves as their own tabs so `cell()` stays unambiguous —
 * e.g. "Warehouse" exists in both halves of Inventory Ledger.
 */
export function splitAtBlank(tab: Tab): { left: Tab; right: Tab } {
  const sep = tab.header.indexOf("");
  if (sep === -1) return { left: tab, right: { header: [], rows: [] } };
  const leftRows = tab.rows.map((r) => r.slice(0, sep)).filter((r) => (r[0] ?? "").trim() !== "");
  const rightRows = tab.rows.map((r) => r.slice(sep + 1)).filter((r) => (r[0] ?? "").trim() !== "");
  return {
    left: { header: tab.header.slice(0, sep), rows: leftRows },
    right: { header: tab.header.slice(sep + 1), rows: rightRows },
  };
}
