// Pure mapping: ControlTowerSnapshot → RunMigrationInput.
//
// Every rule here mirrors a documented Sheet convention (see
// docs/2026-09-19-real-data-dry-run-design.md §2). Values that the migration
// transforms would reject are passed through untouched so they land in the
// transforms' quarantine with a reason, rather than being "fixed" here. Only
// conditions the transforms cannot see (a landed line with no landed cost) are
// reported as ExportIssues.
//
// ADAPTATION (Task 7, Control Tower live-integration stream): on the source
// branch this file also grouped Container-N-<SKU> Sheet rows into one
// merged shipment/payment (and quarantined conflicting groups) before
// handing rows to migrate-from-sheet.ts. Tasks 5/6 moved that grouping INTO
// migrate-from-sheet.ts's own transformShipments/transformPayments, so this
// file no longer merges or quarantines rows itself — every function below
// emits one row per raw Sheet row (× SKU present on it), keeping each row's
// own raw "Shipment ID" and its own date/warehouse cell values untouched,
// and lets transformShipments/transformPayments do the actual pooling
// decision. Duplicating that decision here risked masking a genuine
// cross-row disagreement (e.g. differing planned dates) that
// migrate-from-sheet.ts's own, more thorough merge-conflict check would
// otherwise catch — exactly the class of bug this stream's earlier tasks
// spent several rounds fixing when only one copy of this logic existed.
//
// The one thing this file still needs cross-row awareness for is computing
// each row's fractional freight/duty SHARE and the group's cost TOTAL: the
// schema puts freight/dutyCost on the shipment as a single value and
// weight/valueShare on each line, so a pooled container's per-row invoice
// split can only be expressed as (identical total on every row, each row's
// own fraction of it) — migrate-from-sheet.ts trusts these fields verbatim,
// it does not recompute them. That's a cost-allocation computation, not a
// merge/quarantine decision, so it stays here.

import { normalizeBool, normalizeDate, normalizeNumber } from "./csv";
import { cell, type ControlTowerSnapshot } from "./snapshot";
import { num, readLandedCostTarget, readSalesActuals, readSalesPlan, readSohToday, skuCodes } from "./targets";
import type {
  LandedCostTotal,
  PaymentSheetRow,
  PoSheetRow,
  SalesRowSheet,
  SheetExportRow,
  ShipmentSheetRow,
  SkuWarehouseTotal,
  TransactionSheetRow,
} from "../migrate-from-sheet";

export interface ExportIssue {
  entity: "shipment" | "receipt";
  key: string;
  reason: string;
}

// --- Purchase orders & payments ---------------------------------------------

export const PO_STATUS_MAP: Record<string, PoSheetRow["status"]> = {
  Draft: "draft",
  Placed: "confirmed",
  "In Production": "in_production",
  "Partially Shipped": "shipped",
  Closed: "closed",
};

function mapPoStatus(raw: string): string {
  // Unknown values pass through so transformPurchaseOrders quarantines them
  // with the original text in the reason.
  return PO_STATUS_MAP[raw] ?? raw;
}

const safeNumber = (raw: string): string => {
  try {
    return normalizeNumber(raw) ?? "";
  } catch {
    return raw; // let the transform's strict pattern quarantine it with the raw text
  }
};

export function exportPurchaseOrders(snap: ControlTowerSnapshot): PoSheetRow[] {
  const tab = snap.purchaseOrders;
  return tab.rows.map((r) => ({
    po_number: cell(tab, r, "PO#"),
    vendor_name: cell(tab, r, "Vendor"),
    vendor_reference: cell(tab, r, "Contract Link"),
    status: mapPoStatus(cell(tab, r, "Status")),
    sku: cell(tab, r, "SKU"),
    qty: safeNumber(cell(tab, r, "Qty ordered")),
    unit_price: safeNumber(cell(tab, r, "Full Factory Cost/unit")),
    currency: cell(tab, r, "Currency"),
  }));
}

export const PAYMENT_SLOTS = [1, 2, 3] as const;

/**
 * A Sheet PO row is one PO×SKU, and each row carries its own three payment
 * slots. The platform groups rows sharing a PO# into one purchase order, so
 * slot numbers are re-issued as a running sequence per PO# in row order —
 * "Procware Heritage" (Jello/Mixer/Straw rows, one Payment 1 each) becomes
 * sequence 1, 2, 3 instead of three slot-1 payments on one PO. Single-row POs
 * keep their slot numbers unchanged. Purchase orders never pool across rows
 * (only shipments do), so this re-sequencing is unrelated to the
 * Container-N grouping described above and needs no adaptation.
 */
export function exportPayments(snap: ControlTowerSnapshot): PaymentSheetRow[] {
  const tab = snap.purchaseOrders;
  const rows: PaymentSheetRow[] = [];
  const nextSequence = new Map<string, number>();
  for (const r of tab.rows) {
    const po = cell(tab, r, "PO#");
    for (const n of PAYMENT_SLOTS) {
      const amount = safeNumber(cell(tab, r, `Payment ${n} — Amount`));
      if (amount === "") continue;
      const sequence = (nextSequence.get(po) ?? 0) + 1;
      nextSequence.set(po, sequence);
      rows.push({
        po_number: po,
        sequence_no: String(sequence),
        expected_amount: amount,
        expected_date: cell(tab, r, `Payment ${n} — Planned Date`),
        currency: cell(tab, r, "Currency"),
        paid: normalizeBool(cell(tab, r, `Payment ${n} — Paid?`)) ? "TRUE" : "FALSE",
        paid_date: cell(tab, r, `Payment ${n} — Actual Date`),
      });
    }
  }
  return rows;
}

/**
 * Shipment-level payment slots (two freight instalments + customs) live on the
 * Shipments tab, one row per shipment×SKU. They become `payments` rows owned
 * by the shipment (payments.shipmentId).
 *
 * Emitted RAW: one row per (Sheet row × filled slot), with the row's own
 * un-collapsed Shipment ID and its own (un-summed) amount — no merging
 * across a pooled container's rows. Sequence numbers ARE assigned per
 * pooled-container group (not per individual row) so every row contributing
 * to the SAME physical invoice carries the SAME sequence_no — that's what
 * lets migrate-from-sheet.ts's transformPayments recognise and sum them as
 * one genuinely pooled slot; it is a numbering convention, not a merge
 * decision (no row is combined, dropped, or quarantined here).
 */
export const SHIPMENT_PAYMENT_SLOTS = [
  { amount: "Payment 1 (Freight) — Amount", planned: "Payment 1 (Freight) — Planned Date", actual: "Payment 1 (Freight) — Actual Date", paid: "Payment 1 (Freight) — Paid?" },
  { amount: "Payment 2 (Freight) — Amount", planned: "Payment 2 (Freight) — Planned Date", actual: "Payment 2 (Freight) — Actual Date", paid: "Payment 2 (Freight) — Paid?" },
  { amount: "Customs — Amount", planned: "Customs — Planned Date", actual: "Customs — Actual Date", paid: "Customs — Paid?" },
] as const;

export function exportShipmentPayments(snap: ControlTowerSnapshot): PaymentSheetRow[] {
  const tab = snap.shipments;
  const skus = skuCodes(snap);
  const rows: PaymentSheetRow[] = [];
  const groups = new Map<string, string[][]>();
  for (const r of tab.rows) {
    const ref = platformShipmentRef(cell(tab, r, "Shipment ID"), presentSkusOnRow(tab, r, skus));
    groups.set(ref, [...(groups.get(ref) ?? []), r]);
  }
  for (const group of groups.values()) {
    let sequence = 0;
    for (const slot of SHIPMENT_PAYMENT_SLOTS) {
      const present = group.some((r) => {
        const a = num(tab, r, slot.amount);
        return a !== null && a !== 0;
      });
      if (!present) continue;
      sequence++;
      for (const r of group) {
        const amount = num(tab, r, slot.amount);
        if (amount === null || amount === 0) continue;
        rows.push({
          po_number: "",
          shipment_ref: cell(tab, r, "Shipment ID"), // raw — not collapsed to the pooled owner ref
          sequence_no: String(sequence),
          expected_amount: String(amount),
          expected_date: cell(tab, r, slot.planned),
          currency: "EUR",
          paid: normalizeBool(cell(tab, r, slot.paid)) ? "TRUE" : "FALSE",
          paid_date: cell(tab, r, slot.actual),
        });
      }
    }
  }
  return rows;
}

// --- Pooled containers ----------------------------------------------------------

/**
 * CONVENTION (Artem, 2026-09-19): the Sheet names the lines of one physical
 * container "<prefix>Container<N>-<SKU>" (PO1-Wave4-Container2-Jello/-Mixer/
 * -Straw) and keeps one row per SKU, but pays that container's freight and
 * customs with single transfers. The platform models it as ONE shipment with
 * N lines — migrate-from-sheet.ts's transformShipments/transformPayments
 * merge those rows under the common prefix. Rows whose IDs do not follow
 * this pattern (e.g. PO1-Wave1-Jello/-Mixer/-Straw — three separate air
 * waybills) stay separate.
 *
 * Kept here (not just in migrate-from-sheet.ts) because this file still
 * needs it to compute a pooled container's freight/duty split (see the
 * module comment above) and because reconcile.ts needs it to resolve the
 * Landed Cost Summary's raw per-SKU ref to the platform's actual migrated
 * (pooled) shipment ref for R4.
 */
export const POOLED_SHIPMENT_PATTERN = /^(.*Container\d+)-(.+)$/;

/**
 * `presentSkus` must be the SKU(s) actually present on the row the ref came
 * from (a non-null, non-zero `<SKU> Qty` cell for a raw Shipments row, or the
 * row's own `sku` for an already-SKU-scoped row like a Landed Cost Summary
 * line) — NOT the full SKU catalog. migrate-from-sheet.ts's own
 * platformShipmentRef checks the suffix against one row's own `sku`; this is
 * the equivalent check for a raw (pre-SKU-split) row that can carry several
 * SKUs' qty columns at once. Passing the full catalog here would treat a ref
 * like "...Container5-Straw" as pooled merely because "Straw" is a valid SKU
 * somewhere, even when this particular row's own qty column is for a
 * different SKU — silently pooling rows that don't belong together and
 * mis-attributing freight/duty cost (see the R4 landed-cost regression this
 * function's divergence from migrate-from-sheet.ts caused, 2026-09-21).
 */
export function platformShipmentRef(sheetRef: string, presentSkus: readonly string[]): string {
  const m = POOLED_SHIPMENT_PATTERN.exec(sheetRef);
  return m && presentSkus.includes(m[2]) ? m[1] : sheetRef;
}

/** SKUs with a non-null, non-zero `<SKU> Qty` cell on this specific raw Shipments row — see platformShipmentRef above. */
function presentSkusOnRow(tab: ControlTowerSnapshot["shipments"], r: string[], skus: readonly string[]): string[] {
  return skus.filter((sku) => {
    const qty = num(tab, r, `${sku} Qty`);
    return qty !== null && qty !== 0;
  });
}

// --- Shipments ----------------------------------------------------------------

export const CUSTOMS_STATUS_MAP: Record<string, string> = {
  Cleared: "cleared",
  Held: "held",
  "In clearance": "declared",
  "Not started": "not_declared",
  "": "not_declared",
};

export function shipmentStatusFromDates(actualArrival: string | null, actualDepart: string | null): ShipmentSheetRow["status"] {
  if (actualArrival) return "delivered";
  if (actualDepart) return "in_transit";
  return "planned";
}

interface ShipmentLine {
  sku: string;
  qty: number;
  kgPerUnit: number;
  unitPrice: number;
}

/**
 * Pooled-container allocation shares. A single-line shipment gets 1/1. A
 * multi-line one splits freight by gross weight (SKU Master carton kg ÷ units
 * per carton) and duty by value (PO line price × qty), both normalised to sum
 * to 1 and printed at 8 dp — the shipment_line_items columns are
 * decimal(9,8) (always a 0-1 fraction, so 1 integer digit is enough headroom).
 */
export function computeShares(lines: ShipmentLine[]): { weightShare: string; valueShare: string }[] {
  if (lines.length === 1) return [{ weightShare: "1", valueShare: "1" }];
  const weights = lines.map((l) => l.kgPerUnit * l.qty);
  const values = lines.map((l) => l.unitPrice * l.qty);
  const wTotal = weights.reduce((a, b) => a + b, 0);
  const vTotal = values.reduce((a, b) => a + b, 0);
  return lines.map((_, i) => ({
    weightShare: (wTotal > 0 ? weights[i] / wTotal : 1 / lines.length).toFixed(8),
    valueShare: (vTotal > 0 ? values[i] / vTotal : 1 / lines.length).toFixed(8),
  }));
}

function kgPerUnitBySku(snap: ControlTowerSnapshot): Map<string, number> {
  const tab = snap.skuMaster;
  return new Map(
    tab.rows.map((r) => {
      const kg = num(tab, r, "Kg gross per Carton") ?? 0;
      const units = num(tab, r, "Units per Carton") ?? 0;
      return [cell(tab, r, "SKU"), units > 0 ? kg / units : 0];
    }),
  );
}

function unitPriceByPoLine(snap: ControlTowerSnapshot): Map<string, number> {
  const tab = snap.purchaseOrders;
  return new Map(tab.rows.map((r) => [`${cell(tab, r, "PO#")}::${cell(tab, r, "SKU")}`, num(tab, r, "Full Factory Cost/unit") ?? 0]));
}

const sumOrBlank = (parts: (number | null)[]): string => {
  const present = parts.filter((p): p is number => p !== null);
  return present.length === 0 ? "" : present.reduce((a, b) => a + b, 0).toFixed(2);
};

/** Shares derived from the Sheet's per-row freight/duty split of a pooled container; null when not applicable. */
export function sheetSplitShares(lines: { freight: number | null; duty: number | null }[]): { weightShare: string; valueShare: string }[] | null {
  if (lines.length < 2) return null;
  if (lines.some((l) => l.freight === null || l.duty === null)) return null;
  const freightTotal = lines.reduce((a, l) => a + l.freight!, 0);
  const dutyTotal = lines.reduce((a, l) => a + l.duty!, 0);
  if (freightTotal <= 0 || dutyTotal <= 0) return null;
  return lines.map((l) => ({ weightShare: (l.freight! / freightTotal).toFixed(8), valueShare: (l.duty! / dutyTotal).toFixed(8) }));
}

/**
 * One row per (Sheet row × SKU present on it), keeping every row's own raw
 * Shipment ID and its own date/warehouse/status — no cross-row merge and no
 * "conflicting merge" quarantine here (see module comment: that decision now
 * belongs entirely to migrate-from-sheet.ts's transformShipments). Rows are
 * grouped internally ONLY to compute each row's fractional weight/value
 * share and the group's freight/duty total, mirroring the Sheet's own
 * per-row invoice split so every emitted row already carries the values
 * transformShipments will trust verbatim once it re-groups them by the same
 * pooled-container convention.
 */
export function exportShipments(snap: ControlTowerSnapshot): { rows: ShipmentSheetRow[]; issues: ExportIssue[] } {
  const tab = snap.shipments;
  const kgPerUnit = kgPerUnitBySku(snap);
  const unitPrice = unitPriceByPoLine(snap);
  const skus = skuCodes(snap);
  const issues: ExportIssue[] = [];

  const shareGroups = new Map<string, string[][]>();
  for (const r of tab.rows) {
    const ref = platformShipmentRef(cell(tab, r, "Shipment ID"), presentSkusOnRow(tab, r, skus));
    shareGroups.set(ref, [...(shareGroups.get(ref) ?? []), r]);
  }

  const rows: ShipmentSheetRow[] = [];
  for (const group of shareGroups.values()) {
    const lines: (ShipmentLine & { row: string[]; po: string; freight: number | null; duty: number | null })[] = [];
    for (const r of group) {
      const po = cell(tab, r, "PO#");
      const rowFreight = sumFreight(tab, r);
      const rowDuty = num(tab, r, "Actual — Duty (non-refundable)");
      for (const sku of skus) {
        const qty = num(tab, r, `${sku} Qty`);
        if (qty === null || qty === 0) continue;
        lines.push({ sku, qty, kgPerUnit: kgPerUnit.get(sku) ?? 0, unitPrice: unitPrice.get(`${po}::${sku}`) ?? 0, po, freight: rowFreight, duty: rowDuty, row: r });
      }
    }
    // A pooled container's rows already carry the Sheet's own split of the
    // container invoices; encoding that split as the shares reproduces each
    // line's landed cost exactly. Otherwise (one line, or no costs yet) fall
    // back to weight/value shares.
    const shares = sheetSplitShares(lines) ?? computeShares(lines);

    // Cost inputs are the real invoice actuals, summed across the group's rows
    // (each Sheet row carries its own SKU's share of the shipment's invoices)
    // — this total is written identically onto every row in the group, since
    // migrate-from-sheet.ts's transformShipments takes only the first row's
    // freight_cost/duty_cost as the whole shipment's value.
    const freight = sumOrBlank(group.map((r) => sumFreight(tab, r)));
    const duty = sumOrBlank(group.map((r) => num(tab, r, "Actual — Duty (non-refundable)")));

    lines.forEach((line, i) => {
      const r = line.row;
      const actualArrival = cell(tab, r, "Actual Arrival Date");
      const actualDepart = cell(tab, r, "Actual Depart Date");
      const customs = cell(tab, r, "Customs Status");
      rows.push({
        shipment_ref: cell(tab, r, "Shipment ID"), // raw — not collapsed to the pooled owner ref
        vendor_reference: "",
        status: shipmentStatusFromDates(normalizeDate(actualArrival), normalizeDate(actualDepart)),
        warehouse: cell(tab, r, "Actual Warehouse") || cell(tab, r, "Planned Warehouse"),
        freight_cost: freight,
        duty_cost: duty,
        cost_currency: "EUR",
        po_line_item_ref: `${line.po}::${line.sku}`,
        sku: line.sku,
        qty: String(line.qty),
        weight_share: shares[i].weightShare,
        value_share: shares[i].valueShare,
        planned_depart_date: cell(tab, r, "Depart Date (planned)"),
        actual_depart_date: actualDepart,
        planned_arrival_date: cell(tab, r, "Effective ETA"),
        actual_arrival_date: actualArrival,
        customs_status: CUSTOMS_STATUS_MAP[customs] ?? customs,
      });
    });
  }
  return { rows, issues };
}

function sumFreight(tab: ControlTowerSnapshot["shipments"], r: string[]): number | null {
  const delivery = num(tab, r, "Actual — Delivery");
  const admin = num(tab, r, "Actual — Admin Fees");
  if (delivery === null && admin === null) return null;
  return (delivery ?? 0) + (admin ?? 0);
}

// --- Ledger receipts & landed-cost targets ------------------------------------

/**
 * One receipt per landed shipment line, at the Sheet's own landed unit cost
 * (Landed Cost Summary, net of recoverable EUST/VAT). Taking the cost from the
 * Sheet keeps the COGS comparison about FIFO logic only; the landed-cost
 * formula is checked separately through exportLandedCostTotals.
 *
 * source_ref is the platform (pooled) shipment ref, not the raw per-SKU one:
 * unlike exportShipments'/exportShipmentPayments' migration-input rows, this
 * is an informational audit-trail field on the ledger event, not something
 * migrate-from-sheet.ts re-groups — it should point at the same shipment
 * identity R4's landed-cost reconciliation resolves to.
 */
export function exportLedgerReceipts(snap: ControlTowerSnapshot): { rows: SheetExportRow[]; issues: ExportIssue[] } {
  const costByLine = new Map(readLandedCostTarget(snap).map((t) => [`${t.shipmentRef}::${t.sku}`, t.landedCost]));
  const tab = snap.shipments;
  const skus = skuCodes(snap);
  const rows: SheetExportRow[] = [];
  const issues: ExportIssue[] = [];
  for (const r of tab.rows) {
    const landed = normalizeDate(cell(tab, r, "Actual Arrival Date"));
    if (!landed) continue;
    const ref = cell(tab, r, "Shipment ID");
    const platformRef = platformShipmentRef(ref, presentSkusOnRow(tab, r, skus));
    for (const sku of skus) {
      const qty = num(tab, r, `${sku} Qty`);
      if (qty === null || qty === 0) continue;
      const cost = costByLine.get(`${ref}::${sku}`);
      if (cost === undefined) {
        issues.push({ entity: "receipt", key: `${ref}::${sku}`, reason: "landed line has no Landed Cost Summary row" });
        continue;
      }
      rows.push({
        sku,
        warehouse: cell(tab, r, "Actual Warehouse"),
        event_type: "receipt",
        qty: String(qty),
        unit_cost: String(cost),
        date: landed,
        source_ref: platformRef,
      });
    }
  }
  return { rows, issues };
}

export function exportLandedCostTotals(snap: ControlTowerSnapshot): LandedCostTotal[] {
  // Each Landed Cost Summary row is already scoped to one SKU (t.sku), so the
  // presence check is exact — same as migrate-from-sheet.ts's own per-row check.
  return readLandedCostTarget(snap).map((t) => ({ shipmentRef: platformShipmentRef(t.shipmentRef, [t.sku]), sku: t.sku, landedCostFromSheet: t.landedCost }));
}

// --- Sales, plan, transactions, totals -----------------------------------------

export function exportSalesActuals(snap: ControlTowerSnapshot, today: string): SalesRowSheet[] {
  return readSalesActuals(snap, today).map((s) => ({ sku: s.sku, warehouse: s.warehouse, date: s.date, qty: String(s.qty) }));
}

/**
 * CONVENTION: the Sheet's Plan/day is a weekly plan ÷ 7 (fractional, e.g.
 * 1760.714285); sales_plan.plannedQty is an integer. Rounded to the nearest
 * unit here — a per-day error of at most 0.5 units, never accumulated.
 * Reported in every dry-run under "Conventions applied".
 */
export function exportSalesPlan(snap: ControlTowerSnapshot): SalesRowSheet[] {
  return readSalesPlan(snap).map((p) => ({ sku: p.sku, warehouse: p.warehouse, date: p.date, qty: String(Math.round(p.qty)) }));
}

export const EXPORT_CONVENTIONS: readonly string[] = [
  "PO line unit price = the Sheet's Full Factory Cost/unit (EXW + lab-test/inspection/add-on per unit), the basis of the Sheet's own landed cost.",
  "Payment slots are re-issued as one running sequence per PO# (a PO spanning several SKU rows keeps every row's payments).",
  "Shipment-level freight/customs slots become payments owned by the shipment, one running sequence per Shipment ID.",
  "Rows named <prefix>Container<N>-<SKU> are the lines of one physical container and merge into one pooled shipment (migrate-from-sheet.ts); its freight/duty shares are the Sheet's own per-row split, its payment slots are the rows' slots summed.",
  "A Sheet transaction link transfers at 1% amount tolerance, or at 5% when the amount differs by FX drift or a partial payment; the platform records the amount actually paid separately from the planned amount.",
  "A payment the Sheet marks unpaid but links a transaction to is recorded as paid on the transaction's date and amount — the link is the Sheet's own statement that it was paid.",
  "Sales plan (Plan/day, a weekly plan ÷ 7) is rounded to whole units because sales_plan.plannedQty is an integer.",
  "Shipment status is derived from dates (arrival → delivered, departure → in_transit, else planned); freight = Actual Delivery + Admin Fees, duty = Actual Duty (non-refundable), both EUR.",
  "Ledger receipts carry the Sheet's own net landed cost (Landed Cost Summary, minus recoverable EUST/VAT) so the COGS check isolates FIFO logic; the landed-cost formula is checked separately (R4).",
];

export function exportTransactions(snap: ControlTowerSnapshot): TransactionSheetRow[] {
  const tab = snap.transactions;
  return tab.rows.map((r) => {
    const amountRaw = safeNumber(cell(tab, r, "Amount"));
    const currency = cell(tab, r, "Currency");
    const amountEur = num(tab, r, "Amount (EUR)");
    const amount = parseFloat(amountRaw);
    const fxRate =
      currency === "EUR" ? "1" : amountEur !== null && Number.isFinite(amount) && amount !== 0 ? (amountEur / amount).toFixed(6) : "";
    const notes = cell(tab, r, "Notes") || cell(tab, r, "Supporting document");
    return {
      date: cell(tab, r, "Date paid"),
      amount: amountRaw,
      currency,
      fx_rate: fxRate,
      counterparty: cell(tab, r, "Counterparty"),
      description: [cell(tab, r, "Expense category"), notes].filter(Boolean).join(" — "),
      // Carried raw, untouched: a multi-line pooled-container ref (e.g. a
      // comma-separated list of Container-N-<SKU> lines) is resolved to its
      // platform owner by reconcile-migration.ts's own runMigration, as a
      // fallback only when the raw ref doesn't already resolve on its own —
      // duplicating that normalization here risked disagreeing with the
      // actual ground truth runMigration uses (shipmentIdByRef/
      // paymentsByOwner), which only exists at migration time.
      matched_ref: cell(tab, r, "PO#/Shipment Ref").trim(),
    };
  });
}

export function exportSheetTotals(snap: ControlTowerSnapshot): SkuWarehouseTotal[] {
  return readSohToday(snap).map((s) => ({ sku: s.sku, warehouseCode: s.warehouse, sohFromSheet: s.qty }));
}

export interface MigrationExport {
  input: {
    ledgerRows: SheetExportRow[];
    poRows: PoSheetRow[];
    shipmentRows: ShipmentSheetRow[];
    paymentRows: PaymentSheetRow[];
    transactionRows: TransactionSheetRow[];
    salesActualRows: SalesRowSheet[];
    salesPlanRows: SalesRowSheet[];
    sheetTotals: SkuWarehouseTotal[];
    landedCostTotals: LandedCostTotal[];
  };
  issues: ExportIssue[];
}

export function buildMigrationInput(snap: ControlTowerSnapshot, today: string): MigrationExport {
  const shipments = exportShipments(snap);
  const receipts = exportLedgerReceipts(snap);
  return {
    input: {
      ledgerRows: receipts.rows,
      poRows: exportPurchaseOrders(snap),
      shipmentRows: shipments.rows,
      paymentRows: [...exportPayments(snap), ...exportShipmentPayments(snap)],
      transactionRows: exportTransactions(snap),
      salesActualRows: exportSalesActuals(snap, today),
      salesPlanRows: exportSalesPlan(snap),
      sheetTotals: exportSheetTotals(snap),
      landedCostTotals: exportLandedCostTotals(snap),
    },
    issues: [...shipments.issues, ...receipts.issues],
  };
}
