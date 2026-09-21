import { describe, it, expect } from "vitest";
import {
  transformSheetExport,
  reconcileMigration,
  transformPurchaseOrders,
  transformShipments,
  transformPayments,
  transformTransactions,
  transformSalesActuals,
  transformSalesPlan,
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

  it("anchors a migrated sale row at end-of-day, matching recordSalesActual's live-code convention — receipts keep their given date as-is", () => {
    const rows = [
      { sku: "JELLO-CAL-500", warehouse: "FF-DE", event_type: "sale", qty: "-30", unit_cost: "", date: "2026-09-02", source_ref: "shopify-2026-09-02" },
      { sku: "JELLO-CAL-500", warehouse: "FF-DE", event_type: "receipt", qty: "1000", unit_cost: "0.42", date: "2026-09-02", source_ref: "PO1-W1" },
    ];
    const result = transformSheetExport(rows);
    expect(result.skipped).toEqual([]);
    expect(result.ledgerEvents[0].date).toEqual(new Date("2026-09-02T23:59:59.999Z"));
    expect(result.ledgerEvents[1].date).toEqual(new Date("2026-09-02"));
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
      [{ shipmentRef: "PO1-W1", sku: "JELLO-CAL-500", landedCostFromSheet: 1000.0 }],
      { getMigratedLandedCost: async () => 1000.5 }, // 0.05% off — within the 0.1% tolerance
    );
    expect(result.passed).toBe(true);
  });

  it("fails a landed-cost mismatch beyond tolerance, tagged as a landed_cost mismatch", async () => {
    const result = await reconcileMigration(
      [],
      { getMigratedSoh: async () => 0 },
      [{ shipmentRef: "PO1-W1", sku: "JELLO-CAL-500", landedCostFromSheet: 1000.0 }],
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
      { shipment_ref: "PO1-W4-Container2", vendor_reference: "MBS-DEBIT-SZDN26080711", status: "delivered", warehouse: "FF-DE", freight_cost: "4200.00", duty_cost: "980.00", cost_currency: "EUR", po_line_item_ref: "PO1-W4::JELLO-CAL-500", sku: "JELLO-CAL-500", qty: "45000", weight_share: "0.5", value_share: "0.5" },
    ];
    const result = transformShipments(rows);
    expect(result.skipped).toEqual([]);
    expect(result.shipments[0]).toMatchObject({
      shipmentRef: "PO1-W4-Container2",
      vendorReference: "MBS-DEBIT-SZDN26080711",
      initialStatus: "delivered",
      warehouseCode: "FF-DE",
      freightCost: "4200.00",
      dutyCost: "980.00",
      costCurrency: "EUR",
    });
  });

  it("quarantines a row missing its shipment_ref", () => {
    const rows = [{ shipment_ref: "", vendor_reference: "", status: "planned", warehouse: "FF-DE", freight_cost: "", duty_cost: "", cost_currency: "", po_line_item_ref: "x", sku: "JELLO-CAL-500", qty: "1", weight_share: "1.0", value_share: "1.0" }];
    const result = transformShipments(rows);
    expect(result.shipments).toEqual([]);
    expect(result.skipped[0].reason).toContain("shipment_ref");
  });

  it("quarantines a row missing its warehouse", () => {
    const rows = [{ shipment_ref: "PO1-W4-Container2", vendor_reference: "", status: "planned", warehouse: "", freight_cost: "", duty_cost: "", cost_currency: "", po_line_item_ref: "x", sku: "JELLO-CAL-500", qty: "1", weight_share: "1.0", value_share: "1.0" }];
    const result = transformShipments(rows);
    expect(result.shipments).toEqual([]);
    expect(result.skipped[0].reason).toContain("warehouse");
  });

  it("carries through planned/actual depart/arrival dates and customs status when present", () => {
    const rows = [
      {
        shipment_ref: "PO1-W1", vendor_reference: "", status: "delivered", warehouse: "FF-DE",
        freight_cost: "100.00", duty_cost: "20.00", cost_currency: "EUR",
        po_line_item_ref: "PO1-W1::JELLO-CAL-500", sku: "JELLO-CAL-500", qty: "1000", weight_share: "1.0", value_share: "1.0",
        planned_depart_date: "2026-07-01", actual_depart_date: "2026-07-03", planned_arrival_date: "2026-07-20", actual_arrival_date: "2026-07-22",
        customs_status: "cleared",
      },
    ];
    const result = transformShipments(rows);
    expect(result.skipped).toEqual([]);
    expect(result.shipments[0]).toMatchObject({
      plannedDepartDate: new Date("2026-07-01"),
      actualDepartDate: new Date("2026-07-03"),
      plannedArrivalDate: new Date("2026-07-20"),
      actualArrivalDate: new Date("2026-07-22"),
      customsStatus: "cleared",
    });
  });

  it("defaults date fields and customsStatus to null when the Sheet leaves them blank", () => {
    const rows = [
      { shipment_ref: "PO1-W1", vendor_reference: "", status: "planned", warehouse: "FF-DE", freight_cost: "", duty_cost: "", cost_currency: "", po_line_item_ref: "PO1-W1::JELLO-CAL-500", sku: "JELLO-CAL-500", qty: "1000", weight_share: "1.0", value_share: "1.0" },
    ];
    const result = transformShipments(rows);
    expect(result.shipments[0]).toMatchObject({
      plannedDepartDate: null,
      actualDepartDate: null,
      plannedArrivalDate: null,
      actualArrivalDate: null,
      customsStatus: null,
    });
  });

  it("quarantines a row with an unparseable date field", () => {
    const rows = [
      { shipment_ref: "PO1-W1", vendor_reference: "", status: "planned", warehouse: "FF-DE", freight_cost: "", duty_cost: "", cost_currency: "", po_line_item_ref: "x", sku: "JELLO-CAL-500", qty: "1", weight_share: "1.0", value_share: "1.0", actual_depart_date: "not-a-date" },
    ];
    const result = transformShipments(rows);
    expect(result.shipments).toEqual([]);
    expect(result.skipped[0].reason).toContain("actualDepartDate");
  });

  it("quarantines a row with an unrecognized customs_status", () => {
    const rows = [
      { shipment_ref: "PO1-W1", vendor_reference: "", status: "planned", warehouse: "FF-DE", freight_cost: "", duty_cost: "", cost_currency: "", po_line_item_ref: "x", sku: "JELLO-CAL-500", qty: "1", weight_share: "1.0", value_share: "1.0", customs_status: "not_a_real_status" },
    ];
    const result = transformShipments(rows);
    expect(result.shipments).toEqual([]);
    expect(result.skipped[0].reason).toContain("customs_status");
  });

  it("merges two rows sharing the same shipment_ref into one shipment with two line items, when dates and warehouse agree", () => {
    const rows = [
      { shipment_ref: "Mutual-PO2-Delivered", vendor_reference: "", status: "delivered", warehouse: "MUTUAL-CH", freight_cost: "500.00", duty_cost: "80.00", cost_currency: "EUR", po_line_item_ref: "PO2::JELLO-CAL-500", sku: "JELLO-CAL-500", qty: "3240", weight_share: "0.8", value_share: "0.8", actual_arrival_date: "2026-08-01" },
      { shipment_ref: "Mutual-PO2-Delivered", vendor_reference: "", status: "delivered", warehouse: "MUTUAL-CH", freight_cost: "500.00", duty_cost: "80.00", cost_currency: "EUR", po_line_item_ref: "PO2::JELLO-MIX-250", sku: "JELLO-MIX-250", qty: "700", weight_share: "0.2", value_share: "0.2", actual_arrival_date: "2026-08-01" },
    ];
    const result = transformShipments(rows);
    expect(result.skipped).toEqual([]);
    expect(result.shipments).toHaveLength(1);
    expect(result.shipments[0].shipmentRef).toBe("Mutual-PO2-Delivered");
    expect(result.shipments[0].lineItems).toHaveLength(2);
    expect(result.shipments[0].lineItems.map((li) => li.sku)).toEqual(["JELLO-CAL-500", "JELLO-MIX-250"]);
  });

  it("quarantines every row of a group sharing a shipment_ref when they disagree on warehouse, with the conflict spelled out", () => {
    const rows = [
      { shipment_ref: "Mutual-PO2-Delivered", vendor_reference: "", status: "delivered", warehouse: "MUTUAL-CH", freight_cost: "500.00", duty_cost: "80.00", cost_currency: "EUR", po_line_item_ref: "PO2::JELLO-CAL-500", sku: "JELLO-CAL-500", qty: "3240", weight_share: "0.8", value_share: "0.8" },
      { shipment_ref: "Mutual-PO2-Delivered", vendor_reference: "", status: "delivered", warehouse: "FF-DE", freight_cost: "500.00", duty_cost: "80.00", cost_currency: "EUR", po_line_item_ref: "PO2::JELLO-MIX-250", sku: "JELLO-MIX-250", qty: "700", weight_share: "0.2", value_share: "0.2" },
    ];
    const result = transformShipments(rows);
    expect(result.shipments).toEqual([]);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped[0].reason).toContain("conflicting merge");
    expect(result.skipped[0].reason).toContain("warehouse");
    expect(result.skipped[0].reason).toContain("MUTUAL-CH");
    expect(result.skipped[0].reason).toContain("FF-DE");
  });

  it("merges pooled-container rows named <prefix>Container<N>-<SKU> into one shipment under the stripped prefix", () => {
    const rows = [
      { shipment_ref: "PO1-Wave4-Container2-Jello", vendor_reference: "", status: "delivered", warehouse: "FF-DE", freight_cost: "900.00", duty_cost: "150.00", cost_currency: "EUR", po_line_item_ref: "PO1::Jello", sku: "Jello", qty: "10000", weight_share: "0.5", value_share: "0.5", actual_arrival_date: "2026-08-15" },
      { shipment_ref: "PO1-Wave4-Container2-Mixer", vendor_reference: "", status: "delivered", warehouse: "FF-DE", freight_cost: "900.00", duty_cost: "150.00", cost_currency: "EUR", po_line_item_ref: "PO1::Mixer", sku: "Mixer", qty: "3000", weight_share: "0.3", value_share: "0.3", actual_arrival_date: "2026-08-15" },
      { shipment_ref: "PO1-Wave4-Container2-Straw", vendor_reference: "", status: "delivered", warehouse: "FF-DE", freight_cost: "900.00", duty_cost: "150.00", cost_currency: "EUR", po_line_item_ref: "PO1::Straw", sku: "Straw", qty: "2000", weight_share: "0.2", value_share: "0.2", actual_arrival_date: "2026-08-15" },
    ];
    const result = transformShipments(rows);
    expect(result.skipped).toEqual([]);
    expect(result.shipments).toHaveLength(1);
    expect(result.shipments[0].shipmentRef).toBe("PO1-Wave4-Container2");
    expect(result.shipments[0].lineItems).toHaveLength(3);
    expect(result.shipments[0].lineItems.map((li) => li.sku)).toEqual(["Jello", "Mixer", "Straw"]);
  });

  it("quarantines a pooled container's rows when one variant disagrees on actual arrival date — not silently merged wrong", () => {
    const rows = [
      { shipment_ref: "PO1-Wave4-Container2-Jello", vendor_reference: "", status: "delivered", warehouse: "FF-DE", freight_cost: "900.00", duty_cost: "150.00", cost_currency: "EUR", po_line_item_ref: "PO1::Jello", sku: "Jello", qty: "10000", weight_share: "0.5", value_share: "0.5", actual_arrival_date: "2026-08-15" },
      { shipment_ref: "PO1-Wave4-Container2-Mixer", vendor_reference: "", status: "delivered", warehouse: "FF-DE", freight_cost: "900.00", duty_cost: "150.00", cost_currency: "EUR", po_line_item_ref: "PO1::Mixer", sku: "Mixer", qty: "3000", weight_share: "0.3", value_share: "0.3", actual_arrival_date: "2026-08-16" },
    ];
    const result = transformShipments(rows);
    expect(result.shipments).toEqual([]);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped[0].reason).toContain("conflicting merge");
    expect(result.skipped[0].reason).toContain("actual_arrival_date");
    expect(result.skipped[0].reason).toContain("2026-08-15");
    expect(result.skipped[0].reason).toContain("2026-08-16");
  });

  it("does not pool a shipment_ref matching the Container<N> pattern when the suffix isn't that row's own sku", () => {
    const rows = [
      { shipment_ref: "PO1-Wave1-Container9-Notes", vendor_reference: "", status: "planned", warehouse: "FF-DE", freight_cost: "", duty_cost: "", cost_currency: "", po_line_item_ref: "x", sku: "JELLO-CAL-500", qty: "1", weight_share: "1.0", value_share: "1.0" },
    ];
    const result = transformShipments(rows);
    expect(result.skipped).toEqual([]);
    expect(result.shipments[0].shipmentRef).toBe("PO1-Wave1-Container9-Notes");
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

  it("maps paid=TRUE with a paid_date to paid: true and the parsed paidDate", () => {
    const rows = [
      { po_number: "PO3-JELLO", sequence_no: "1", expected_amount: "30746.70", expected_date: "2026-09-09", currency: "USD", paid: "TRUE", paid_date: "2026-09-10" },
    ];
    const result = transformPayments(rows);
    expect(result.skipped).toEqual([]);
    expect(result.payments[0]).toMatchObject({ paid: true, paidDate: new Date("2026-09-10") });
  });

  it("defaults paid to false and paidDate to null when the Sheet leaves them blank", () => {
    const rows = [{ po_number: "PO3-JELLO", sequence_no: "1", expected_amount: "30746.70", expected_date: "2026-09-09", currency: "USD" }];
    const result = transformPayments(rows);
    expect(result.payments[0]).toMatchObject({ paid: false, paidDate: null });
  });

  it("quarantines a row marked paid without a paid_date instead of defaulting silently", () => {
    const rows = [{ po_number: "PO3-JELLO", sequence_no: "1", expected_amount: "30746.70", expected_date: "2026-09-09", currency: "USD", paid: "TRUE" }];
    const result = transformPayments(rows);
    expect(result.payments).toEqual([]);
    expect(result.skipped[0].reason).toContain("paid_date");
  });

  it("quarantines a row with an unparseable paid_date", () => {
    const rows = [{ po_number: "PO3-JELLO", sequence_no: "1", expected_amount: "30746.70", expected_date: "2026-09-09", currency: "USD", paid: "TRUE", paid_date: "not-a-date" }];
    const result = transformPayments(rows);
    expect(result.payments).toEqual([]);
    expect(result.skipped[0].reason).toContain("paid_date");
  });

  it("maps a well-formed shipment-owned payment row (shipment_ref instead of po_number)", () => {
    const rows = [{ po_number: "", shipment_ref: "PO1-W3", sequence_no: "1", expected_amount: "19056.71", expected_date: "2026-07-21", currency: "EUR" }];
    const result = transformPayments(rows);
    expect(result.skipped).toEqual([]);
    expect(result.payments[0]).toMatchObject({ poNumber: null, shipmentRef: "PO1-W3", sequenceNo: 1, expectedAmount: "19056.71" });
  });

  it("quarantines a row that gives both po_number and shipment_ref", () => {
    const rows = [{ po_number: "PO1", shipment_ref: "PO1-W3", sequence_no: "1", expected_amount: "1.00", expected_date: "2026-07-21", currency: "EUR" }];
    const result = transformPayments(rows);
    expect(result.payments).toEqual([]);
    expect(result.skipped[0].reason).toContain("exactly one of po_number / shipment_ref");
  });

  it("quarantines a row that gives neither po_number nor shipment_ref", () => {
    const rows = [{ po_number: "", sequence_no: "1", expected_amount: "1.00", expected_date: "2026-07-21", currency: "EUR" }];
    const result = transformPayments(rows);
    expect(result.payments).toEqual([]);
    expect(result.skipped[0].reason).toContain("exactly one of po_number / shipment_ref");
  });

  it("sums a pooled container's per-row payment slots (same sequence) under the pooled shipment ref", () => {
    const rows = [
      { po_number: "", shipment_ref: "PO1-Wave4-Container2-JELLO", sequence_no: "1", expected_amount: "300.00", expected_date: "2026-07-21", currency: "EUR", paid: "TRUE", paid_date: "2026-07-21" },
      { po_number: "", shipment_ref: "PO1-Wave4-Container2-STRAW", sequence_no: "1", expected_amount: "300.00", expected_date: "2026-07-21", currency: "EUR", paid: "TRUE", paid_date: "2026-07-21" },
    ];
    const result = transformPayments(rows);
    expect(result.skipped).toEqual([]);
    expect(result.payments).toEqual([
      expect.objectContaining({ shipmentRef: "PO1-Wave4-Container2", sequenceNo: 1, expectedAmount: "600.00", paid: true }),
    ]);
  });

  it("quarantines a pooled group that disagrees on currency instead of silently summing across currencies", () => {
    const rows = [
      { po_number: "", shipment_ref: "PO1-Wave4-Container2-JELLO", sequence_no: "1", expected_amount: "300.00", expected_date: "2026-07-21", currency: "EUR" },
      { po_number: "", shipment_ref: "PO1-Wave4-Container2-STRAW", sequence_no: "1", expected_amount: "300.00", expected_date: "2026-07-21", currency: "USD" },
    ];
    const result = transformPayments(rows);
    expect(result.payments).toEqual([]);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped[0].reason).toContain("disagree on currency");
  });

  // Critical fix: a pooled group must never silently commit a partial (wrong)
  // amount because one sibling's field was individually invalid and dropped
  // before grouping. Here the STRAW sibling has a blank expected_date; the
  // whole group (both rows) must quarantine, and no payment row is produced
  // that carries only the JELLO row's 300.00 as if it were the full 600.00.
  it("quarantines the WHOLE pooled group when one sibling has a blank/invalid field, never a partial sum", () => {
    const rows = [
      { po_number: "", shipment_ref: "PO1-Wave4-Container2-JELLO", sequence_no: "1", expected_amount: "300.00", expected_date: "2026-07-21", currency: "EUR" },
      { po_number: "", shipment_ref: "PO1-Wave4-Container2-STRAW", sequence_no: "1", expected_amount: "300.00", expected_date: "", currency: "EUR" },
    ];
    const result = transformPayments(rows);
    expect(result.payments).toEqual([]);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped.map((s) => s.rowIndex).sort()).toEqual([0, 1]);
    expect(result.skipped[0].reason).toContain("disagree on expected_date");
  });

  it("quarantines the whole pooled group when one sibling's amount is unparseable, rather than summing only the valid one", () => {
    const rows = [
      { po_number: "", shipment_ref: "PO1-Wave4-Container2-JELLO", sequence_no: "1", expected_amount: "300.00", expected_date: "2026-07-21", currency: "EUR" },
      { po_number: "", shipment_ref: "PO1-Wave4-Container2-STRAW", sequence_no: "1", expected_amount: "garbage", expected_date: "2026-07-21", currency: "EUR" },
    ];
    const result = transformPayments(rows);
    expect(result.payments).toEqual([]);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped[0].reason).toContain("unparseable expected_amount");
  });

  // Important #1: expectedDate is a merge key too (matching SHIPMENT_MERGE_KEYS's
  // pattern of checking every relevant field) — a group disagreeing on the
  // planned date quarantines instead of silently taking the first row's date.
  it("quarantines a pooled group that disagrees on expected_date", () => {
    const rows = [
      { po_number: "", shipment_ref: "PO1-Wave4-Container2-JELLO", sequence_no: "1", expected_amount: "300.00", expected_date: "2026-07-21", currency: "EUR" },
      { po_number: "", shipment_ref: "PO1-Wave4-Container2-STRAW", sequence_no: "1", expected_amount: "300.00", expected_date: "2026-07-22", currency: "EUR" },
    ];
    const result = transformPayments(rows);
    expect(result.payments).toEqual([]);
    expect(result.skipped[0].reason).toContain("disagree on expected_date");
  });

  it("trims whitespace-only po_number the same as an empty one (XOR validation isn't defeated by whitespace)", () => {
    const rows = [{ po_number: "   ", shipment_ref: "PO1-W3", sequence_no: "1", expected_amount: "1.00", expected_date: "2026-07-21", currency: "EUR" }];
    const result = transformPayments(rows);
    expect(result.skipped).toEqual([]);
    expect(result.payments[0]).toMatchObject({ poNumber: null, shipmentRef: "PO1-W3" });
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

  it("carries a matched_ref through as matchedRef, transferred as-is (never resolved here)", () => {
    const rows = [
      { date: "2026-09-09", amount: "30746.70", currency: "USD", fx_rate: "0.93", counterparty: "Lvmengkang", description: "PO3 Jello Pay1", matched_ref: "PO3-JELLO" },
    ];
    const result = transformTransactions(rows);
    expect(result.skipped).toEqual([]);
    expect(result.transactions[0].matchedRef).toBe("PO3-JELLO");
  });

  it("defaults matchedRef to null when the Sheet's PO#/Shipment Ref column is blank or absent", () => {
    const rows = [
      { date: "2026-09-09", amount: "30746.70", currency: "USD", fx_rate: "0.93", counterparty: "Lvmengkang", description: "" },
      { date: "2026-09-09", amount: "30746.70", currency: "USD", fx_rate: "0.93", counterparty: "Lvmengkang", description: "", matched_ref: "" },
    ];
    const result = transformTransactions(rows);
    expect(result.transactions[0].matchedRef).toBeNull();
    expect(result.transactions[1].matchedRef).toBeNull();
  });

  // Important #2: a ref naming a per-SKU pooled-container line normalizes to
  // the pooled owner ref, ported from the source branch's ea7d1b3
  // ("collapse pooled-container refs on transactions") — without this, a
  // real Sheet hint naming e.g. "...Container2-Jello" would resolve to
  // nothing (paymentsByOwner/shipmentRefs are keyed by pooled refs only) and
  // reject as "no migrated PO or shipment with this ref".
  it("normalizes a matched_ref naming a single pooled-container line to the pooled owner ref", () => {
    const rows = [
      { date: "2026-07-21", amount: "19056.71", currency: "EUR", fx_rate: "1", counterparty: "F", description: "freight", matched_ref: "PO1-Wave4-Container2-JELLO" },
    ];
    const result = transformTransactions(rows);
    expect(result.transactions[0].matchedRef).toBe("PO1-Wave4-Container2");
  });

  it("collapses a comma-separated ref naming several lines of the SAME pooled container to one ref", () => {
    const rows = [
      { date: "2026-07-21", amount: "19056.71", currency: "EUR", fx_rate: "1", counterparty: "F", description: "freight", matched_ref: "PO1-Wave4-Container2-JELLO, PO1-Wave4-Container2-MIXER, PO1-Wave4-Container2-STRAW" },
    ];
    const result = transformTransactions(rows);
    expect(result.transactions[0].matchedRef).toBe("PO1-Wave4-Container2");
  });

  it("leaves a ref naming genuinely distinct owners comma-joined (still reported as untransferable downstream)", () => {
    const rows = [
      { date: "2026-07-01", amount: "10.00", currency: "EUR", fx_rate: "1", counterparty: "F", description: "split", matched_ref: "PO1, PO1-W1" },
    ];
    const result = transformTransactions(rows);
    expect(result.transactions[0].matchedRef).toBe("PO1, PO1-W1");
  });
});

describe("transformSalesActuals", () => {
  it("maps a well-formed sales actual row", () => {
    const rows = [{ sku: "JELLO-CAL-500", warehouse: "FF-DE", date: "2026-09-01", qty: "120" }];
    const result = transformSalesActuals(rows);
    expect(result.skipped).toEqual([]);
    expect(result.rows).toEqual([{ sku: "JELLO-CAL-500", warehouseCode: "FF-DE", date: new Date("2026-09-01"), qty: 120 }]);
  });

  it("quarantines a row with an unparseable qty instead of silently truncating it", () => {
    const rows = [{ sku: "JELLO-CAL-500", warehouse: "FF-DE", date: "2026-09-01", qty: "120xyz" }];
    const result = transformSalesActuals(rows);
    expect(result.rows).toEqual([]);
    expect(result.skipped[0].reason).toContain("qty");
  });

  it("quarantines a row with an unparseable date", () => {
    const rows = [{ sku: "JELLO-CAL-500", warehouse: "FF-DE", date: "not-a-date", qty: "120" }];
    const result = transformSalesActuals(rows);
    expect(result.rows).toEqual([]);
    expect(result.skipped[0].reason).toContain("date");
  });
});

describe("transformSalesPlan", () => {
  it("maps a well-formed sales plan row", () => {
    const rows = [{ sku: "JELLO-CAL-500", warehouse: "FF-DE", date: "2026-09-01", qty: "143" }];
    const result = transformSalesPlan(rows);
    expect(result.skipped).toEqual([]);
    expect(result.rows).toEqual([{ sku: "JELLO-CAL-500", warehouseCode: "FF-DE", date: new Date("2026-09-01"), qty: 143 }]);
  });

  it("quarantines a row with an unparseable qty", () => {
    const rows = [{ sku: "JELLO-CAL-500", warehouse: "FF-DE", date: "2026-09-01", qty: "not-a-number" }];
    const result = transformSalesPlan(rows);
    expect(result.rows).toEqual([]);
    expect(result.skipped[0].reason).toContain("qty");
  });
});
