// server/controlTowerDecimalMigration.test.ts
//
// New test (not a port): Backlog Stream J's decimal-column migration
// (decimal(18,4/6) -> decimal(18,8)/decimal(9,8) on poLineItems.unitPrice,
// inventoryLedger.unitCost, and shipmentLineItems.weightShare/valueShare)
// postdates the source branch this Control Tower migration path was ported
// from, so no existing test proves the migration path itself survives those
// columns at their real, current full precision. server/decimalMigration.test.ts
// already proves the same columns round-trip when written through their own
// direct helper functions (recordLedgerEvent, createShipment, ...) — this
// test proves the same thing end-to-end through the actual migration entry
// point, runMigration (scripts/reconcile-migration.ts), which is what the
// real Control Tower cutover will actually call.
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "./dbClient";
import {
  skus,
  vendors,
  warehouses,
  purchaseOrders,
  poLineItems,
  shipments,
  shipmentLineItems,
  payments,
  transactions,
  inventoryLedger,
  salesActuals,
  salesPlan,
  changeLog,
  appSettings,
  users,
} from "../drizzle/schema";
import { runMigration } from "../scripts/reconcile-migration";

beforeEach(async () => {
  await db.delete(changeLog);
  await db.delete(appSettings);
  await db.delete(salesActuals);
  await db.delete(salesPlan);
  await db.delete(inventoryLedger);
  await db.delete(transactions);
  await db.delete(payments);
  await db.delete(shipmentLineItems);
  await db.delete(shipments);
  await db.delete(poLineItems);
  await db.delete(purchaseOrders);
  await db.delete(skus);
  await db.delete(vendors);
  await db.delete(warehouses);
  // runMigration attributes migrated rows to a get-or-create system user
  // (createdBy is a real FK) — clean it up too so each test starts fresh.
  await db.delete(users);
});

describe("runMigration decimal round-trip at real column precision", () => {
  it("survives a realistic PO+payment / shipment+costs / transaction migration with every decimal field at its column's real full scale", async () => {
    // Values below are deliberately written at each column's actual current
    // scale (read from drizzle/schema.ts, not assumed):
    //   poLineItems.unitPrice          decimal(18,8) -> 8dp
    //   inventoryLedger.unitCost       decimal(18,8) -> 8dp
    //   shipmentLineItems.weightShare  decimal(9,8)  -> 8dp (1 integer digit; shares are always <=1)
    //   shipmentLineItems.valueShare   decimal(9,8)  -> 8dp
    //   shipments.freightCost/dutyCost decimal(18,4) -> 4dp (unchanged this session)
    //   payments.expectedAmount        decimal(18,4) -> written at 3dp deliberately, to also
    //                                                    exercise MySQL's zero-pad-on-read-back
    //                                                    behavior on an unwidened column, same as
    //                                                    server/decimalMigration.test.ts already does
    //   payments.fxRate                decimal(12,6) -> runMigration always writes "1" for a
    //                                                    migrated paid slot, itself a real zero-pad case
    //   transactions.amount            decimal(18,4) -> 4dp
    //   transactions.fxRate            decimal(12,6) -> 6dp
    //
    // inventoryLedger.unitCost specifically also has to survive runMigration's
    // own parseFloat(unit_cost) -> String(...) round-trip inside
    // transformSheetExport / step 6 of runMigration (unlike the other three,
    // which are passed through as raw strings, never parsed as a JS number) —
    // "7.63541298" was checked to round-trip exactly through parseFloat/String
    // before being used here.
    const result = await runMigration({
      ledgerRows: [
        {
          sku: "SKU-DECIMAL-9",
          warehouse: "WH-DECIMAL-9",
          event_type: "receipt",
          qty: "500",
          unit_cost: "7.63541298",
          date: "2026-01-18",
          source_ref: "SHIP-DECIMAL-9",
        },
      ],
      poRows: [
        {
          po_number: "PO-DECIMAL-9",
          vendor_name: "Vendor Decimal Test",
          vendor_reference: "",
          status: "confirmed",
          sku: "SKU-DECIMAL-9",
          qty: "500",
          unit_price: "45.19283746",
          currency: "USD",
        },
      ],
      shipmentRows: [
        {
          shipment_ref: "SHIP-DECIMAL-9",
          vendor_reference: "",
          status: "delivered",
          warehouse: "WH-DECIMAL-9",
          freight_cost: "18453.6217",
          duty_cost: "2145.9834",
          cost_currency: "USD",
          po_line_item_ref: "PO-DECIMAL-9::SKU-DECIMAL-9",
          sku: "SKU-DECIMAL-9",
          qty: "500",
          weight_share: "0.41398277",
          value_share: "0.58601723",
        },
      ],
      paymentRows: [
        {
          po_number: "PO-DECIMAL-9",
          sequence_no: "1",
          expected_amount: "24689.123",
          expected_date: "2026-01-15",
          currency: "USD",
          paid: "TRUE",
          paid_date: "2026-01-20",
        },
      ],
      transactionRows: [
        {
          date: "2026-01-20",
          amount: "5432.1098",
          currency: "USD",
          fx_rate: "0.860000",
          counterparty: "Test Bank Wire",
          description: "decimal round-trip test transaction",
        },
      ],
      // Empty on purpose: this test proves the migration path's decimal
      // columns round-trip exactly, not the reconciliation gate itself
      // (that's scripts/reconcile-migration.test.ts's job) — an empty
      // sheetTotals/landedCostTotals makes the gate a trivial pass.
      sheetTotals: [],
      landedCostTotals: [],
    });

    // Nothing quarantined, nothing rejected — every row above migrated clean.
    expect(result.quarantined.ledger).toHaveLength(0);
    expect(result.quarantined.purchaseOrders).toHaveLength(0);
    expect(result.quarantined.shipments).toHaveLength(0);
    expect(result.quarantined.payments).toHaveLength(0);
    expect(result.quarantined.transactions).toHaveLength(0);
    expect(result.unmatchedManualLinks).toHaveLength(0);
    expect(result.counts.paidPayments).toBe(1);

    const [poLine] = await db.select().from(poLineItems);
    expect(poLine.unitPrice).toBe("45.19283746");

    const [shipmentLine] = await db.select().from(shipmentLineItems);
    expect(shipmentLine.weightShare).toBe("0.41398277");
    expect(shipmentLine.valueShare).toBe("0.58601723");

    const [shipment] = await db.select().from(shipments);
    expect(shipment.freightCost).toBe("18453.6217");
    expect(shipment.dutyCost).toBe("2145.9834");

    const [ledgerRow] = await db.select().from(inventoryLedger);
    expect(ledgerRow.unitCost).toBe("7.63541298");

    const [payment] = await db.select().from(payments);
    // Written at 3dp into a decimal(18,4) column -> zero-padded to 4dp on read-back.
    expect(payment.expectedAmount).toBe("24689.1230");
    expect(payment.paidAmount).toBe("24689.1230");
    // runMigration always settles a migrated paid slot at fxRate "1" -> zero-padded to 6dp.
    expect(payment.fxRate).toBe("1.000000");
    // (24689.123 * 1).toFixed(2) = "24689.12" -> zero-padded to 4dp.
    expect(payment.baseCurrencyAmount).toBe("24689.1200");

    const [transaction] = await db.select().from(transactions);
    expect(transaction.amount).toBe("5432.1098");
    expect(transaction.fxRate).toBe("0.860000");

    // Sanity: every row landed against the one SKU/warehouse/PO/shipment this
    // test seeded, not some accidental duplicate from a prior run leaking in.
    const [sku] = await db.select().from(skus).where(eq(skus.sku, "SKU-DECIMAL-9"));
    expect(poLine.skuId).toBe(sku.id);
    expect(ledgerRow.skuId).toBe(sku.id);
  });
});
