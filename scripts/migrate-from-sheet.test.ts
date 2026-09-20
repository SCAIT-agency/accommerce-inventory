import { describe, it, expect } from "vitest";
import {
  transformSheetExport,
  reconcileMigration,
  transformPurchaseOrders,
  transformShipments,
  transformPayments,
  transformTransactions,
} from "./migrate-from-sheet";

describe("transformSheetExport", () => {
  it("maps a Control Tower Inventory Ledger row into a normalized ledger event, keyed by SKU code and warehouse code", () => {
    const rows = [
      { sku: "JELLO-CAL-500", warehouse: "FF-DE", event_type: "receipt", qty: "1000", unit_cost: "0.42", date: "2026-06-16", source_ref: "PO1-W1" },
    ];
    const result = transformSheetExport(rows);
    expect(result.skipped).toEqual([]);
    expect(result.ledgerEvents).toEqual([
      { sku: "JELLO-CAL-500", warehouseCode: "FF-DE", eventType: "receipt", qty: 1000, unitCost: 0.42, date: new Date("2026-06-16"), sourceRef: "PO1-W1" },
    ]);
  });

  it("maps a sale row with a blank unit_cost (unitCost defaults to 0, not NaN)", () => {
    const rows = [
      { sku: "JELLO-CAL-500", warehouse: "FF-DE", event_type: "sale", qty: "-30", unit_cost: "", date: "2026-09-02", source_ref: "shopify-2026-09-02" },
    ];
    const result = transformSheetExport(rows);
    expect(result.skipped).toEqual([]);
    expect(result.ledgerEvents[0].unitCost).toBe(0);
  });

  it("quarantines a row with a garbage-suffixed qty instead of silently truncating it", () => {
    const rows = [
      { sku: "JELLO-CAL-500", warehouse: "FF-DE", event_type: "receipt", qty: "1000xyz", unit_cost: "0.42", date: "2026-06-16", source_ref: "PO1-W1" },
    ];
    const result = transformSheetExport(rows);
    expect(result.ledgerEvents).toEqual([]);
    expect(result.skipped).toEqual([{ rowIndex: 0, reason: expect.stringContaining("qty") }]);
  });

  it("quarantines a row with an invalid event_type instead of blindly casting it", () => {
    const rows = [
      { sku: "JELLO-CAL-500", warehouse: "FF-DE", event_type: "not_a_real_event_type", qty: "1000", unit_cost: "0.42", date: "2026-06-16", source_ref: "PO1-W1" },
    ];
    const result = transformSheetExport(rows);
    expect(result.ledgerEvents).toEqual([]);
    expect(result.skipped).toEqual([{ rowIndex: 0, reason: expect.stringContaining("event_type") }]);
  });
});

describe("reconcileMigration", () => {
  it("passes when migrated SOH matches the Sheet's totals for every SKU/warehouse", () => {
    const result = reconcileMigration(
      [{ sku: "JELLO-CAL-500", warehouseCode: "FF-DE", sohFromSheet: 150827 }],
      { getMigratedSoh: async () => 150827 },
    );
    return expect(result).resolves.toEqual({ passed: true, mismatches: [] });
  });

  it("fails a SKU/warehouse the migrated DB doesn't recognize, even when the Sheet also expects 0 — never a silent false match", () => {
    const result = reconcileMigration(
      [{ sku: "JELLO-UNKNOWN", warehouseCode: "FF-DE", sohFromSheet: 0 }],
      { getMigratedSoh: async () => null },
    );
    return expect(result).resolves.toEqual({
      passed: false,
      mismatches: [{ sku: "JELLO-UNKNOWN", warehouseCode: "FF-DE", expected: 0, actual: null, diff: null, kind: "soh" }],
    });
  });

  it("fails and lists the mismatch when migrated SOH diverges from the Sheet", () => {
    const result = reconcileMigration(
      [{ sku: "JELLO-CAL-500", warehouseCode: "FF-DE", sohFromSheet: 150827 }],
      { getMigratedSoh: async () => 150000 },
    );
    return expect(result).resolves.toEqual({
      passed: false,
      mismatches: [{ sku: "JELLO-CAL-500", warehouseCode: "FF-DE", expected: 150827, actual: 150000, diff: -827, kind: "soh" }],
    });
  });

  it("lists every mismatch, not just the first, when multiple SKU/warehouse totals diverge", () => {
    const result = reconcileMigration(
      [
        { sku: "JELLO-CAL-500", warehouseCode: "FF-DE", sohFromSheet: 150827 },
        { sku: "JELLO-CAL-500", warehouseCode: "MUTUAL-CH", sohFromSheet: 4200 },
        { sku: "JELLO-MAG-250", warehouseCode: "FF-DE", sohFromSheet: 900 },
      ],
      {
        getMigratedSoh: async (sku, warehouseCode) => {
          if (sku === "JELLO-CAL-500" && warehouseCode === "FF-DE") return 150000;
          if (sku === "JELLO-CAL-500" && warehouseCode === "MUTUAL-CH") return 4200;
          if (sku === "JELLO-MAG-250" && warehouseCode === "FF-DE") return 800;
          throw new Error("unexpected sku/warehouse");
        },
      },
    );
    return expect(result).resolves.toEqual({
      passed: false,
      mismatches: [
        { sku: "JELLO-CAL-500", warehouseCode: "FF-DE", expected: 150827, actual: 150000, diff: -827, kind: "soh" },
        { sku: "JELLO-MAG-250", warehouseCode: "FF-DE", expected: 900, actual: 800, diff: -100, kind: "soh" },
      ],
    });
  });

  it("passes a landed-cost mismatch within tolerance (0.1% or $0.01, whichever is greater)", async () => {
    const result = await reconcileMigration(
      [],
      { getMigratedSoh: async () => 0 },
      [{ sku: "JELLO-CAL-500", warehouseCode: "FF-DE", landedCostFromSheet: 1000.0 }],
      { getMigratedLandedCost: async () => 1000.5 }, // 0.05% off — within the 0.1% tolerance
    );
    expect(result.passed).toBe(true);
  });

  it("fails a landed-cost mismatch beyond tolerance, tagged as a landed_cost mismatch", async () => {
    const result = await reconcileMigration(
      [],
      { getMigratedSoh: async () => 0 },
      [{ sku: "JELLO-CAL-500", warehouseCode: "FF-DE", landedCostFromSheet: 1000.0 }],
      { getMigratedLandedCost: async () => 1010.0 }, // 1% off — beyond tolerance
    );
    expect(result.passed).toBe(false);
    expect(result.mismatches[0].kind).toBe("landed_cost");
  });
});

describe("transformPurchaseOrders", () => {
  it("maps a well-formed row, including the vendor reference and a non-draft historical status", () => {
    const rows = [
      { po_number: "PO3-JELLO", vendor_name: "Lvmengkang", vendor_reference: "LVM-INV-2026-0912", status: "shipped", sku: "JELLO-CAL-500", qty: "200000", unit_price: "0.15", currency: "USD" },
    ];
    const result = transformPurchaseOrders(rows);
    expect(result.skipped).toEqual([]);
    expect(result.purchaseOrders).toEqual([
      {
        poNumber: "PO3-JELLO",
        vendorName: "Lvmengkang",
        vendorReference: "LVM-INV-2026-0912",
        initialStatus: "shipped",
        lineItems: [{ sku: "JELLO-CAL-500", qty: 200000, unitPrice: "0.15", currency: "USD" }],
      },
    ]);
  });

  it("groups multiple line-item rows under the same PO number into one PO with several line items", () => {
    const rows = [
      { po_number: "PO3-JELLO", vendor_name: "Lvmengkang", vendor_reference: "", status: "draft", sku: "JELLO-CAL-500", qty: "1000", unit_price: "0.15", currency: "USD" },
      { po_number: "PO3-JELLO", vendor_name: "Lvmengkang", vendor_reference: "", status: "draft", sku: "JELLO-MIX-250", qty: "500", unit_price: "0.20", currency: "USD" },
    ];
    const result = transformPurchaseOrders(rows);
    expect(result.purchaseOrders).toHaveLength(1);
    expect(result.purchaseOrders[0].lineItems).toHaveLength(2);
  });

  it("quarantines a row with an invalid status instead of throwing", () => {
    const rows = [
      { po_number: "PO3-JELLO", vendor_name: "Lvmengkang", vendor_reference: "", status: "not_a_real_status", sku: "JELLO-CAL-500", qty: "200000", unit_price: "0.15", currency: "USD" },
    ];
    const result = transformPurchaseOrders(rows);
    expect(result.purchaseOrders).toEqual([]);
    expect(result.skipped).toEqual([{ rowIndex: 0, reason: expect.stringContaining("status") }]);
  });

  it("quarantines a row with a garbage-suffixed qty instead of silently truncating it", () => {
    const rows = [
      { po_number: "PO3-JELLO", vendor_name: "Lvmengkang", vendor_reference: "", status: "draft", sku: "JELLO-CAL-500", qty: "200000xyz", unit_price: "0.15", currency: "USD" },
    ];
    const result = transformPurchaseOrders(rows);
    expect(result.purchaseOrders).toEqual([]);
    expect(result.skipped).toEqual([{ rowIndex: 0, reason: expect.stringContaining("qty") }]);
  });
});

describe("transformShipments", () => {
  it("maps a well-formed row with cost fields and a final historical status", () => {
    const rows = [
      { shipment_ref: "PO1-W4-Container2", vendor_reference: "MBS-DEBIT-SZDN26080711", status: "delivered", freight_cost: "4200.00", duty_cost: "980.00", cost_currency: "EUR", po_line_item_ref: "PO1-W4::JELLO-CAL-500", sku: "JELLO-CAL-500", qty: "45000", weight_share: "0.5", value_share: "0.5" },
    ];
    const result = transformShipments(rows);
    expect(result.skipped).toEqual([]);
    expect(result.shipments[0]).toMatchObject({
      shipmentRef: "PO1-W4-Container2",
      vendorReference: "MBS-DEBIT-SZDN26080711",
      initialStatus: "delivered",
      freightCost: "4200.00",
      dutyCost: "980.00",
      costCurrency: "EUR",
    });
  });

  it("quarantines a row missing its shipment_ref", () => {
    const rows = [{ shipment_ref: "", vendor_reference: "", status: "planned", freight_cost: "", duty_cost: "", cost_currency: "", po_line_item_ref: "x", sku: "JELLO-CAL-500", qty: "1", weight_share: "1.0", value_share: "1.0" }];
    const result = transformShipments(rows);
    expect(result.shipments).toEqual([]);
    expect(result.skipped[0].reason).toContain("shipment_ref");
  });
});

describe("transformPayments", () => {
  it("maps a well-formed payment row", () => {
    const rows = [
      { po_number: "PO3-JELLO", sequence_no: "1", expected_amount: "30746.70", expected_date: "2026-09-09", currency: "USD" },
    ];
    const result = transformPayments(rows);
    expect(result.skipped).toEqual([]);
    expect(result.payments[0]).toMatchObject({ poNumber: "PO3-JELLO", sequenceNo: 1, expectedAmount: "30746.70", currency: "USD" });
  });

  it("quarantines a row with a non-numeric expected amount", () => {
    const rows = [{ po_number: "PO3-JELLO", sequence_no: "1", expected_amount: "not-a-number", expected_date: "2026-09-09", currency: "USD" }];
    const result = transformPayments(rows);
    expect(result.payments).toEqual([]);
    expect(result.skipped[0].reason).toContain("expected_amount");
  });

  it("quarantines a row with a non-numeric sequence_no instead of writing NaN", () => {
    const rows = [{ po_number: "PO3-JELLO", sequence_no: "abc", expected_amount: "30746.70", expected_date: "2026-09-09", currency: "USD" }];
    const result = transformPayments(rows);
    expect(result.payments).toEqual([]);
    expect(result.skipped[0].reason).toContain("sequence_no");
  });
});

describe("transformTransactions", () => {
  it("maps a well-formed transaction row as unmatched, regardless of any match hint in the source", () => {
    const rows = [
      { date: "2026-09-09", amount: "30746.70", currency: "USD", fx_rate: "0.93", counterparty: "Lvmengkang", description: "PO3 Jello Pay1", matched_po_number_hint: "PO3-JELLO" },
    ];
    const result = transformTransactions(rows);
    expect(result.skipped).toEqual([]);
    expect(result.transactions[0]).toMatchObject({ amount: "30746.70", currency: "USD", counterparty: "Lvmengkang" });
    expect(result.transactions[0]).not.toHaveProperty("matchedPaymentId");
  });

  it("quarantines a row with an unparseable date", () => {
    const rows = [{ date: "not-a-date", amount: "100.00", currency: "USD", fx_rate: "0.93", counterparty: "Test", description: "" }];
    const result = transformTransactions(rows);
    expect(result.transactions).toEqual([]);
    expect(result.skipped[0].reason).toContain("date");
  });

  it("quarantines a row with a garbage-suffixed amount instead of silently truncating it", () => {
    const rows = [{ date: "2026-09-09", amount: "100abc", currency: "USD", fx_rate: "0.93", counterparty: "Test", description: "" }];
    const result = transformTransactions(rows);
    expect(result.transactions).toEqual([]);
    expect(result.skipped[0].reason).toContain("amount");
  });
});
