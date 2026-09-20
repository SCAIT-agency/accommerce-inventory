import { eq } from "drizzle-orm";
import { db } from "../server/dbClient";
import { createSku, createWarehouse, createVendor, createUser, listSkus, listWarehouses, listVendors } from "../server/db";
import { users } from "../drizzle/schema";
import { recordLedgerEvent, getSoh } from "../server/inventoryLedger";
import { createPurchaseOrder, getPurchaseOrderWithLineItems } from "../server/purchaseOrders";
import { createShipment } from "../server/shipments";
import { createExpectedPayment, recordTransaction } from "../server/payments";
import {
  transformSheetExport,
  transformPurchaseOrders,
  transformShipments,
  transformPayments,
  transformTransactions,
  reconcileMigration,
  type SheetExportRow,
  type PoSheetRow,
  type ShipmentSheetRow,
  type PaymentSheetRow,
  type TransactionSheetRow,
  type SkuWarehouseTotal,
  type SkippedRow,
  type LandedCostTotal,
} from "./migrate-from-sheet";

export interface RunMigrationInput {
  ledgerRows: SheetExportRow[];
  poRows: PoSheetRow[];
  shipmentRows: ShipmentSheetRow[];
  paymentRows: PaymentSheetRow[];
  transactionRows: TransactionSheetRow[];
  sheetTotals: SkuWarehouseTotal[];
  landedCostTotals?: LandedCostTotal[];
}

export interface RunMigrationResult {
  quarantined: {
    ledger: SkippedRow[];
    purchaseOrders: SkippedRow[];
    shipments: SkippedRow[];
    payments: SkippedRow[];
    transactions: SkippedRow[];
  };
}

export async function runMigration(input: RunMigrationInput): Promise<RunMigrationResult> {
  // Finding 1: landed-cost reconciliation isn't wired to a real data source yet
  // (real Control Tower Sheet column names are unknown — see spec Open Questions).
  // Silently accepting landedCostTotals and running zero comparisons would look
  // like "Migration complete" while the check did nothing — fail loudly instead.
  if (input.landedCostTotals && input.landedCostTotals.length > 0) {
    throw new Error(
      "runMigration: landedCostTotals was provided but landed-cost reconciliation is not yet wired to a real " +
      "data source (real Control Tower Sheet column names are unknown — see spec Open Questions). Pass an empty " +
      "array or omit landedCostTotals until this is implemented.",
    );
  }

  const { ledgerEvents, skipped: skippedLedger } = transformSheetExport(input.ledgerRows);
  // Finding 4: sort ledger events chronologically before replay — the negative-stock
  // guard checks SOH "as of" each event's own date, so a receipt appearing after its
  // corresponding sale in source row order (but dated earlier) must still be applied
  // to the ledger before that sale is checked.
  ledgerEvents.sort((a, b) => a.date.getTime() - b.date.getTime());
  const { purchaseOrders: transformedPos, skipped: skippedPos } = transformPurchaseOrders(input.poRows);
  const { shipments: transformedShipments, skipped: skippedShipments } = transformShipments(input.shipmentRows);
  const { payments: transformedPayments, skipped: skippedPayments } = transformPayments(input.paymentRows);
  const { transactions: transformedTransactions, skipped: skippedTransactions } = transformTransactions(input.transactionRows);
  // Finding 5: runtime (not row-parse-time) quarantines — resolved only once
  // cross-entity references (PO line items, PO numbers) are known, inside the
  // transaction below.
  const runtimeSkippedShipments: SkippedRow[] = [];
  const runtimeSkippedPayments: SkippedRow[] = [];

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

    // 2. Shipments + shipment line items
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
      await createShipment(
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
    }

    // 3. Payments
    // Finding 5: a payment referencing a PO number that wasn't migrated is
    // quarantined instead of silently inserting with poId: NULL, orphaned.
    for (const [paymentIdx, payment] of transformedPayments.entries()) {
      const poId = poIdByNumber.get(payment.poNumber);
      if (poId === undefined) {
        runtimeSkippedPayments.push({
          rowIndex: paymentIdx,
          reason: `unresolved po_number "${payment.poNumber}" — referenced PO was not migrated (likely quarantined)`,
        });
        continue;
      }
      await createExpectedPayment(
        {
          poId,
          sequenceNo: payment.sequenceNo,
          expectedAmount: payment.expectedAmount,
          expectedDate: payment.expectedDate,
          currency: payment.currency,
        },
        tx,
      );
    }

    // 4. Transactions (migrated as unmatched — see transformTransactions)
    for (const txRow of transformedTransactions) {
      await recordTransaction(
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
    }

    // 5. Inventory ledger events (must come after SKUs/warehouses above exist)
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

    // 6. Reconciliation gate — inside the transaction, so a failure here rolls back everything above.
    // landedCostTotals is guaranteed empty here (guarded and thrown on above if non-empty).
    const soakResult = await reconcileMigration(
      input.sheetTotals,
      {
        getMigratedSoh: async (sku, warehouseCode) => {
          const skuId = skuByCode.get(sku)!;
          const warehouseId = warehouseByCode.get(warehouseCode)!;
          return getSoh(skuId, warehouseId, undefined, tx);
        },
      },
      [],
    );
    if (!soakResult.passed) {
      throw new Error(`migration reconciliation failed: ${JSON.stringify(soakResult.mismatches)}`);
    }
  });

  return {
    quarantined: {
      ledger: skippedLedger,
      purchaseOrders: skippedPos,
      shipments: [...skippedShipments, ...runtimeSkippedShipments],
      payments: [...skippedPayments, ...runtimeSkippedPayments],
      transactions: skippedTransactions,
    },
  };
}
