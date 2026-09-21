import { LEDGER_EVENT_TYPES, CUSTOMS_STATUSES } from "../drizzle/schema";

export interface SheetExportRow {
  sku: string;
  warehouse: string;
  event_type: string;
  qty: string;
  unit_cost: string;
  date: string;
  source_ref: string;
}

export interface TransformedLedgerEvent {
  sku: string;
  warehouseCode: string;
  eventType: "receipt" | "sale" | "adjustment";
  qty: number;
  unitCost: number;
  date: Date;
  sourceRef: string;
}

export interface TransformedMigrationData {
  ledgerEvents: TransformedLedgerEvent[];
  skipped: SkippedRow[];
}

export function transformSheetExport(rows: SheetExportRow[]): TransformedMigrationData {
  const skipped: SkippedRow[] = [];
  const ledgerEvents: TransformedLedgerEvent[] = [];

  rows.forEach((r, rowIndex) => {
    if (!(LEDGER_EVENT_TYPES as readonly string[]).includes(r.event_type)) {
      skipped.push({ rowIndex, reason: `unrecognized event_type "${r.event_type}"` });
      return;
    }
    if (!DECIMAL_PATTERN.test(r.qty)) {
      skipped.push({ rowIndex, reason: `unparseable qty "${r.qty}"` });
      return;
    }
    const qty = parseFloat(r.qty);
    if (Number.isNaN(qty)) {
      skipped.push({ rowIndex, reason: `unparseable qty "${r.qty}"` });
      return;
    }
    // unit_cost is only meaningful for receipts (sale/adjustment rows commonly
    // leave it blank, matching runMigration's own eventType === "receipt" check
    // before persisting it) — blank is not garbage, but anything present must
    // still pass the strict pattern.
    if (r.unit_cost !== "" && !DECIMAL_PATTERN.test(r.unit_cost)) {
      skipped.push({ rowIndex, reason: `unparseable unit_cost "${r.unit_cost}"` });
      return;
    }
    const unitCost = r.unit_cost === "" ? 0 : parseFloat(r.unit_cost);
    if (Number.isNaN(unitCost)) {
      skipped.push({ rowIndex, reason: `unparseable unit_cost "${r.unit_cost}"` });
      return;
    }
    const parsedDate = new Date(r.date);
    if (Number.isNaN(parsedDate.getTime())) {
      skipped.push({ rowIndex, reason: `unparseable date "${r.date}"` });
      return;
    }
    // A migrated "sale" row represents a whole calendar day's aggregate in
    // the historical Sheet, exactly like recordSalesActual's own live-code
    // convention — anchor it at end-of-day so it sorts after any same-day
    // receipt with a real timestamp, matching how the negative-stock guard
    // already treats live-recorded sales. Receipts/adjustments keep their
    // given timestamp as-is (migrated historical data has no more precise
    // information to anchor them by anyway).
    const date = r.event_type === "sale"
      ? new Date(`${parsedDate.toISOString().slice(0, 10)}T23:59:59.999Z`)
      : parsedDate;

    ledgerEvents.push({
      sku: r.sku,
      warehouseCode: r.warehouse,
      eventType: r.event_type as "receipt" | "sale" | "adjustment",
      qty,
      unitCost,
      date,
      sourceRef: r.source_ref,
    });
  });

  return { ledgerEvents, skipped };
}

export interface SkuWarehouseTotal {
  sku: string;
  warehouseCode: string;
  sohFromSheet: number;
}

export interface ReconciliationDeps {
  // null means "this SKU/warehouse pair doesn't exist in Control Tower at
  // all" — distinct from a real SOH of 0, which a sheet row can legitimately
  // also expect. Collapsing both to the number 0 would let a genuinely
  // missing SKU/warehouse silently "match" a sheet row that also expects 0.
  getMigratedSoh: (sku: string, warehouseCode: string) => Promise<number | null>;
}

export interface Mismatch {
  sku: string;
  warehouseCode: string;
  expected: number;
  actual: number | null;
  diff: number | null;
  kind: "soh" | "landed_cost";
}

export interface LandedCostTotal {
  sku: string;
  warehouseCode: string;
  landedCostFromSheet: number;
}

export interface LandedCostReconciliationDeps {
  getMigratedLandedCost: (sku: string, warehouseCode: string) => Promise<number>;
}

const LANDED_COST_TOLERANCE_MIN = 0.01;
const LANDED_COST_TOLERANCE_PCT = 0.001;

function withinLandedCostTolerance(expected: number, actual: number): boolean {
  const tolerance = Math.max(LANDED_COST_TOLERANCE_MIN, Math.abs(expected) * LANDED_COST_TOLERANCE_PCT);
  return Math.abs(expected - actual) <= tolerance;
}

export async function reconcileMigration(
  sheetTotals: SkuWarehouseTotal[],
  deps: ReconciliationDeps,
  landedCostTotals: LandedCostTotal[] = [],
  landedCostDeps?: LandedCostReconciliationDeps,
): Promise<{ passed: boolean; mismatches: Mismatch[] }> {
  const mismatches: Mismatch[] = [];
  for (const total of sheetTotals) {
    const actual = await deps.getMigratedSoh(total.sku, total.warehouseCode);
    // A missing SKU/warehouse pair (null) is always a mismatch, regardless of
    // what the sheet expects — including when the sheet also expects 0,
    // which a bare number comparison would have let through as a false match.
    if (actual === null || actual !== total.sohFromSheet) {
      mismatches.push({
        sku: total.sku,
        warehouseCode: total.warehouseCode,
        expected: total.sohFromSheet,
        actual,
        diff: actual === null ? null : actual - total.sohFromSheet,
        kind: "soh",
      });
    }
  }

  if (landedCostDeps) {
    for (const total of landedCostTotals) {
      const actual = await landedCostDeps.getMigratedLandedCost(total.sku, total.warehouseCode);
      if (!withinLandedCostTolerance(total.landedCostFromSheet, actual)) {
        mismatches.push({
          sku: total.sku,
          warehouseCode: total.warehouseCode,
          expected: total.landedCostFromSheet,
          actual,
          diff: actual - total.landedCostFromSheet,
          kind: "landed_cost",
        });
      }
    }
  }

  return { passed: mismatches.length === 0, mismatches };
}

export interface SkippedRow {
  rowIndex: number;
  reason: string;
}

// Strict numeric patterns: parseInt/parseFloat accept leading-numeric garbage
// (e.g. parseFloat("200000xyz") === 200000), so every numeric field parsed
// from a Sheet row must match one of these before parsing, not just pass a
// post-hoc Number.isNaN check.
const INTEGER_PATTERN = /^-?\d+$/;
const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;

// --- Purchase Orders ---

export interface PoSheetRow {
  po_number: string;
  vendor_name: string;
  vendor_reference: string;
  status: string;
  sku: string;
  qty: string;
  unit_price: string;
  currency: string;
}

export interface TransformedPo {
  poNumber: string;
  vendorName: string;
  vendorReference: string | null;
  initialStatus: "draft" | "confirmed" | "in_production" | "shipped" | "customs" | "delivered" | "closed";
  lineItems: { sku: string; qty: number; unitPrice: string; currency: string }[];
}

const VALID_PO_STATUSES = ["draft", "confirmed", "in_production", "shipped", "customs", "delivered", "closed"];

export function transformPurchaseOrders(rows: PoSheetRow[]): { purchaseOrders: TransformedPo[]; skipped: SkippedRow[] } {
  const skipped: SkippedRow[] = [];
  const byPoNumber = new Map<string, TransformedPo>();

  rows.forEach((row, rowIndex) => {
    if (!row.po_number) {
      skipped.push({ rowIndex, reason: "missing po_number" });
      return;
    }
    if (!VALID_PO_STATUSES.includes(row.status)) {
      skipped.push({ rowIndex, reason: `unrecognized status "${row.status}"` });
      return;
    }
    if (!INTEGER_PATTERN.test(row.qty)) {
      skipped.push({ rowIndex, reason: `unparseable qty "${row.qty}"` });
      return;
    }
    const qty = parseInt(row.qty, 10);
    if (Number.isNaN(qty)) {
      skipped.push({ rowIndex, reason: `unparseable qty "${row.qty}"` });
      return;
    }

    const lineItem = { sku: row.sku, qty, unitPrice: row.unit_price, currency: row.currency };
    const existing = byPoNumber.get(row.po_number);
    if (existing) {
      existing.lineItems.push(lineItem);
    } else {
      byPoNumber.set(row.po_number, {
        poNumber: row.po_number,
        vendorName: row.vendor_name,
        vendorReference: row.vendor_reference || null,
        initialStatus: row.status as TransformedPo["initialStatus"],
        lineItems: [lineItem],
      });
    }
  });

  return { purchaseOrders: Array.from(byPoNumber.values()), skipped };
}

// --- Shipments ---

export interface ShipmentSheetRow {
  shipment_ref: string;
  vendor_reference: string;
  status: string;
  warehouse: string;
  freight_cost: string;
  duty_cost: string;
  cost_currency: string;
  po_line_item_ref: string;
  sku: string;
  qty: string;
  weight_share: string;
  value_share: string;
  // Optional shipment history carried from the Sheet (YYYY-MM-DD or blank).
  // Migration writes these directly — it records history, it does not replay
  // the state machine (same reasoning as `status` above).
  planned_depart_date?: string;
  actual_depart_date?: string;
  planned_arrival_date?: string;
  actual_arrival_date?: string;
  customs_status?: string;
}

export type CustomsStatus = (typeof CUSTOMS_STATUSES)[number];

export interface TransformedShipment {
  shipmentRef: string;
  vendorReference: string | null;
  initialStatus: "planned" | "departed" | "in_transit" | "customs" | "delivered";
  warehouseCode: string;
  freightCost: string | null;
  dutyCost: string | null;
  costCurrency: string | null;
  plannedDepartDate: Date | null;
  actualDepartDate: Date | null;
  plannedArrivalDate: Date | null;
  actualArrivalDate: Date | null;
  customsStatus: CustomsStatus | null;
  lineItems: { poLineItemRef: string; sku: string; qty: number; weightShare: string; valueShare: string }[];
}

const VALID_SHIPMENT_STATUSES = ["planned", "departed", "in_transit", "customs", "delivered"];

function optionalDate(raw: string | undefined): Date | null | "invalid" {
  if (raw === undefined || raw === "") return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? "invalid" : d;
}

// CONVENTION (decided against the live Sheet, 2026-09-19): the Sheet names
// the per-SKU lines of one physical container "<prefix>Container<N>-<SKU>"
// (e.g. PO1-Wave4-Container2-Jello/-Mixer/-Straw) — one row per SKU, but one
// freight/customs invoice for the whole container. These rows merge into ONE
// platform shipment with N lines under the shared "<prefix>Container<N>"
// ref. A row whose ref matches the pattern but whose suffix isn't that row's
// own `sku` is left alone (not a pooled row — merges only on an exact
// shipment_ref match, same as any other multi-line shipment).
const POOLED_SHIPMENT_PATTERN = /^(.*Container\d+)-(.+)$/;

function platformShipmentRef(row: Pick<ShipmentSheetRow, "shipment_ref" | "sku">): string {
  const m = POOLED_SHIPMENT_PATTERN.exec(row.shipment_ref);
  return m && m[2] === row.sku ? m[1] : row.shipment_ref;
}

// Rows merging under one ref (pooled-container or a plain repeated
// shipment_ref, e.g. "Mutual-PO2-Delivered" appearing once per SKU) must
// agree on everything shipment-level, not just line-item fields — otherwise
// the merge would silently pick one row's dates/warehouse over another's.
const SHIPMENT_MERGE_KEYS = ["warehouse", "planned_depart_date", "actual_depart_date", "planned_arrival_date", "actual_arrival_date"] as const;

function findShipmentMergeConflict(rows: ShipmentSheetRow[]): string | null {
  const [first, ...rest] = rows;
  for (const row of rest) {
    for (const key of SHIPMENT_MERGE_KEYS) {
      const a = first[key] ?? "";
      const b = row[key] ?? "";
      if (a !== b) {
        return `disagree on ${key} ("${a}" vs "${b}")`;
      }
    }
  }
  return null;
}

interface PendingShipmentRow {
  rowIndex: number;
  row: ShipmentSheetRow;
  qty: number;
  dates: {
    plannedDepartDate: Date | null;
    actualDepartDate: Date | null;
    plannedArrivalDate: Date | null;
    actualArrivalDate: Date | null;
  };
}

export function transformShipments(rows: ShipmentSheetRow[]): { shipments: TransformedShipment[]; skipped: SkippedRow[] } {
  const skipped: SkippedRow[] = [];
  const groups = new Map<string, PendingShipmentRow[]>();

  rows.forEach((row, rowIndex) => {
    if (!row.shipment_ref) {
      skipped.push({ rowIndex, reason: "missing shipment_ref" });
      return;
    }
    if (!row.warehouse) {
      skipped.push({ rowIndex, reason: "missing warehouse" });
      return;
    }
    if (!VALID_SHIPMENT_STATUSES.includes(row.status)) {
      skipped.push({ rowIndex, reason: `unrecognized status "${row.status}"` });
      return;
    }
    if (!INTEGER_PATTERN.test(row.qty)) {
      skipped.push({ rowIndex, reason: `unparseable qty "${row.qty}"` });
      return;
    }
    const qty = parseInt(row.qty, 10);
    if (Number.isNaN(qty)) {
      skipped.push({ rowIndex, reason: `unparseable qty "${row.qty}"` });
      return;
    }
    const dates = {
      plannedDepartDate: optionalDate(row.planned_depart_date),
      actualDepartDate: optionalDate(row.actual_depart_date),
      plannedArrivalDate: optionalDate(row.planned_arrival_date),
      actualArrivalDate: optionalDate(row.actual_arrival_date),
    };
    const badDateKey = (Object.keys(dates) as (keyof typeof dates)[]).find((k) => dates[k] === "invalid");
    if (badDateKey) {
      skipped.push({ rowIndex, reason: `unparseable ${badDateKey}` });
      return;
    }
    if (row.customs_status && !(CUSTOMS_STATUSES as readonly string[]).includes(row.customs_status)) {
      skipped.push({ rowIndex, reason: `unrecognized customs_status "${row.customs_status}"` });
      return;
    }

    const ref = platformShipmentRef(row);
    const entry: PendingShipmentRow = { rowIndex, row, qty, dates: dates as PendingShipmentRow["dates"] };
    groups.set(ref, [...(groups.get(ref) ?? []), entry]);
  });

  const shipments: TransformedShipment[] = [];
  for (const [ref, group] of groups) {
    const conflict = findShipmentMergeConflict(group.map((g) => g.row));
    if (conflict) {
      const reason = `conflicting merge: ${group.length} rows share shipment ref "${ref}" but ${conflict}`;
      for (const g of group) skipped.push({ rowIndex: g.rowIndex, reason });
      continue;
    }

    const first = group[0];
    shipments.push({
      shipmentRef: ref,
      vendorReference: first.row.vendor_reference || null,
      initialStatus: first.row.status as TransformedShipment["initialStatus"],
      warehouseCode: first.row.warehouse,
      freightCost: first.row.freight_cost || null,
      dutyCost: first.row.duty_cost || null,
      costCurrency: first.row.cost_currency || null,
      plannedDepartDate: first.dates.plannedDepartDate,
      actualDepartDate: first.dates.actualDepartDate,
      plannedArrivalDate: first.dates.plannedArrivalDate,
      actualArrivalDate: first.dates.actualArrivalDate,
      customsStatus: (first.row.customs_status as CustomsStatus | undefined) || null,
      lineItems: group.map((g) => ({
        poLineItemRef: g.row.po_line_item_ref,
        sku: g.row.sku,
        qty: g.qty,
        weightShare: g.row.weight_share,
        valueShare: g.row.value_share,
      })),
    });
  }

  return { shipments, skipped };
}

// --- Payments ---

export interface PaymentSheetRow {
  po_number: string;
  sequence_no: string;
  expected_amount: string;
  expected_date: string;
  currency: string;
  // "TRUE"/"FALSE" (blank = not paid). A paid slot needs a paid_date — the
  // Sheet itself computes the date from Transactions, so a blank one is a
  // real data gap worth quarantining, not defaulting silently.
  paid?: string;
  paid_date?: string;
}

export interface TransformedPayment {
  poNumber: string;
  sequenceNo: number;
  expectedAmount: string;
  expectedDate: Date;
  currency: string;
  paid: boolean;
  paidDate: Date | null;
}

export function transformPayments(rows: PaymentSheetRow[]): { payments: TransformedPayment[]; skipped: SkippedRow[] } {
  const skipped: SkippedRow[] = [];
  const payments: TransformedPayment[] = [];

  rows.forEach((row, rowIndex) => {
    if (!DECIMAL_PATTERN.test(row.expected_amount)) {
      skipped.push({ rowIndex, reason: `unparseable expected_amount "${row.expected_amount}"` });
      return;
    }
    const amount = parseFloat(row.expected_amount);
    if (Number.isNaN(amount)) {
      skipped.push({ rowIndex, reason: `unparseable expected_amount "${row.expected_amount}"` });
      return;
    }
    const date = new Date(row.expected_date);
    if (Number.isNaN(date.getTime())) {
      skipped.push({ rowIndex, reason: `unparseable expected_date "${row.expected_date}"` });
      return;
    }
    if (!INTEGER_PATTERN.test(row.sequence_no)) {
      skipped.push({ rowIndex, reason: `unparseable sequence_no "${row.sequence_no}"` });
      return;
    }
    const sequenceNo = parseInt(row.sequence_no, 10);
    if (Number.isNaN(sequenceNo)) {
      skipped.push({ rowIndex, reason: `unparseable sequence_no "${row.sequence_no}"` });
      return;
    }
    const paid = (row.paid ?? "").toUpperCase() === "TRUE";
    const paidDate = optionalDate(row.paid_date);
    if (paidDate === "invalid") {
      skipped.push({ rowIndex, reason: `unparseable paid_date "${row.paid_date}"` });
      return;
    }
    if (paid && paidDate === null) {
      skipped.push({ rowIndex, reason: `paid without a paid_date (${row.po_number} #${row.sequence_no})` });
      return;
    }
    payments.push({
      poNumber: row.po_number,
      sequenceNo,
      expectedAmount: row.expected_amount,
      expectedDate: date,
      currency: row.currency,
      paid,
      paidDate: paid ? paidDate : null,
    });
  });

  return { payments, skipped };
}

// --- Transactions ---

export interface TransactionSheetRow {
  date: string;
  amount: string;
  currency: string;
  fx_rate: string;
  counterparty: string;
  description: string;
  // A human-entered PO number (or shipment ref) this transaction pays for,
  // carried from the Sheet's own "PO#/Shipment Ref" column — transferred
  // as-is, never inferred. The transform itself never resolves this to a
  // payment; that matching (and its own tolerance/variance rules) happens
  // downstream, against the migrated POs/payments, not here.
  matched_ref?: string;
}

export interface TransformedTransaction {
  date: Date;
  amount: string;
  currency: string;
  fxRate: string;
  counterparty: string;
  description: string;
  matchedRef: string | null;
}

export function transformTransactions(rows: TransactionSheetRow[]): { transactions: TransformedTransaction[]; skipped: SkippedRow[] } {
  const skipped: SkippedRow[] = [];
  const transactions: TransformedTransaction[] = [];

  rows.forEach((row, rowIndex) => {
    const date = new Date(row.date);
    if (Number.isNaN(date.getTime())) {
      skipped.push({ rowIndex, reason: `unparseable date "${row.date}"` });
      return;
    }
    if (!DECIMAL_PATTERN.test(row.amount)) {
      skipped.push({ rowIndex, reason: `unparseable amount "${row.amount}"` });
      return;
    }
    const amount = parseFloat(row.amount);
    if (Number.isNaN(amount)) {
      skipped.push({ rowIndex, reason: `unparseable amount "${row.amount}"` });
      return;
    }
    // The transform itself never matches — matchedRef is only a carried hint
    // that downstream migration code resolves against a migrated PO's own
    // payments (a transfer of a link a human already made in the Sheet);
    // automated matching stays out, per the design's decision.
    transactions.push({
      date,
      amount: row.amount,
      currency: row.currency,
      fxRate: row.fx_rate,
      counterparty: row.counterparty,
      description: row.description,
      matchedRef: (row.matched_ref ?? "").trim() || null,
    });
  });

  return { transactions, skipped };
}

// --- Sales actuals & sales plan (per SKU / warehouse / calendar day) ---

export interface SalesRowSheet {
  sku: string;
  warehouse: string;
  date: string;
  qty: string;
}

export interface TransformedSalesRow {
  sku: string;
  warehouseCode: string;
  date: Date;
  qty: number;
}

function transformSalesRows(rows: SalesRowSheet[], label: string): { rows: TransformedSalesRow[]; skipped: SkippedRow[] } {
  const skipped: SkippedRow[] = [];
  const out: TransformedSalesRow[] = [];

  rows.forEach((row, rowIndex) => {
    if (!INTEGER_PATTERN.test(row.qty)) {
      skipped.push({ rowIndex, reason: `unparseable ${label} qty "${row.qty}"` });
      return;
    }
    const qty = parseInt(row.qty, 10);
    if (Number.isNaN(qty)) {
      skipped.push({ rowIndex, reason: `unparseable ${label} qty "${row.qty}"` });
      return;
    }
    const date = new Date(row.date);
    if (Number.isNaN(date.getTime())) {
      skipped.push({ rowIndex, reason: `unparseable ${label} date "${row.date}"` });
      return;
    }
    out.push({ sku: row.sku, warehouseCode: row.warehouse, date, qty });
  });

  return { rows: out, skipped };
}

// One row per SKU/warehouse/calendar-day, from the Sales Plan tabs' `<SKU>
// Actual/day` columns (FF and Mutual, each exported separately upstream and
// concatenated here) — each row becomes one `sale` ledger event *and* one
// `sales_actuals` row (written together through `recordSalesActual`, not
// through this file's own `ledgerRows`/`transformSheetExport` path, which
// stays receipts-only).
export function transformSalesActuals(rows: SalesRowSheet[]): { rows: TransformedSalesRow[]; skipped: SkippedRow[] } {
  return transformSalesRows(rows, "sales actual");
}

// One row per SKU/warehouse/calendar-day, from the Sales Plan tabs' `<SKU>
// Plan/day` columns — becomes a `sales_plan` row, never a ledger event.
export function transformSalesPlan(rows: SalesRowSheet[]): { rows: TransformedSalesRow[]; skipped: SkippedRow[] } {
  return transformSalesRows(rows, "sales plan");
}
