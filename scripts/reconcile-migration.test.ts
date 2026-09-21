import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../server/dbClient";
import { eq } from "drizzle-orm";
import { skus, vendors, warehouses, purchaseOrders, poLineItems, shipments, shipmentLineItems, payments, transactions, inventoryLedger, salesActuals, salesPlan, changeLog, appSettings, users } from "../drizzle/schema";
import { runMigration } from "./reconcile-migration";
import { setAppSetting } from "../server/db";
import { ALLOW_BACKORDERS_SETTING } from "../server/inventoryLedger";

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
  // (createdBy is a real FK now) — clean it up too so each test starts fresh.
  await db.delete(users);
});

describe("runMigration (widened scope)", () => {
  it("imports POs, shipments, payments, and transactions in one pass, in FK-respecting order", async () => {
    await runMigration({
      ledgerRows: [{ sku: "JELLO-CAL-500", warehouse: "FF-DE", event_type: "receipt", qty: "1000", unit_cost: "0.42", date: "2026-06-16", source_ref: "PO1-W1" }],
      poRows: [{ po_number: "PO3-JELLO", vendor_name: "Lvmengkang", vendor_reference: "LVM-INV-1", status: "confirmed", sku: "JELLO-CAL-500", qty: "1000", unit_price: "0.15", currency: "USD" }],
      shipmentRows: [],
      paymentRows: [{ po_number: "PO3-JELLO", sequence_no: "1", expected_amount: "150.00", expected_date: "2026-09-09", currency: "USD" }],
      transactionRows: [{ date: "2026-09-09", amount: "150.00", currency: "USD", fx_rate: "0.93", counterparty: "Lvmengkang", description: "PO3 Pay1" }],
      sheetTotals: [{ sku: "JELLO-CAL-500", warehouseCode: "FF-DE", sohFromSheet: 1000 }],
    });

    const pos = await db.select().from(purchaseOrders);
    expect(pos).toHaveLength(1);
    expect(pos[0].vendorReference).toBe("LVM-INV-1");
    const pays = await db.select().from(payments);
    expect(pays).toHaveLength(1);
    const txs = await db.select().from(transactions);
    expect(txs[0].matchedPaymentId).toBeNull();
  });

  it("rolls back the entire migration if any part fails partway through", async () => {
    await expect(
      runMigration({
        ledgerRows: [{ sku: "JELLO-CAL-500", warehouse: "FF-DE", event_type: "receipt", qty: "1000", unit_cost: "0.42", date: "2026-06-16", source_ref: "PO1-W1" }],
        poRows: [{ po_number: "PO3-JELLO", vendor_name: "Lvmengkang", vendor_reference: "", status: "confirmed", sku: "JELLO-CAL-500", qty: "1000", unit_price: "0.15", currency: "USD" }],
        shipmentRows: [],
        paymentRows: [],
        transactionRows: [],
        // deliberately wrong SOH to force the reconciliation gate to fail after inserts have already run
        sheetTotals: [{ sku: "JELLO-CAL-500", warehouseCode: "FF-DE", sohFromSheet: 999999 }],
      }),
    ).rejects.toThrow();

    const pos = await db.select().from(purchaseOrders);
    expect(pos).toHaveLength(0); // nothing committed
  });

  it("reports quarantined rows without aborting the rows that are valid", async () => {
    const result = await runMigration({
      ledgerRows: [],
      poRows: [
        { po_number: "PO3-JELLO", vendor_name: "Lvmengkang", vendor_reference: "", status: "confirmed", sku: "JELLO-CAL-500", qty: "1000", unit_price: "0.15", currency: "USD" },
        { po_number: "PO4-BAD", vendor_name: "X", vendor_reference: "", status: "not_a_status", sku: "JELLO-CAL-500", qty: "1", unit_price: "0.15", currency: "USD" },
      ],
      shipmentRows: [],
      paymentRows: [],
      transactionRows: [],
      sheetTotals: [],
    });

    expect(result.quarantined.purchaseOrders).toHaveLength(1);
    const pos = await db.select().from(purchaseOrders);
    expect(pos).toHaveLength(1);
  });

  // Finding 1 (superseded): landed-cost reconciliation used to throw whenever
  // landedCostTotals was non-empty ("not yet wired to a real data source").
  // That guard is gone now that this wires to the platform's own
  // getShipmentLandedUnitCost — the tests below assert the real gate runs.
  it("runs the landed-cost gate against the platform's own per-line landed cost and rolls back on a mismatch", async () => {
    const base = {
      ledgerRows: [],
      poRows: [{ po_number: "PO1", vendor_name: "Lvmengkang", vendor_reference: "", status: "closed", sku: "JELLO", qty: "1000", unit_price: "1.10", currency: "EUR" }],
      shipmentRows: [{ shipment_ref: "PO1-W1", vendor_reference: "", status: "delivered", warehouse: "FF-DE", freight_cost: "500.00", duty_cost: "100.00", cost_currency: "EUR", po_line_item_ref: "PO1::JELLO", sku: "JELLO", qty: "1000", weight_share: "1", value_share: "1" }],
      paymentRows: [],
      transactionRows: [],
      sheetTotals: [],
    };
    // (1.10 * 1000 + 500 + 100) / 1000 = 1.70; default tolerance is max(0.01, 0.1%) = 0.01
    await expect(
      runMigration({ ...base, landedCostTotals: [{ shipmentRef: "PO1-W1", sku: "JELLO", landedCostFromSheet: 1.75 }] }),
    ).rejects.toThrow(/landed_cost/);
    expect(await db.select().from(shipments)).toHaveLength(0);

    await runMigration({ ...base, landedCostTotals: [{ shipmentRef: "PO1-W1", sku: "JELLO", landedCostFromSheet: 1.7 }] });
    expect(await db.select().from(shipments)).toHaveLength(1);
  });

  it("treats a landed-cost target for a line the platform cannot cost as a mismatch, not a pass", async () => {
    await expect(
      runMigration({
        ledgerRows: [],
        poRows: [{ po_number: "PO1", vendor_name: "V", vendor_reference: "", status: "closed", sku: "JELLO", qty: "10", unit_price: "1", currency: "EUR" }],
        shipmentRows: [],
        paymentRows: [],
        transactionRows: [],
        sheetTotals: [],
        landedCostTotals: [{ shipmentRef: "NOPE", sku: "JELLO", landedCostFromSheet: 1 }],
      }),
    ).rejects.toThrow(/landed_cost/);
  });

  it("does not throw when landedCostTotals is omitted or empty", async () => {
    await expect(
      runMigration({
        ledgerRows: [],
        poRows: [],
        shipmentRows: [],
        paymentRows: [],
        transactionRows: [],
        sheetTotals: [],
        landedCostTotals: [],
      }),
    ).resolves.toBeDefined();
  });

  it("transfers paid flags with their dates and writes change_log rows on the same transaction", async () => {
    const result = await runMigration({
      ledgerRows: [],
      poRows: [{ po_number: "PO1", vendor_name: "V", vendor_reference: "", status: "closed", sku: "JELLO", qty: "10", unit_price: "1", currency: "EUR" }],
      shipmentRows: [],
      paymentRows: [
        { po_number: "PO1", sequence_no: "1", expected_amount: "100.00", expected_date: "2026-05-11", currency: "EUR", paid: "TRUE", paid_date: "2026-05-12" },
        { po_number: "PO1", sequence_no: "2", expected_amount: "50.00", expected_date: "2026-06-28", currency: "EUR", paid: "FALSE", paid_date: "" },
      ],
      transactionRows: [],
      sheetTotals: [],
    });
    expect(result.counts.paidPayments).toBe(1);
    const rows = await db.select().from(payments);
    const p1 = rows.find((p) => p.sequenceNo === 1)!;
    expect(p1).toMatchObject({ paid: true, paidAmount: "100.0000", baseCurrencyAmount: "100.0000", fxRate: "1.000000" });
    expect(p1.paidDate?.toISOString().slice(0, 10)).toBe("2026-05-12");
    expect(rows.find((p) => p.sequenceNo === 2)).toMatchObject({ paid: false, paidDate: null });
    const log = await db.select().from(changeLog).where(eq(changeLog.entityId, p1.id));
    expect(log.map((l) => l.field).sort()).toEqual(["fxRate", "paid", "paidAmount"]);
    expect(log[0].reasonNote).toBe("migrated from Control Tower");
  });

  it("quarantines a payment marked paid with no paid_date instead of reaching the write step", async () => {
    const result = await runMigration({
      ledgerRows: [],
      poRows: [{ po_number: "PO1", vendor_name: "V", vendor_reference: "", status: "closed", sku: "JELLO", qty: "10", unit_price: "1", currency: "EUR" }],
      shipmentRows: [],
      paymentRows: [{ po_number: "PO1", sequence_no: "1", expected_amount: "100.00", expected_date: "2026-05-11", currency: "EUR", paid: "TRUE" }],
      transactionRows: [],
      sheetTotals: [],
    });
    expect(result.quarantined.payments.map((q) => q.reason)).toEqual([expect.stringContaining("paid without a paid_date")]);
    expect(await db.select().from(payments)).toHaveLength(0);
  });

  it("transfers a human match hint to that PO's paid payment, and reports hints it cannot transfer", async () => {
    const result = await runMigration({
      ledgerRows: [],
      poRows: [{ po_number: "PO1", vendor_name: "V", vendor_reference: "", status: "closed", sku: "JELLO", qty: "10", unit_price: "1", currency: "EUR" }],
      shipmentRows: [{ shipment_ref: "PO1-W1", vendor_reference: "", status: "delivered", warehouse: "FF-DE", freight_cost: "", duty_cost: "", cost_currency: "EUR", po_line_item_ref: "PO1::JELLO", sku: "JELLO", qty: "10", weight_share: "1", value_share: "1" }],
      paymentRows: [
        { po_number: "PO1", sequence_no: "1", expected_amount: "100.00", expected_date: "2026-05-11", currency: "EUR", paid: "TRUE", paid_date: "2026-05-12" },
        { po_number: "PO1", sequence_no: "2", expected_amount: "300.00", expected_date: "2026-06-28", currency: "EUR", paid: "FALSE", paid_date: "" },
      ],
      transactionRows: [
        { date: "2026-05-12", amount: "116.28", currency: "USD", fx_rate: "0.86", counterparty: "V", description: "pay1", matched_ref: "PO1" }, // ~100.00 EUR
        { date: "2026-06-28", amount: "300.00", currency: "EUR", fx_rate: "1", counterparty: "V", description: "pay2", matched_ref: "PO1" }, // only unpaid slot left
        { date: "2026-07-01", amount: "10.00", currency: "EUR", fx_rate: "1", counterparty: "F", description: "freight", matched_ref: "PO1-W1" },
        { date: "2026-07-02", amount: "10.00", currency: "EUR", fx_rate: "1", counterparty: "F", description: "split", matched_ref: "PO1, PO1-W1" },
        { date: "2026-07-03", amount: "10.00", currency: "EUR", fx_rate: "1", counterparty: "F", description: "unknown", matched_ref: "PO9" },
      ],
      sheetTotals: [],
    });
    expect(result.counts.matchedTransactions).toBe(2);
    const txs = await db.select().from(transactions);
    const rows = await db.select().from(payments);
    const paid = rows.find((p) => p.sequenceNo === 1)!;
    const second = rows.find((p) => p.sequenceNo === 2)!;
    expect(txs.find((t) => t.description === "pay1")?.matchedPaymentId).toBe(paid.id);
    // slot 2 was unpaid on the Sheet; the link records it as paid from the transaction
    expect(txs.find((t) => t.description === "pay2")?.matchedPaymentId).toBe(second.id);
    expect(second).toMatchObject({ paid: true, paidAmount: "300.0000" });
    expect(second.paidDate?.toISOString().slice(0, 10)).toBe("2026-06-28");
    expect(result.linkVariances).toEqual([{ ref: "PO1", sequenceNo: 2, expectedAmount: 300, paidAmount: 300, variancePct: 0, paidInferredFromLink: true }]);
    expect(txs.filter((t) => t.matchedPaymentId !== null)).toHaveLength(2);
    expect(result.unmatchedManualLinks.map((u) => [u.ref, u.reason])).toEqual([
      ["PO1-W1", expect.stringContaining("shipment has no payment slots")],
      ["PO1, PO1-W1", expect.stringContaining("several refs")],
      ["PO9", expect.stringContaining("no migrated PO or shipment")],
    ]);
  });

  it("migrates shipment-owned payments and transfers a link to a shipment ref", async () => {
    const result = await runMigration({
      ledgerRows: [],
      poRows: [{ po_number: "PO1", vendor_name: "V", vendor_reference: "", status: "closed", sku: "JELLO", qty: "10", unit_price: "1", currency: "EUR" }],
      shipmentRows: [{ shipment_ref: "PO1-W3", vendor_reference: "", status: "delivered", warehouse: "FF-DE", freight_cost: "", duty_cost: "", cost_currency: "EUR", po_line_item_ref: "PO1::JELLO", sku: "JELLO", qty: "10", weight_share: "1", value_share: "1" }],
      paymentRows: [
        { po_number: "", shipment_ref: "PO1-W3", sequence_no: "1", expected_amount: "19056.71", expected_date: "2026-07-21", currency: "EUR", paid: "TRUE", paid_date: "2026-07-21" },
        { po_number: "", shipment_ref: "NOPE", sequence_no: "1", expected_amount: "1.00", expected_date: "2026-07-21", currency: "EUR", paid: "FALSE", paid_date: "" },
        { po_number: "PO1", shipment_ref: "PO1-W3", sequence_no: "1", expected_amount: "1.00", expected_date: "2026-07-21", currency: "EUR" },
      ],
      transactionRows: [{ date: "2026-07-21", amount: "19056.71", currency: "EUR", fx_rate: "1", counterparty: "F", description: "freight", matched_ref: "PO1-W3" }],
      sheetTotals: [],
    });
    const [shipment] = await db.select().from(shipments);
    const rows = await db.select().from(payments);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ shipmentId: shipment.id, poId: null, paid: true });
    expect((await db.select().from(transactions))[0].matchedPaymentId).toBe(rows[0].id);
    expect(result.counts.matchedTransactions).toBe(1);
    expect(result.quarantined.payments.map((q) => q.reason)).toEqual([
      expect.stringContaining("exactly one of po_number / shipment_ref"),
      expect.stringContaining('unresolved owner "NOPE"'),
    ]);
  });

  it("sums a pooled container's several per-row payment slots into the pooled shipment's own payment sequence", async () => {
    const shipmentRows = [
      { shipment_ref: "PO1-Wave4-Container2-JELLO", vendor_reference: "", status: "delivered", warehouse: "FF-DE", freight_cost: "600", duty_cost: "0", cost_currency: "EUR", po_line_item_ref: "PO1::JELLO", sku: "JELLO", qty: "10", weight_share: "0.5", value_share: "0.5" },
      { shipment_ref: "PO1-Wave4-Container2-STRAW", vendor_reference: "", status: "delivered", warehouse: "FF-DE", freight_cost: "600", duty_cost: "0", cost_currency: "EUR", po_line_item_ref: "PO1::STRAW", sku: "STRAW", qty: "10", weight_share: "0.5", value_share: "0.5" },
    ];
    const result = await runMigration({
      ledgerRows: [],
      poRows: [
        { po_number: "PO1", vendor_name: "V", vendor_reference: "", status: "closed", sku: "JELLO", qty: "10", unit_price: "1", currency: "EUR" },
        { po_number: "PO1", vendor_name: "V", vendor_reference: "", status: "closed", sku: "STRAW", qty: "10", unit_price: "1", currency: "EUR" },
      ],
      shipmentRows,
      paymentRows: [
        { po_number: "", shipment_ref: "PO1-Wave4-Container2-JELLO", sequence_no: "1", expected_amount: "300.00", expected_date: "2026-07-21", currency: "EUR", paid: "TRUE", paid_date: "2026-07-21" },
        { po_number: "", shipment_ref: "PO1-Wave4-Container2-STRAW", sequence_no: "1", expected_amount: "300.00", expected_date: "2026-07-21", currency: "EUR", paid: "TRUE", paid_date: "2026-07-21" },
      ],
      transactionRows: [],
      sheetTotals: [],
    });
    const shipmentRows2 = await db.select().from(shipments);
    expect(shipmentRows2).toHaveLength(1);
    expect(shipmentRows2[0].shipmentRef).toBe("PO1-Wave4-Container2");
    const rows = await db.select().from(payments);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ shipmentId: shipmentRows2[0].id, sequenceNo: 1, expectedAmount: "600.0000", paid: true, paidAmount: "600.0000" });
    expect(result.quarantined.payments).toEqual([]);
  });

  it("quarantines a pooled container's payment rows when they disagree on paid status instead of silently summing", async () => {
    const shipmentRows = [
      { shipment_ref: "PO1-Wave4-Container2-JELLO", vendor_reference: "", status: "delivered", warehouse: "FF-DE", freight_cost: "600", duty_cost: "0", cost_currency: "EUR", po_line_item_ref: "PO1::JELLO", sku: "JELLO", qty: "10", weight_share: "0.5", value_share: "0.5" },
      { shipment_ref: "PO1-Wave4-Container2-STRAW", vendor_reference: "", status: "delivered", warehouse: "FF-DE", freight_cost: "600", duty_cost: "0", cost_currency: "EUR", po_line_item_ref: "PO1::STRAW", sku: "STRAW", qty: "10", weight_share: "0.5", value_share: "0.5" },
    ];
    const result = await runMigration({
      ledgerRows: [],
      poRows: [
        { po_number: "PO1", vendor_name: "V", vendor_reference: "", status: "closed", sku: "JELLO", qty: "10", unit_price: "1", currency: "EUR" },
        { po_number: "PO1", vendor_name: "V", vendor_reference: "", status: "closed", sku: "STRAW", qty: "10", unit_price: "1", currency: "EUR" },
      ],
      shipmentRows,
      paymentRows: [
        { po_number: "", shipment_ref: "PO1-Wave4-Container2-JELLO", sequence_no: "1", expected_amount: "300.00", expected_date: "2026-07-21", currency: "EUR", paid: "TRUE", paid_date: "2026-07-21" },
        { po_number: "", shipment_ref: "PO1-Wave4-Container2-STRAW", sequence_no: "1", expected_amount: "300.00", expected_date: "2026-07-21", currency: "EUR", paid: "FALSE", paid_date: "" },
      ],
      transactionRows: [],
      sheetTotals: [],
    });
    expect(result.quarantined.payments).toHaveLength(2);
    expect(result.quarantined.payments[0].reason).toContain("disagree on paid");
    expect(await db.select().from(payments)).toHaveLength(0);
  });

  it("transfers a payment settled in several transactions when together they equal one paid payment", async () => {
    const result = await runMigration({
      ledgerRows: [],
      poRows: [{ po_number: "PO1", vendor_name: "V", vendor_reference: "", status: "closed", sku: "JELLO", qty: "10", unit_price: "1", currency: "EUR" }],
      shipmentRows: [],
      paymentRows: [
        { po_number: "PO1", sequence_no: "1", expected_amount: "171271.88", expected_date: "2026-05-11", currency: "EUR", paid: "TRUE", paid_date: "2026-05-11" },
        { po_number: "PO1", sequence_no: "2", expected_amount: "65939.00", expected_date: "2026-06-28", currency: "EUR", paid: "TRUE", paid_date: "2026-06-28" },
      ],
      transactionRows: [
        { date: "2026-05-11", amount: "159271.88", currency: "EUR", fx_rate: "1", counterparty: "V", description: "part 1", matched_ref: "PO1" },
        { date: "2026-06-08", amount: "12000.00", currency: "EUR", fx_rate: "1", counterparty: "V", description: "part 2", matched_ref: "PO1" },
        { date: "2026-06-28", amount: "65939.00", currency: "EUR", fx_rate: "1", counterparty: "V", description: "second", matched_ref: "PO1" },
        { date: "2026-07-01", amount: "5.00", currency: "EUR", fx_rate: "1", counterparty: "V", description: "stray", matched_ref: "PO1" },
      ],
      sheetTotals: [],
    });
    const rows = await db.select().from(payments);
    const p1 = rows.find((p) => p.sequenceNo === 1)!;
    const p2 = rows.find((p) => p.sequenceNo === 2)!;
    const txs = await db.select().from(transactions);
    expect(txs.find((t) => t.description === "part 1")?.matchedPaymentId).toBe(p1.id);
    expect(txs.find((t) => t.description === "part 2")?.matchedPaymentId).toBe(p1.id);
    expect(txs.find((t) => t.description === "second")?.matchedPaymentId).toBe(p2.id);
    expect(txs.find((t) => t.description === "stray")?.matchedPaymentId).toBeNull();
    expect(result.counts.matchedTransactions).toBe(3);
    expect(result.unmatchedManualLinks).toEqual([{ transactionIndex: 3, ref: "PO1", reason: expect.stringContaining("no unmatched payment on PO1 within 5%") }]);
    expect(result.linkVariances).toEqual([]);
  });

  it("transfers a link within 5% (FX drift / partial payment) and records the amount actually paid", async () => {
    const result = await runMigration({
      ledgerRows: [],
      poRows: [{ po_number: "PO2 Straw", vendor_name: "V", vendor_reference: "", status: "closed", sku: "STRAW", qty: "10", unit_price: "1", currency: "EUR" }],
      shipmentRows: [],
      paymentRows: [
        { po_number: "PO2 Straw", sequence_no: "1", expected_amount: "569.83", expected_date: "2026-07-06", currency: "EUR", paid: "TRUE", paid_date: "2026-07-06" },
        { po_number: "PO2 Straw", sequence_no: "2", expected_amount: "2279.32", expected_date: "2026-08-10", currency: "EUR", paid: "FALSE", paid_date: "" },
      ],
      transactionRows: [
        { date: "2026-07-06", amount: "682", currency: "USD", fx_rate: "0.875700", counterparty: "V", description: "fx drift", matched_ref: "PO2 Straw" },
        { date: "2026-09-01", amount: "2000.00", currency: "EUR", fx_rate: "1", counterparty: "V", description: "too far", matched_ref: "PO2 Straw" },
      ],
      sheetTotals: [],
    });
    const p1 = (await db.select().from(payments)).find((p) => p.sequenceNo === 1)!;
    expect(p1.paid).toBe(true);
    const log = await db.select().from(changeLog).where(eq(changeLog.entityId, p1.id));
    expect(log.find((l) => l.field === "paidAmount" && l.oldValue === "569.83")?.newValue).toBe("597.23");
    expect(result.linkVariances).toEqual([{ ref: "PO2 Straw", sequenceNo: 1, expectedAmount: 569.83, paidAmount: expect.closeTo(597.23, 2), variancePct: expect.closeTo(0.048, 2), paidInferredFromLink: false }]);
    expect(result.unmatchedManualLinks).toEqual([{ transactionIndex: 1, ref: "PO2 Straw", reason: expect.stringContaining("within 5% of 2000.00") }]);
  });

  it("writes sales actuals to both sales_actuals and the ledger, and rolls both back together", async () => {
    await setAppSetting(ALLOW_BACKORDERS_SETTING, "true");
    const base = {
      ledgerRows: [{ sku: "JELLO", warehouse: "FF", event_type: "receipt", qty: "100", unit_cost: "2", date: "2026-07-06", source_ref: "PO1-W1" }],
      poRows: [],
      shipmentRows: [],
      paymentRows: [],
      transactionRows: [],
      salesActualRows: [
        { sku: "JELLO", warehouse: "FF", date: "2026-06-16", qty: "30" }, // backorder before landing
        { sku: "JELLO", warehouse: "FF", date: "2026-07-07", qty: "20" },
      ],
      salesPlanRows: [{ sku: "JELLO", warehouse: "FF", date: "2026-07-13", qty: "25" }],
    };
    await expect(runMigration({ ...base, sheetTotals: [{ sku: "JELLO", warehouseCode: "FF", sohFromSheet: 999 }] })).rejects.toThrow(/reconciliation failed/);
    expect(await db.select().from(salesActuals)).toHaveLength(0);
    expect(await db.select().from(inventoryLedger)).toHaveLength(0);

    const result = await runMigration({ ...base, sheetTotals: [{ sku: "JELLO", warehouseCode: "FF", sohFromSheet: 50 }] });
    expect(result.quarantined.salesActuals).toEqual([]);
    expect(await db.select().from(salesActuals)).toHaveLength(2);
    expect((await db.select().from(inventoryLedger)).map((e) => e.qty).sort((a, b) => a - b)).toEqual([-30, -20, 100]);
    expect(await db.select().from(salesPlan)).toHaveLength(1);
  });

  it("quarantines (and then fails the gate on) a backorder sale when the instance is strict", async () => {
    await expect(
      runMigration({
        ledgerRows: [{ sku: "JELLO", warehouse: "FF", event_type: "receipt", qty: "100", unit_cost: "2", date: "2026-07-06", source_ref: "PO1-W1" }],
        poRows: [],
        shipmentRows: [],
        paymentRows: [],
        transactionRows: [],
        salesActualRows: [{ sku: "JELLO", warehouse: "FF", date: "2026-06-16", qty: "30" }],
        sheetTotals: [{ sku: "JELLO", warehouseCode: "FF", sohFromSheet: 70 }],
      }),
    ).rejects.toThrow(/reconciliation failed/);
  });

  it("persists shipment history dates and customs status", async () => {
    await runMigration({
      ledgerRows: [],
      poRows: [{ po_number: "PO1", vendor_name: "V", vendor_reference: "", status: "closed", sku: "JELLO", qty: "10", unit_price: "1", currency: "EUR" }],
      shipmentRows: [{ shipment_ref: "PO1-W1", vendor_reference: "", status: "delivered", warehouse: "FF-DE", freight_cost: "", duty_cost: "", cost_currency: "EUR", po_line_item_ref: "PO1::JELLO", sku: "JELLO", qty: "10", weight_share: "1", value_share: "1", planned_depart_date: "", actual_depart_date: "2026-06-23", planned_arrival_date: "2026-07-06", actual_arrival_date: "2026-07-06", customs_status: "cleared" }],
      paymentRows: [],
      transactionRows: [],
      sheetTotals: [],
    });
    const [s] = await db.select().from(shipments);
    expect(s.actualDepartDate?.toISOString().slice(0, 10)).toBe("2026-06-23");
    expect(s.plannedArrivalDate?.toISOString().slice(0, 10)).toBe("2026-07-06");
    expect(s.actualArrivalDate?.toISOString().slice(0, 10)).toBe("2026-07-06");
    expect(s.plannedDepartDate).toBeNull();
    expect(s.customsStatus).toBe("cleared");
  });

  // Finding 4: a receipt appearing after its corresponding sale in source row
  // order (but dated earlier) must still land in the ledger before the sale is
  // checked against SOH — otherwise the negative-stock guard spuriously fails.
  it("migrates ledger rows successfully even when given in reverse-chronological source order", async () => {
    const result = await runMigration({
      ledgerRows: [
        // sale row appears FIRST in the array, but its date is AFTER the receipt's date
        { sku: "JELLO-CAL-500", warehouse: "FF-DE", event_type: "sale", qty: "-30", unit_cost: "", date: "2026-09-02", source_ref: "shopify-2026-09-02" },
        { sku: "JELLO-CAL-500", warehouse: "FF-DE", event_type: "receipt", qty: "50", unit_cost: "0.42", date: "2026-09-01", source_ref: "PO1" },
      ],
      poRows: [],
      shipmentRows: [],
      paymentRows: [],
      transactionRows: [],
      sheetTotals: [{ sku: "JELLO-CAL-500", warehouseCode: "FF-DE", sohFromSheet: 20 }],
    });

    expect(result.quarantined.ledger).toEqual([]);
  });

  // Finding 5: a shipment referencing a PO line item that was never migrated
  // (its parent PO was quarantined) must be quarantined, not crash the run.
  it("quarantines a shipment whose po_line_item_ref never resolved, rather than crashing the whole migration", async () => {
    const result = await runMigration({
      ledgerRows: [],
      poRows: [],
      shipmentRows: [
        {
          shipment_ref: "PO1-W4-Container2",
          vendor_reference: "",
          status: "planned",
          warehouse: "FF-DE",
          freight_cost: "",
          duty_cost: "",
          cost_currency: "",
          po_line_item_ref: "PO1-DOES-NOT-EXIST::JELLO-CAL-500",
          sku: "JELLO-CAL-500",
          qty: "100",
          weight_share: "1.0",
          value_share: "1.0",
        },
      ],
      paymentRows: [],
      transactionRows: [],
      sheetTotals: [],
    });

    expect(result.quarantined.shipments).toHaveLength(1);
    expect(result.quarantined.shipments[0].reason).toContain("po_line_item_ref");
    const shipmentRows = await db.select().from(shipments);
    expect(shipmentRows).toHaveLength(0);
  });

  // Finding 5: a payment referencing a PO number that was never migrated must
  // be quarantined, not silently inserted with poId: NULL, orphaned.
  it("quarantines a payment whose po_number never resolved, rather than inserting a dangling reference", async () => {
    const result = await runMigration({
      ledgerRows: [],
      poRows: [],
      shipmentRows: [],
      paymentRows: [{ po_number: "PO-DOES-NOT-EXIST", sequence_no: "1", expected_amount: "100.00", expected_date: "2026-09-09", currency: "USD" }],
      transactionRows: [],
      sheetTotals: [],
    });

    expect(result.quarantined.payments).toHaveLength(1);
    expect(result.quarantined.payments[0].reason).toContain('unresolved owner "PO-DOES-NOT-EXIST"');
    const paymentRows = await db.select().from(payments);
    expect(paymentRows).toHaveLength(0);
  });

  // Finding 6: PO line items are zipped back to po.lineItems by explicit id
  // order, not assumed insertion order — a shipment referencing the second
  // line item of a multi-line PO must resolve to the correct line item.
  it("resolves a shipment's po_line_item_ref to the correct line item on a multi-line PO", async () => {
    await runMigration({
      ledgerRows: [],
      poRows: [
        { po_number: "PO1", vendor_name: "V", vendor_reference: "", status: "closed", sku: "JELLO", qty: "10", unit_price: "1", currency: "EUR" },
        { po_number: "PO1", vendor_name: "V", vendor_reference: "", status: "closed", sku: "STRAW", qty: "20", unit_price: "2", currency: "EUR" },
      ],
      shipmentRows: [{ shipment_ref: "PO1-W1", vendor_reference: "", status: "delivered", warehouse: "FF-DE", freight_cost: "", duty_cost: "", cost_currency: "EUR", po_line_item_ref: "PO1::STRAW", sku: "STRAW", qty: "20", weight_share: "1", value_share: "1" }],
      paymentRows: [],
      transactionRows: [],
      sheetTotals: [],
    });
    const lines = await db.select().from(shipmentLineItems);
    expect(lines).toHaveLength(1);
    const poLines = await db.select().from(poLineItems);
    const strawLine = poLines.find((l) => l.qty === 20)!;
    expect(lines[0].poLineItemId).toBe(strawLine.id);
  });
});
