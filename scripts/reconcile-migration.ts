import { db } from "../server/dbClient";
import { createSku, createWarehouse, createVendor, listSkus, listWarehouses, listVendors } from "../server/db";
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
  const { ledgerEvents } = transformSheetExport(input.ledgerRows);
  const { purchaseOrders: transformedPos, skipped: skippedPos } = transformPurchaseOrders(input.poRows);
  const { shipments: transformedShipments, skipped: skippedShipments } = transformShipments(input.shipmentRows);
  const { payments: transformedPayments, skipped: skippedPayments } = transformPayments(input.paymentRows);
  const { transactions: transformedTransactions, skipped: skippedTransactions } = transformTransactions(input.transactionRows);

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
          createdBy: 1,
        },
        tx,
      );
      poIdByNumber.set(po.poNumber, created.id);
      const withItems = await getPurchaseOrderWithLineItems(created.id, tx);
      withItems.lineItems.forEach((li, idx) => {
        poLineItemIdByRef.set(`${po.poNumber}::${po.lineItems[idx].sku}`, li.id);
      });
    }

    // 2. Shipments + shipment line items
    for (const shipment of transformedShipments) {
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
          freightCost: shipment.freightCost ?? undefined,
          dutyCost: shipment.dutyCost ?? undefined,
          costCurrency: shipment.costCurrency ?? undefined,
          lineItems,
          createdBy: 1,
        },
        tx,
      );
    }

    // 3. Payments
    for (const payment of transformedPayments) {
      await createExpectedPayment(
        {
          poId: poIdByNumber.get(payment.poNumber),
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
    const soakResult = await reconcileMigration(
      input.sheetTotals,
      {
        getMigratedSoh: async (sku, warehouseCode) => {
          const skuId = skuByCode.get(sku)!;
          const warehouseId = warehouseByCode.get(warehouseCode)!;
          return getSoh(skuId, warehouseId, undefined, tx);
        },
      },
      input.landedCostTotals ?? [],
    );
    if (!soakResult.passed) {
      throw new Error(`migration reconciliation failed: ${JSON.stringify(soakResult.mismatches)}`);
    }
  });

  return {
    quarantined: {
      ledger: [],
      purchaseOrders: skippedPos,
      shipments: skippedShipments,
      payments: skippedPayments,
      transactions: skippedTransactions,
    },
  };
}
