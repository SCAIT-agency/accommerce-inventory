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
  /** Warehouse code for a "soh" mismatch; the shipment ref for a "landed_cost" one. */
  warehouseCode: string;
  expected: number;
  actual: number | null;
  diff: number | null;
  kind: "soh" | "landed_cost";
}

// Landed cost is compared at the grain the Sheet actually has: one landed
// unit cost per shipment line (Landed Cost Summary), not per SKU/warehouse.
export interface LandedCostTotal {
  shipmentRef: string;
  sku: string;
  landedCostFromSheet: number;
}

export interface LandedCostReconciliationDeps {
  getMigratedLandedCost: (shipmentRef: string, sku: string) => Promise<number>;
}

const LANDED_COST_TOLERANCE_MIN = 0.01;
const LANDED_COST_TOLERANCE_PCT = 0.001;

/** Stream B default: the greater of 0.01 or 0.1% of the expected value. */
export function defaultLandedCostTolerance(expected: number): number {
  return Math.max(LANDED_COST_TOLERANCE_MIN, Math.abs(expected) * LANDED_COST_TOLERANCE_PCT);
}

export interface ReconcileOptions {
  /** Absolute tolerance for a landed-cost comparison, as a function of the expected value. Defaults to defaultLandedCostTolerance. */
  landedCostTolerance?: (expected: number) => number;
}

export async function reconcileMigration(
  sheetTotals: SkuWarehouseTotal[],
  deps: ReconciliationDeps,
  landedCostTotals: LandedCostTotal[] = [],
  landedCostDeps?: LandedCostReconciliationDeps,
  options: ReconcileOptions = {},
): Promise<{ passed: boolean; mismatches: Mismatch[] }> {
  const tolerance = options.landedCostTolerance ?? defaultLandedCostTolerance;
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
      const actual = await landedCostDeps.getMigratedLandedCost(total.shipmentRef, total.sku);
      // NaN on either side must count as a mismatch. actual NaN (a line the
      // platform could not cost at all): every comparison with NaN is false,
      // so an unguarded ">" check alone would silently pass it — caught by
      // !Number.isFinite(actual). A non-finite total.landedCostFromSheet
      // (a malformed Sheet export value) is a second, independent way the
      // same silent-pass could happen: tolerance(NaN) is itself NaN
      // (Math.max(0.01, NaN) === NaN in JS), and "anything > NaN" is always
      // false, so the diff check alone would wrongly report "no mismatch" —
      // caught by the explicit !Number.isFinite(total.landedCostFromSheet).
      if (
        !Number.isFinite(actual) ||
        !Number.isFinite(total.landedCostFromSheet) ||
        Math.abs(total.landedCostFromSheet - actual) > tolerance(total.landedCostFromSheet)
      ) {
        mismatches.push({
          sku: total.sku,
          warehouseCode: total.shipmentRef,
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
  /** Owner: exactly one of po_number / shipment_ref must be non-blank. */
  po_number: string;
  shipment_ref?: string;
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
  poNumber: string | null;
  shipmentRef: string | null;
  sequenceNo: number;
  expectedAmount: string;
  expectedDate: Date;
  currency: string;
  paid: boolean;
  paidDate: Date | null;
}

// A container's several per-row freight/customs payment slots (same
// convention as transformShipments' pooling: "<prefix>Container<N>-<SKU>")
// share one physical invoice and sum into the pooled shipment's own payment
// sequence. Payment rows carry no `sku` field to cross-check against (unlike
// shipment rows), so this applies the pattern alone — an acceptable
// relaxation since the Container-N-<SKU> naming is reserved for pooled
// container lines in the real Sheet, never used for an unrelated shipment.
// Exported: reconcile-migration.ts's transaction-matching also needs this,
// as a fallback when a matched_ref doesn't resolve on its own (see there).
export function pooledPaymentOwnerRef(shipmentRef: string): string {
  const m = POOLED_SHIPMENT_PATTERN.exec(shipmentRef);
  return m ? m[1] : shipmentRef;
}

interface RawPaymentRow {
  rowIndex: number;
  poNumber: string | null;
  shipmentRef: string | null; // resolved pooled owner ref — the grouping key
  shipmentRefRaw: string | null; // the raw, un-pooled ref exactly as the Sheet gave it
  sequenceNo: number;
  row: PaymentSheetRow;
}

// Rows pooling into one payment slot (same owner + sequence) must agree on
// everything but the amount — otherwise summing would silently blend two
// genuinely different slots (e.g. one row paid, another not). Compared as
// raw Sheet strings, blanks included — the same strict, no-fallback pattern
// SHIPMENT_MERGE_KEYS/findShipmentMergeConflict already uses (a blank
// sibling counts as a real disagreement, not "no opinion"). This is a
// deliberate choice, not an emergent gap: the source branch's exporter
// instead *reconciled* disagreements across pooled rows (paid = AND across
// rows, paid_date = latest, expected_date = first non-blank) rather than
// quarantining — this engagement's established "fail loudly, not silently"
// convention wins here over porting that more permissive behavior.
const PAYMENT_MERGE_KEYS = ["currency", "expected_date", "paid", "paid_date"] as const;

function findPaymentMergeConflict(rows: RawPaymentRow[]): string | null {
  const [first, ...rest] = rows;
  for (const row of rest) {
    for (const key of PAYMENT_MERGE_KEYS) {
      const a = first.row[key] ?? "";
      const b = row.row[key] ?? "";
      if (a !== b) {
        return `disagree on ${key} ("${a}" vs "${b}")`;
      }
    }
  }
  return null;
}

export function transformPayments(rows: PaymentSheetRow[]): { payments: TransformedPayment[]; skipped: SkippedRow[] } {
  const skipped: SkippedRow[] = [];
  const preGroup: RawPaymentRow[] = [];
  // Shipment owner refs where a row genuinely naming a pooled-container line
  // (its ref actually matches the Container-N pattern) failed pass-1
  // validation for an unrelated reason (bad sequence_no, or the XOR check).
  // We cannot know which sequence that row belonged to, so every sequence
  // group under that owner is now suspect — poisoning the whole owner is the
  // only safe response to that ambiguity. Scoped to genuine Container-N refs
  // only (checked via pooledPaymentOwnerRef actually rewriting the ref) —
  // a plain, never-pooled shipment ref (e.g. "PO1-W3") has no such ambiguity:
  // a bad row referencing it can't have "belonged to" any other sequence,
  // so it must not poison that shipment's own, otherwise-valid payment rows.
  const poisonedShipmentOwners = new Set<string>();

  // Pass 1: only the fields needed to determine which group a row belongs to
  // (owner, sequence) are validated here. Everything else — amount, date,
  // paid/paid_date — is validated per GROUP below, not per row: validating
  // (and dropping) a bad row before grouping would let a pooled group's
  // surviving, individually-valid sibling silently stand in as the whole
  // group's total — committing a wrong, partial amount with no aggregate
  // signal that anything was lost. Grouping first and validating the whole
  // group together means a bad sibling always quarantines the WHOLE group.
  rows.forEach((row, rowIndex) => {
    const poNumber = (row.po_number ?? "").trim() || null;
    const shipmentRefRaw = (row.shipment_ref ?? "").trim() || null;
    const candidateOwner = shipmentRefRaw ? pooledPaymentOwnerRef(shipmentRefRaw) : null;
    const isGenuinePooledRef = candidateOwner !== null && candidateOwner !== shipmentRefRaw;

    if ((poNumber === null) === (shipmentRefRaw === null)) {
      if (isGenuinePooledRef) poisonedShipmentOwners.add(candidateOwner!);
      skipped.push({
        rowIndex,
        reason: `payment must belong to exactly one of po_number / shipment_ref (got "${row.po_number}" / "${row.shipment_ref ?? ""}")`,
      });
      return;
    }
    if (!INTEGER_PATTERN.test(row.sequence_no) || Number.isNaN(parseInt(row.sequence_no, 10))) {
      if (isGenuinePooledRef) poisonedShipmentOwners.add(candidateOwner!);
      skipped.push({ rowIndex, reason: `unparseable sequence_no "${row.sequence_no}"` });
      return;
    }
    const sequenceNo = parseInt(row.sequence_no, 10);
    preGroup.push({
      rowIndex,
      poNumber,
      shipmentRef: candidateOwner,
      shipmentRefRaw,
      sequenceNo,
      row,
    });
  });

  // PO-owned and shipment-owned rows share the same owner+sequence grouping
  // so a duplicate/corrupt data pattern gets the same safe handling either
  // way — see the pooled/duplicate check below for what "the same owner and
  // sequence, more than one row" actually means for each ownership kind.
  const groups = new Map<string, RawPaymentRow[]>();
  for (const p of preGroup) {
    const ownerKey = p.poNumber !== null ? `po:${p.poNumber}` : `shipment:${p.shipmentRef}`;
    const key = `${ownerKey}::${p.sequenceNo}`;
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }

  const payments: TransformedPayment[] = [];
  for (const group of groups.values()) {
    const owner = group[0].poNumber ?? group[0].shipmentRef!;
    const isPoOwned = group[0].poNumber !== null;

    // A shipment owner with a pass-1 casualty elsewhere under the SAME
    // genuinely-pooled ref: we don't know which sequence that row belonged
    // to, so this group (any sequence under that owner) can't be trusted.
    if (!isPoOwned && poisonedShipmentOwners.has(owner)) {
      const reason = `payment quarantined: another row naming pooled owner "${owner}" failed validation with an unusable sequence_no, so this owner's payment total cannot be trusted`;
      for (const g of group) skipped.push({ rowIndex: g.rowIndex, reason });
      continue;
    }

    // Only a GENUINE pooled container — rows merging from at least two
    // DISTINCT raw shipment_ref values (real per-SKU container lines) — may
    // ever sum. POs never pool at all (per the design, only Container-N
    // shipment refs pool); an exact-duplicate row pair (same raw ref/PO
    // number, same sequence) is a duplicate, not a pool, and both quarantine
    // outright rather than silently doubling the real amount.
    const distinctRawRefs = new Set(group.map((g) => g.shipmentRefRaw ?? g.poNumber));
    const pooled = group.length > 1 && !isPoOwned && distinctRawRefs.size > 1;
    if (group.length > 1 && !pooled) {
      const reason = isPoOwned
        ? `duplicate payment rows: ${group.length} rows share PO "${owner}" sequence ${group[0].sequenceNo} — purchase orders don't pool, expected exactly one row per PO×sequence`
        : `duplicate payment rows: ${group.length} rows share the exact same shipment_ref "${group[0].shipmentRefRaw}" and sequence ${group[0].sequenceNo} — not a genuine pooled container (no distinct per-SKU lines), so this is a duplicate, not a sum`;
      for (const g of group) skipped.push({ rowIndex: g.rowIndex, reason });
      continue;
    }

    const label = (detail: string) =>
      pooled ? `conflicting merge: ${group.length} payment rows share owner "${owner}" sequence ${group[0].sequenceNo} but ${detail}` : detail;

    // Pass 2a: every member must agree on everything but the amount.
    const conflict = findPaymentMergeConflict(group);
    if (conflict) {
      const reason = label(conflict);
      for (const g of group) skipped.push({ rowIndex: g.rowIndex, reason });
      continue;
    }

    // Pass 2b: amount — every member must be individually parseable. A group
    // never sums only the valid subset; one bad sibling quarantines all of it.
    const amounts: number[] = [];
    let badAmount: { rowIndex: number; raw: string } | null = null;
    for (const g of group) {
      if (!DECIMAL_PATTERN.test(g.row.expected_amount)) {
        badAmount = { rowIndex: g.rowIndex, raw: g.row.expected_amount };
        break;
      }
      const amt = parseFloat(g.row.expected_amount);
      if (Number.isNaN(amt)) {
        badAmount = { rowIndex: g.rowIndex, raw: g.row.expected_amount };
        break;
      }
      amounts.push(amt);
    }
    if (badAmount) {
      const reason = label(pooled ? `row ${badAmount.rowIndex} has unparseable expected_amount "${badAmount.raw}"` : `unparseable expected_amount "${badAmount.raw}"`);
      for (const g of group) skipped.push({ rowIndex: g.rowIndex, reason });
      continue;
    }

    // Pass 2c: date — the merge check above already guarantees every member
    // states the identical raw expected_date, so the first row's value
    // stands for the whole group; this only fails when every member agrees
    // on a blank or otherwise unparseable date (no member has anything usable).
    const expectedDate = new Date(group[0].row.expected_date);
    if (Number.isNaN(expectedDate.getTime())) {
      const reason = label(`no row has a parseable expected_date ("${group[0].row.expected_date}")`);
      for (const g of group) skipped.push({ rowIndex: g.rowIndex, reason });
      continue;
    }

    // Pass 2d: paid / paid_date — same reasoning: already uniform across the group.
    const paid = (group[0].row.paid ?? "").toUpperCase() === "TRUE";
    const paidDate = optionalDate(group[0].row.paid_date);
    if (paidDate === "invalid") {
      const reason = label(`unparseable paid_date "${group[0].row.paid_date}"`);
      for (const g of group) skipped.push({ rowIndex: g.rowIndex, reason });
      continue;
    }
    if (paid && paidDate === null) {
      const reason = `paid without a paid_date (${owner} #${group[0].sequenceNo})`;
      for (const g of group) skipped.push({ rowIndex: g.rowIndex, reason });
      continue;
    }

    // A single (non-pooled) row keeps its own raw amount string, exactly as
    // before; only a genuine multi-row pooled group's summed total needs
    // recomputing.
    const total = amounts.reduce((a, b) => a + b, 0);
    const expectedAmount = pooled ? total.toFixed(2) : group[0].row.expected_amount;

    // Same reasoning as the pooled/duplicate check above, applied to the
    // OUTPUT ref: a group that isn't genuinely pooled (only one distinct raw
    // shipment_ref feeds it) must be owned by that RAW ref, not the
    // Container-N-pattern candidate — a standalone shipment whose ref
    // happens to look poolable (the same false-positive transformShipments'
    // own sku cross-check guards against, e.g. "...Container9-Notes") would
    // otherwise get a payment row pointing at a pooled owner ref that
    // doesn't correspond to any real migrated shipment, and quarantine at
    // runtime as "unresolved owner" even though its raw ref was real all along.
    const outputShipmentRef = pooled ? group[0].shipmentRef : group[0].shipmentRefRaw;

    payments.push({
      poNumber: group[0].poNumber,
      shipmentRef: outputShipmentRef,
      sequenceNo: group[0].sequenceNo,
      expectedAmount,
      expectedDate,
      currency: group[0].row.currency,
      paid,
      paidDate: paid ? paidDate : null,
    });
  }

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
    // The transform itself never matches or normalizes — matchedRef is only
    // a carried hint, transferred exactly as the Sheet gave it. Pooled-owner
    // normalization (collapsing a per-SKU container-line hint to its pooled
    // shipment ref) happens in runMigration instead, as a fallback ONLY when
    // the raw ref doesn't already resolve on its own — this transform layer
    // has no way to know whether a Container-N-looking ref is genuinely
    // pooled or one transformShipments deliberately left standalone (that
    // decision needs the real shipmentIdByRef/paymentsByOwner runMigration
    // builds), so rewriting it here risks breaking a ref that would have
    // resolved correctly as-is.
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
