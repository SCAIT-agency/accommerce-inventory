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
}

export function transformSheetExport(rows: SheetExportRow[]): TransformedMigrationData {
  return {
    ledgerEvents: rows.map((r) => ({
      sku: r.sku,
      warehouseCode: r.warehouse,
      eventType: r.event_type as "receipt" | "sale" | "adjustment",
      qty: parseFloat(r.qty),
      unitCost: parseFloat(r.unit_cost),
      date: new Date(r.date),
      sourceRef: r.source_ref,
    })),
  };
}

export interface SkuWarehouseTotal {
  sku: string;
  warehouseCode: string;
  sohFromSheet: number;
}

export interface ReconciliationDeps {
  getMigratedSoh: (sku: string, warehouseCode: string) => Promise<number>;
}

export interface Mismatch {
  sku: string;
  warehouseCode: string;
  expected: number;
  actual: number;
  diff: number;
}

export async function reconcileMigration(
  sheetTotals: SkuWarehouseTotal[],
  deps: ReconciliationDeps,
): Promise<{ passed: boolean; mismatches: Mismatch[] }> {
  const mismatches: Mismatch[] = [];
  for (const total of sheetTotals) {
    const actual = await deps.getMigratedSoh(total.sku, total.warehouseCode);
    if (actual !== total.sohFromSheet) {
      mismatches.push({
        sku: total.sku,
        warehouseCode: total.warehouseCode,
        expected: total.sohFromSheet,
        actual,
        diff: actual - total.sohFromSheet,
      });
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
  freight_cost: string;
  duty_cost: string;
  cost_currency: string;
  po_line_item_ref: string;
  sku: string;
  qty: string;
  weight_share: string;
  value_share: string;
}

export interface TransformedShipment {
  shipmentRef: string;
  vendorReference: string | null;
  initialStatus: "planned" | "departed" | "in_transit" | "customs" | "delivered";
  freightCost: string | null;
  dutyCost: string | null;
  costCurrency: string | null;
  lineItems: { poLineItemRef: string; sku: string; qty: number; weightShare: string; valueShare: string }[];
}

const VALID_SHIPMENT_STATUSES = ["planned", "departed", "in_transit", "customs", "delivered"];

export function transformShipments(rows: ShipmentSheetRow[]): { shipments: TransformedShipment[]; skipped: SkippedRow[] } {
  const skipped: SkippedRow[] = [];
  const byShipmentRef = new Map<string, TransformedShipment>();

  rows.forEach((row, rowIndex) => {
    if (!row.shipment_ref) {
      skipped.push({ rowIndex, reason: "missing shipment_ref" });
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

    const lineItem = { poLineItemRef: row.po_line_item_ref, sku: row.sku, qty, weightShare: row.weight_share, valueShare: row.value_share };
    const existing = byShipmentRef.get(row.shipment_ref);
    if (existing) {
      existing.lineItems.push(lineItem);
    } else {
      byShipmentRef.set(row.shipment_ref, {
        shipmentRef: row.shipment_ref,
        vendorReference: row.vendor_reference || null,
        initialStatus: row.status as TransformedShipment["initialStatus"],
        freightCost: row.freight_cost || null,
        dutyCost: row.duty_cost || null,
        costCurrency: row.cost_currency || null,
        lineItems: [lineItem],
      });
    }
  });

  return { shipments: Array.from(byShipmentRef.values()), skipped };
}

// --- Payments ---

export interface PaymentSheetRow {
  po_number: string;
  sequence_no: string;
  expected_amount: string;
  expected_date: string;
  currency: string;
}

export interface TransformedPayment {
  poNumber: string;
  sequenceNo: number;
  expectedAmount: string;
  expectedDate: Date;
  currency: string;
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
    payments.push({
      poNumber: row.po_number,
      sequenceNo,
      expectedAmount: row.expected_amount,
      expectedDate: date,
      currency: row.currency,
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
}

export interface TransformedTransaction {
  date: Date;
  amount: string;
  currency: string;
  fxRate: string;
  counterparty: string;
  description: string;
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
    // migrated as unmatched regardless of any match hint the source row carries —
    // real matching happens manually after migration, per the design's decision.
    transactions.push({
      date,
      amount: row.amount,
      currency: row.currency,
      fxRate: row.fx_rate,
      counterparty: row.counterparty,
      description: row.description,
    });
  });

  return { transactions, skipped };
}
