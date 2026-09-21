import { eq } from "drizzle-orm";
import { db } from "../server/dbClient";
import { createSku, createWarehouse, createVendor, createUser, listSkus, listWarehouses, listVendors } from "../server/db";
import { users, shipments, payments, transactions } from "../drizzle/schema";
import { recordLedgerEvent, getSoh } from "../server/inventoryLedger";
import { createPurchaseOrder, getPurchaseOrderWithLineItems } from "../server/purchaseOrders";
import { createShipment } from "../server/shipments";
import { createExpectedPayment, recordTransaction, markPaymentPaidCore } from "../server/payments";
import { createSalesPlanEntry, recordSalesActual } from "../server/salesPlan";
import { getShipmentLandedUnitCost } from "../server/landedCost";
import { logChange } from "../server/changeLog";
import {
  transformSheetExport,
  transformPurchaseOrders,
  transformShipments,
  transformPayments,
  transformTransactions,
  transformSalesActuals,
  transformSalesPlan,
  reconcileMigration,
  pooledPaymentOwnerRef,
  resolveShipmentOwnerRef,
  type SheetExportRow,
  type PoSheetRow,
  type ShipmentSheetRow,
  type PaymentSheetRow,
  type TransactionSheetRow,
  type SalesRowSheet,
  type SkuWarehouseTotal,
  type SkippedRow,
  type LandedCostTotal,
  type ReconcileOptions,
} from "./migrate-from-sheet";

export interface RunMigrationInput {
  ledgerRows: SheetExportRow[];
  poRows: PoSheetRow[];
  shipmentRows: ShipmentSheetRow[];
  paymentRows: PaymentSheetRow[];
  transactionRows: TransactionSheetRow[];
  sheetTotals: SkuWarehouseTotal[];
  landedCostTotals?: LandedCostTotal[];
  /** Real daily sales; written through recordSalesActual so sales_actuals and the ledger stay paired. */
  salesActualRows?: SalesRowSheet[];
  salesPlanRows?: SalesRowSheet[];
}

export type RunMigrationOptions = ReconcileOptions;

export interface UnmatchedManualLink {
  transactionIndex: number;
  ref: string;
  reason: string;
}

export interface LinkVariance {
  ref: string;
  sequenceNo: number;
  expectedAmount: number;
  paidAmount: number;
  variancePct: number;
  /** true when the Sheet marked the slot unpaid and the link is what recorded it as paid */
  paidInferredFromLink: boolean;
}

export interface RunMigrationResult {
  quarantined: {
    ledger: SkippedRow[];
    purchaseOrders: SkippedRow[];
    shipments: SkippedRow[];
    payments: SkippedRow[];
    transactions: SkippedRow[];
    salesActuals: SkippedRow[];
    salesPlan: SkippedRow[];
  };
  /** Human match hints from the Sheet that could not be transferred to a platform payment, with the reason. */
  unmatchedManualLinks: UnmatchedManualLink[];
  /** Links transferred outside the exact tolerance, or onto a slot the Sheet had not marked paid. */
  linkVariances: LinkVariance[];
  counts: { matchedTransactions: number; paidPayments: number };
}

// A transferred link must be unambiguous. Tier 1: the transaction's
// base-currency amount is within 1% of the payment. Tier 2 (Artem,
// 2026-09-19, commit ea7d1b3's decided-rules delta): within 5% — FX drift on
// a USD-paid EUR-planned instalment, or a partial payment — transferred too,
// with the amount actually paid recorded on the payment and the variance
// listed in the result.
const MATCH_TOLERANCE_EXACT = 0.01;
const MATCH_TOLERANCE_VARIANCE = 0.05;

const MAX_INSTALMENT_GROUP = 10; // 2^10 subsets — beyond that only the whole group is tried

/**
 * Among all ≥2-member subsets of `group` whose total is within tolerance of
 * some candidate payment, return the closest pair (smallest relative
 * difference; larger subset breaks ties). Closest, not largest: a stray
 * bank-fee row linked to the same PO must not be swept into an instalment
 * group just because the tolerance can absorb it.
 */
function findInstalmentSubset<H extends { baseAmount: number }, P extends { amount: number }>(
  group: H[],
  candidates: P[],
  within: (payment: P, amount: number) => boolean,
): { members: H[]; target: P } | null {
  const n = group.length;
  const masks: number[] = [];
  if (n <= MAX_INSTALMENT_GROUP) {
    for (let m = 3; m < 1 << n; m++) if ((m & (m - 1)) !== 0) masks.push(m); // ≥ 2 members
  } else {
    masks.push(2 ** n - 1);
  }
  let best: { members: H[]; target: P; score: number } | null = null;
  for (const mask of masks) {
    const members = group.filter((_, i) => (mask & (1 << i)) !== 0);
    const total = members.reduce((a, h) => a + h.baseAmount, 0);
    for (const target of candidates) {
      if (!within(target, total)) continue;
      const score = Math.abs(target.amount - total) / target.amount;
      if (!best || score < best.score || (score === best.score && members.length > best.members.length)) {
        best = { members, target, score };
      }
    }
  }
  return best ? { members: best.members, target: best.target } : null;
}

export async function runMigration(input: RunMigrationInput, options: RunMigrationOptions = {}): Promise<RunMigrationResult> {
  // Finding 1 (superseded): this used to throw immediately if landedCostTotals
  // was non-empty ("landed-cost reconciliation is not yet wired to a real data
  // source"). That guard's whole reason for existing — unknown real Control
  // Tower Sheet column names — no longer applies; the real gate now runs at
  // the bottom of the transaction below, via getMigratedLandedCost.
  const { ledgerEvents, skipped: skippedLedger } = transformSheetExport(input.ledgerRows);
  // Finding 4: sort ledger events chronologically before replay — the negative-stock
  // guard checks SOH "as of" each event's own date, so a receipt appearing after its
  // corresponding sale in source row order (but dated earlier) must still be applied
  // to the ledger before that sale is checked.
  ledgerEvents.sort((a, b) => a.date.getTime() - b.date.getTime());
  const { purchaseOrders: transformedPos, skipped: skippedPos } = transformPurchaseOrders(input.poRows);
  const { shipments: transformedShipments, skipped: skippedShipments, pooledOwnerRefs } = transformShipments(input.shipmentRows);
  const { payments: transformedPayments, skipped: skippedPayments } = transformPayments(input.paymentRows, pooledOwnerRefs);
  const { transactions: transformedTransactions, skipped: skippedTransactions } = transformTransactions(input.transactionRows);
  const { rows: salesActualEvents, skipped: skippedSalesActuals } = transformSalesActuals(input.salesActualRows ?? []);
  const { rows: salesPlanEntries, skipped: skippedSalesPlan } = transformSalesPlan(input.salesPlanRows ?? []);
  salesActualEvents.sort((a, b) => a.date.getTime() - b.date.getTime());

  // Finding 5: runtime (not row-parse-time) quarantines — resolved only once
  // cross-entity references (PO line items, PO numbers, shipment refs) are
  // known, inside the transaction below.
  const runtimeSkippedShipments: SkippedRow[] = [];
  const runtimeSkippedPayments: SkippedRow[] = [];
  const runtimeSkippedSales: SkippedRow[] = [];
  const unmatchedManualLinks: UnmatchedManualLink[] = [];
  const linkVariances: LinkVariance[] = [];
  const counts = { matchedTransactions: 0, paidPayments: 0 };

  // Everything below runs on the transaction's own connection (`tx`, threaded
  // into every helper call) rather than the pool-backed `db` — the pool would
  // hand writes a different connection each time, so they'd commit immediately
  // and survive a rollback instead of being undone by it.
  await db.transaction(async (tx) => {
    const skuByCode = new Map((await listSkus()).map((s) => [s.sku, s.id]));
    const warehouseByCode = new Map((await listWarehouses()).map((w) => [w.code, w.id]));
    const vendorByName = new Map((await listVendors()).map((v) => [v.name, v.id]));
    const poIdByNumber = new Map<string, number>();
    const poLineItemIdByRef = new Map<string, number>(); // "PO_NUMBER::SKU" -> line item id
    const shipmentIdByRef = new Map<string, number>();
    const shipmentRefs = new Set(transformedShipments.map((s) => s.shipmentRef));
    // Payments created in this run, keyed by owner ref (PO number or
    // migrated — possibly pooled — shipment ref), in sequence order — the
    // only candidates a Sheet match hint may be transferred to.
    type Candidate = { id: number; sequenceNo: number; amount: number; paid: boolean; paidAmount: number | null; matched: boolean };
    const paymentsByOwner = new Map<string, Candidate[]>();

    // POs/shipments created by this script have no real human actor behind
    // them (it's a one-time bulk import from a Sheet), but createdBy is a real
    // FK to users.id — get-or-create a fixed system-user row to attribute them
    // to, rather than a literal that doesn't correspond to any user.
    const MIGRATION_USER_EMAIL = "migration@accommerce.system";
    async function ensureMigrationUser(): Promise<number> {
      const [existing] = await tx.select().from(users).where(eq(users.email, MIGRATION_USER_EMAIL));
      if (existing) return existing.id;
      const created = await createUser({ email: MIGRATION_USER_EMAIL, role: "viewer" }, tx);
      return created.id;
    }
    const migrationUserId = await ensureMigrationUser();

    async function ensureSku(skuCode: string): Promise<number> {
      let id = skuByCode.get(skuCode);
      if (!id) {
        const created = await createSku({ sku: skuCode, primaryIdentifierType: "sku" }, tx);
        id = created.id;
        skuByCode.set(skuCode, id);
      }
      return id;
    }

    async function ensureWarehouse(code: string): Promise<number> {
      let id = warehouseByCode.get(code);
      if (!id) {
        const created = await createWarehouse({ code, name: code }, tx);
        id = created.id;
        warehouseByCode.set(code, id);
      }
      return id;
    }

    async function ensureVendor(name: string): Promise<number> {
      let id = vendorByName.get(name);
      if (!id) {
        const created = await createVendor({ name }, tx);
        id = created.id;
        vendorByName.set(name, id);
      }
      return id;
    }

    // 1. Purchase Orders + line items
    for (const po of transformedPos) {
      const vendorId = await ensureVendor(po.vendorName);
      const lineItems: { skuId: number; qty: number; unitPrice: string; currency: string }[] = [];
      for (const li of po.lineItems) {
        lineItems.push({ skuId: await ensureSku(li.sku), qty: li.qty, unitPrice: li.unitPrice, currency: li.currency });
      }
      const created = await createPurchaseOrder(
        {
          poNumber: po.poNumber,
          vendorId,
          vendorReference: po.vendorReference ?? undefined,
          initialStatus: po.initialStatus,
          lineItems,
          createdBy: migrationUserId,
        },
        tx,
      );
      poIdByNumber.set(po.poNumber, created.id);
      // Finding 6: ordered explicitly by id so this zip-by-index against
      // po.lineItems (original transform order) is guaranteed correct rather
      // than relying on MySQL returning rows in insertion order by convention.
      const withItems = await getPurchaseOrderWithLineItems(created.id, tx);
      withItems.lineItems.forEach((li, idx) => {
        // Known limitation: this key collides if one PO has two line items for
        // the same SKU (e.g. two price tranches) — the second silently overwrites
        // the first in this map. Not fixed speculatively: the real Control Tower
        // Sheet's actual po_line_item_ref format is unknown (open question in the
        // spec), and inventing a new key scheme now could mismatch whatever the
        // real data actually provides.
        poLineItemIdByRef.set(`${po.poNumber}::${po.lineItems[idx].sku}`, li.id);
      });
    }

    // 2. Shipments + shipment line items (+ history dates, written directly:
    //    migration records what happened, it does not replay the state machine)
    // Finding 5: a shipment referencing a PO line item that wasn't migrated
    // (e.g. its parent PO was quarantined) is quarantined whole rather than
    // crashing the entire migration on a non-null assertion.
    for (const [shipmentIdx, shipment] of transformedShipments.entries()) {
      const unresolvedRef = shipment.lineItems.find((li) => !poLineItemIdByRef.has(li.poLineItemRef));
      if (unresolvedRef) {
        runtimeSkippedShipments.push({
          rowIndex: shipmentIdx,
          reason: `unresolved po_line_item_ref "${unresolvedRef.poLineItemRef}" — referenced PO or PO line item was not migrated (likely quarantined)`,
        });
        continue;
      }
      const lineItems: { poLineItemId: number; skuId: number; qty: number; weightShare: string; valueShare: string }[] = [];
      for (const li of shipment.lineItems) {
        lineItems.push({
          poLineItemId: poLineItemIdByRef.get(li.poLineItemRef)!,
          skuId: await ensureSku(li.sku),
          qty: li.qty,
          weightShare: li.weightShare,
          valueShare: li.valueShare,
        });
      }
      const created = await createShipment(
        {
          shipmentRef: shipment.shipmentRef,
          vendorReference: shipment.vendorReference ?? undefined,
          initialStatus: shipment.initialStatus,
          warehouseId: await ensureWarehouse(shipment.warehouseCode),
          freightCost: shipment.freightCost ?? undefined,
          dutyCost: shipment.dutyCost ?? undefined,
          costCurrency: shipment.costCurrency ?? undefined,
          lineItems,
          createdBy: migrationUserId,
        },
        tx,
      );
      shipmentIdByRef.set(shipment.shipmentRef, created.id);
      const history = {
        plannedDepartDate: shipment.plannedDepartDate,
        actualDepartDate: shipment.actualDepartDate,
        plannedArrivalDate: shipment.plannedArrivalDate,
        actualArrivalDate: shipment.actualArrivalDate,
        ...(shipment.customsStatus ? { customsStatus: shipment.customsStatus } : {}),
      };
      if (Object.values(history).some((v) => v !== null && v !== undefined)) {
        await tx.update(shipments).set(history).where(eq(shipments.id, created.id));
      }
    }

    // 3. Payments (+ paid flags transferred as the Sheet recorded them).
    // Finding 5: a payment referencing a PO number/shipment ref that wasn't
    // migrated is quarantined instead of silently inserting an orphaned row.
    // transformPayments pools a container's several per-row payment slots
    // into one row under the pooled shipment ref when it sees ≥2 distinct
    // raw refs sharing that owner — but transformShipments pools a
    // Container-N-<SKU> row into a pooled shipment even when it's the ONLY
    // row for that container (no minimum group size there), and payments
    // have no `sku` field to make that same single-row judgment at transform
    // time. So a lone payment row for a genuinely (but singly) pooled
    // container keeps its own raw ref, which never matches shipmentIdByRef's
    // pooled key — resolved here with the same raw-first/normalized-fallback
    // pattern already used for transaction matching below: try the payment's
    // own ref directly, and only if that fails, try the pooled-owner
    // candidate.
    for (const [paymentIdx, payment] of transformedPayments.entries()) {
      const poId = payment.poNumber ? poIdByNumber.get(payment.poNumber) : undefined;
      const resolvedShipmentRef = payment.shipmentRef ? resolveShipmentOwnerRef(payment.shipmentRef, shipmentRefs, pooledOwnerRefs) : null;
      const shipmentId = resolvedShipmentRef ? shipmentIdByRef.get(resolvedShipmentRef) : undefined;
      const ownerRef = (payment.poNumber ?? resolvedShipmentRef)!;
      if (poId === undefined && shipmentId === undefined) {
        runtimeSkippedPayments.push({
          rowIndex: paymentIdx,
          reason: `unresolved owner "${(payment.poNumber ?? payment.shipmentRef)!}" — referenced PO/shipment was not migrated (likely quarantined)`,
        });
        continue;
      }
      const created = await createExpectedPayment(
        {
          poId,
          shipmentId,
          sequenceNo: payment.sequenceNo,
          expectedAmount: payment.expectedAmount,
          expectedDate: payment.expectedDate,
          currency: payment.currency,
        },
        tx,
      );
      if (payment.paid) {
        // A paid: true with no paidDate is already quarantined by
        // transformPayments before this point, so paidDate is always set here.
        await markPaymentPaidCore(
          created.id,
          {
            amount: payment.expectedAmount,
            fxRate: "1",
            paidDate: payment.paidDate!,
            reasonCategory: "other",
            reasonNote: "migrated from Control Tower",
            changedBy: migrationUserId,
          },
          tx,
        );
        counts.paidPayments++;
      }
      const list = paymentsByOwner.get(ownerRef) ?? [];
      list.push({
        id: created.id,
        sequenceNo: payment.sequenceNo,
        amount: parseFloat(payment.expectedAmount),
        paid: payment.paid,
        paidAmount: payment.paid ? parseFloat(payment.expectedAmount) : null,
        matched: false,
      });
      paymentsByOwner.set(ownerRef, list);
    }

    // 4. Transactions, then transfer of the Sheet's human match hints (never
    //    inferred). This is a genuine adaptation, not a straight port: this
    //    migration deliberately does NOT call server/payments.ts's exported
    //    matchTransactionToPayment(transactionId, paymentId, opts) function,
    //    for two independent reasons, either one of which would be enough:
    //      (a) it takes no dbClient parameter at all — it always opens its
    //          own db.transaction() — so calling it from in here would run
    //          on a separate pooled connection that cannot see this
    //          transaction's own uncommitted writes (the payments/
    //          transactions just inserted above) and would sit outside this
    //          transaction's rollback boundary entirely;
    //      (b) it also enforces a strict one-payment↔one-transaction
    //          invariant (it throws if a payment is already matched to a
    //          different transaction — see server/payments.test.ts's
    //          "rejects re-matching a payment already linked to a different
    //          transaction"). The validated instalment-transfer rule below
    //          deliberately links SEVERAL transactions to ONE payment (e.g.
    //          two partial wires settling one PO instalment), which that
    //          guard exists specifically to prevent for live, human-driven
    //          usage.
    //    So this migration writes transactions.matchedPaymentId directly on
    //    `tx`, and handles the paid/paidAmount side itself via
    //    markPaymentPaidCore (exported from server/payments.ts specifically
    //    for this — it already accepts a dbClient), giving full control over
    //    amount/date for instalment sums and variance-only updates. See
    //    task-6-report.md for the full reasoning.
    const hinted: { txIdx: number; id: number; ref: string; baseAmount: number; date: Date }[] = [];
    for (const [txIdx, txRow] of transformedTransactions.entries()) {
      const created = await recordTransaction(
        {
          date: txRow.date,
          amount: txRow.amount,
          currency: txRow.currency,
          fxRate: txRow.fxRate,
          counterparty: txRow.counterparty,
          description: txRow.description,
        },
        tx,
      );
      if (txRow.matchedRef) {
        hinted.push({ txIdx, id: created.id, ref: txRow.matchedRef, baseAmount: parseFloat(txRow.amount) * parseFloat(txRow.fxRate), date: txRow.date });
      }
    }
    const reject = (h: { txIdx: number; ref: string }, reason: string) => unmatchedManualLinks.push({ transactionIndex: h.txIdx, ref: h.ref, reason });
    const withinPct = (payment: { amount: number }, amount: number, pct: number) => Math.abs(payment.amount - amount) <= pct * payment.amount;
    const withinExact = (payment: { amount: number }, amount: number) => withinPct(payment, amount, MATCH_TOLERANCE_EXACT);
    const withinVariance = (payment: { amount: number }, amount: number) => withinPct(payment, amount, MATCH_TOLERANCE_VARIANCE);
    // Paid slots are preferred candidates; an unpaid slot is still a valid
    // target — the link is the Sheet's own statement that it was paid.
    const byPreference = (a: Candidate, b: Candidate) => Number(b.paid) - Number(a.paid) || a.id - b.id;

    /** Record the settlement: link the transaction(s), mark an unpaid slot paid from them, and store the amount actually paid. */
    const settle = async (target: Candidate, ref: string, members: { id: number; baseAmount: number; date: Date }[]) => {
      const total = members.reduce((a, h) => a + h.baseAmount, 0);
      const lastDate = members.map((h) => h.date).sort((a, b) => a.getTime() - b.getTime())[members.length - 1];
      const inferred = !target.paid;
      if (inferred) {
        await markPaymentPaidCore(
          target.id,
          { amount: total.toFixed(2), fxRate: "1", paidDate: lastDate, reasonCategory: "payment_timing", reasonNote: "paid per Control Tower transaction link", changedBy: migrationUserId },
          tx,
        );
        counts.paidPayments++;
      } else if (Math.abs((target.paidAmount ?? target.amount) - total) > 0.005) {
        await tx.update(payments).set({ paidAmount: total.toFixed(2), baseCurrencyAmount: total.toFixed(2) }).where(eq(payments.id, target.id));
        await logChange(
          {
            entityType: "payment",
            entityId: target.id,
            field: "paidAmount",
            oldValue: (target.paidAmount ?? target.amount).toFixed(2),
            newValue: total.toFixed(2),
            reasonCategory: "payment_timing",
            reasonNote: "amount actually paid per Control Tower transaction link",
            changedBy: migrationUserId,
          },
          tx,
        );
      }
      // Link every member transaction to the target payment directly — see
      // the note above on why matchTransactionToPayment isn't used here.
      for (const h of members) {
        await tx.update(transactions).set({ matchedPaymentId: target.id }).where(eq(transactions.id, h.id));
        counts.matchedTransactions++;
      }
      target.matched = true;
      target.paid = true;
      target.paidAmount = total;
      const variancePct = Math.abs(target.amount - total) / target.amount;
      if (inferred || variancePct > MATCH_TOLERANCE_EXACT) {
        linkVariances.push({ ref, sequenceNo: target.sequenceNo, expectedAmount: target.amount, paidAmount: total, variancePct, paidInferredFromLink: inferred });
      }
    };

    // A matched_ref is resolved RAW first — a real, legitimately-unpooled
    // shipment ref (transformShipments' own SKU cross-check may deliberately
    // leave a Container-N-looking ref standalone, e.g. "PO1-Wave1-
    // Container9-Notes") must resolve directly, never rewritten. Only when
    // the raw ref doesn't resolve on its own is the pooled-owner
    // normalization (collapsing a per-SKU container-line hint, or several
    // comma-separated lines of the SAME container, to the pooled owner ref)
    // tried as a fallback — this mirrors the source branch's ea7d1b3
    // normalizeMatchRef, but decided HERE rather than at the transform
    // layer, because only runMigration holds shipmentIdByRef/paymentsByOwner,
    // the actual ground truth for which refs are real pooled owners.
    const resolvesDirectly = (r: string) => paymentsByOwner.has(r) || shipmentRefs.has(r);
    const normalizeRef = (r: string) =>
      [...new Set(r.split(",").map((p) => p.trim()).filter(Boolean).map((p) => pooledPaymentOwnerRef(p, pooledOwnerRefs)))].join(", ");
    const resolveRef = (raw: string): string => (resolvesDirectly(raw) ? raw : normalizeRef(raw));

    // Group by the RESOLVED ref, not the raw one — two transactions naming
    // different per-SKU spellings of the SAME pooled container (e.g. one
    // "...Container2-JELLO", another "...Container2-STRAW") must land in ONE
    // group so the instalment-subset pass below can match them together;
    // grouping by raw ref first would keep them in two separate one-
    // transaction groups that each fail the exact/variance passes alone.
    const byResolvedRef = new Map<string, typeof hinted>();
    for (const h of hinted) {
      const resolved = resolveRef(h.ref);
      byResolvedRef.set(resolved, [...(byResolvedRef.get(resolved) ?? []), h]);
    }
    for (const [ref, group] of byResolvedRef) {
      if (ref.includes(",")) {
        for (const h of group) reject(h, "several refs on one transaction — the platform links one transaction to one payment");
        continue;
      }
      const candidates = paymentsByOwner.get(ref);
      if (!candidates) {
        const reason = shipmentRefs.has(ref) ? "shipment has no payment slots on the Sheet" : "no migrated PO or shipment with this ref";
        for (const h of group) reject(h, reason);
        continue;
      }
      const ordered = () => candidates.filter((p) => !p.matched).sort(byPreference);
      // Pass 1: one transaction ↔ one payment, exact tolerance.
      let remaining: typeof group = [];
      for (const h of group) {
        const target = ordered().find((p) => withinExact(p, h.baseAmount));
        if (target) await settle(target, ref, [h]);
        else remaining.push(h);
      }
      // Pass 2: instalments — the closest subset of leftovers equals one payment (exact tolerance).
      while (remaining.length > 1) {
        const subset = findInstalmentSubset(remaining, ordered(), withinExact);
        if (!subset) break;
        await settle(subset.target, ref, subset.members);
        remaining = remaining.filter((h) => !subset.members.includes(h));
      }
      // Pass 3: variance tier — FX drift or partial payment, one ↔ one.
      const stillLeft: typeof group = [];
      for (const h of remaining) {
        const target = ordered().find((p) => withinVariance(p, h.baseAmount));
        if (target) await settle(target, ref, [h]);
        else stillLeft.push(h);
      }
      for (const h of stillLeft) {
        reject(h, `no unmatched payment on ${ref} within ${MATCH_TOLERANCE_VARIANCE * 100}% of ${h.baseAmount.toFixed(2)}`);
      }
    }

    // 5. Sales plan (forecast rows; no audit trail on creation, like every other create)
    for (const entry of salesPlanEntries) {
      await createSalesPlanEntry(
        {
          skuId: await ensureSku(entry.sku),
          warehouseId: await ensureWarehouse(entry.warehouseCode),
          periodDate: dateKey(entry.date),
          plannedQty: entry.qty,
        },
        tx,
      );
    }

    // 6. Inventory ledger events from ledgerRows (receipts in the real export;
    //    any event type in the generic path), chronologically
    for (const event of ledgerEvents) {
      const skuId = await ensureSku(event.sku);
      const warehouseId = await ensureWarehouse(event.warehouseCode);
      await recordLedgerEvent(
        {
          skuId,
          warehouseId,
          eventType: event.eventType,
          qty: event.eventType === "sale" ? -Math.abs(event.qty) : event.qty,
          unitCost: event.eventType === "receipt" ? String(event.unitCost) : null,
          date: event.date,
          sourceRef: event.sourceRef,
        },
        tx,
      );
    }

    // 7. Sales actuals — after every receipt exists, so the negative-stock guard
    //    (strict instances) sees the true SOH as of each sale's date. Written
    //    through recordSalesActual so sales_actuals and the ledger stay paired.
    for (const [saleIdx, sale] of salesActualEvents.entries()) {
      const skuId = await ensureSku(sale.sku);
      const warehouseId = await ensureWarehouse(sale.warehouseCode);
      try {
        await recordSalesActual({ skuId, warehouseId, date: dateKey(sale.date), qty: sale.qty, source: "manual" }, tx);
      } catch (err) {
        // A refused sale (strict instance driving SOH negative) is a real
        // finding, not a reason to abandon the run — but it also means the
        // reconciliation gate below will fail, which rolls everything back.
        runtimeSkippedSales.push({ rowIndex: saleIdx, reason: (err as Error).message });
      }
    }

    // 8. Reconciliation gate — inside the transaction, so a failure here rolls back everything above.
    const gate = await reconcileMigration(
      input.sheetTotals,
      {
        getMigratedSoh: async (sku, warehouseCode) => {
          const skuId = skuByCode.get(sku);
          const warehouseId = warehouseByCode.get(warehouseCode);
          if (skuId === undefined || warehouseId === undefined) return null;
          return getSoh(skuId, warehouseId, undefined, tx);
        },
      },
      input.landedCostTotals ?? [],
      {
        getMigratedLandedCost: async (shipmentRef, sku) => {
          const shipmentId = shipmentIdByRef.get(shipmentRef);
          const skuId = skuByCode.get(sku);
          if (shipmentId === undefined || skuId === undefined) return Number.NaN;
          const line = (await getShipmentLandedUnitCost(shipmentId, tx)).find((l) => l.skuId === skuId);
          return line ? line.landedUnitCost : Number.NaN;
        },
      },
      { landedCostTolerance: options.landedCostTolerance },
    );
    if (!gate.passed) {
      throw new Error(`migration reconciliation failed: ${JSON.stringify(gate.mismatches)}`);
    }
  });

  return {
    quarantined: {
      ledger: skippedLedger,
      purchaseOrders: skippedPos,
      shipments: [...skippedShipments, ...runtimeSkippedShipments],
      payments: [...skippedPayments, ...runtimeSkippedPayments],
      transactions: skippedTransactions,
      salesActuals: [...skippedSalesActuals, ...runtimeSkippedSales],
      salesPlan: skippedSalesPlan,
    },
    unmatchedManualLinks,
    linkVariances,
    counts,
  };
}

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}
