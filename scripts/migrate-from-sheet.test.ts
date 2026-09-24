import { describe, it, expect } from "vitest";
import {
  transformSheetExport,
  reconcileMigration,
  computePlannedShipmentQty,
  transformPurchaseOrders,
  transformShipments,
  transformPayments,
  transformTransactions,
  transformSalesActuals,
  transformSalesPlan,
  type PaymentSheetRow,
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

describe("computePlannedShipmentQty", () => {
  it("sums qty across multiple planned shipments for the same SKU/warehouse", () => {
    const result = computePlannedShipmentQty([
      { status: "planned", sku: "JELLO-MIXER", warehouse: "Mutual", qty: "600" },
      { status: "planned", sku: "JELLO-MIXER", warehouse: "Mutual", qty: "200" },
    ]);
    expect(result.get("JELLO-MIXER|Mutual")).toBe(800);
  });

  it("ignores shipments that aren't status=planned (already departed/delivered)", () => {
    const result = computePlannedShipmentQty([
      { status: "delivered", sku: "JELLO-MIXER", warehouse: "Mutual", qty: "600" },
      { status: "in_transit", sku: "JELLO-MIXER", warehouse: "Mutual", qty: "300" },
    ]);
    expect(result.has("JELLO-MIXER|Mutual")).toBe(false);
  });

  it("keeps distinct SKU/warehouse pairs separate", () => {
    const result = computePlannedShipmentQty([
      { status: "planned", sku: "JELLO-MIXER", warehouse: "Mutual", qty: "600" },
      { status: "planned", sku: "JELLO-MIXER", warehouse: "FF-DE", qty: "100" },
      { status: "planned", sku: "JELLO-STRAW", warehouse: "Mutual", qty: "50" },
    ]);
    expect(result.get("JELLO-MIXER|Mutual")).toBe(600);
    expect(result.get("JELLO-MIXER|FF-DE")).toBe(100);
    expect(result.get("JELLO-STRAW|Mutual")).toBe(50);
  });

  it("returns an empty map for no shipment rows", () => {
    expect(computePlannedShipmentQty([]).size).toBe(0);
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

  it("treats a SOH gap fully explained by still-planned (not yet departed) shipments as no mismatch", async () => {
    // Real 2026-09-24 case: Sheet's own pre-aggregated Current-On-Hand total
    // prematurely includes a shipment that's still status=planned (not yet
    // departed) -- a genuine Sheet-side bug we can't fix (the Sheet only
    // gives us the final summed number, not its breakdown), but one we CAN
    // detect and route around using the shipment rows we already export.
    const plannedQty = computePlannedShipmentQty([
      { status: "planned", sku: "JELLO-MIXER", warehouse: "Mutual", qty: "600" },
    ]);
    const result = await reconcileMigration(
      [{ sku: "JELLO-MIXER", warehouseCode: "Mutual", sohFromSheet: 1003 }],
      { getMigratedSoh: async () => 403 },
      [],
      undefined,
      { plannedShipmentQtyBySkuWarehouse: plannedQty },
    );
    expect(result).toEqual({ passed: true, mismatches: [] });
  });

  it("still fails when a SOH gap is only partly explained by planned shipments -- a real mismatch remains", async () => {
    const plannedQty = computePlannedShipmentQty([
      { status: "planned", sku: "JELLO-MIXER", warehouse: "Mutual", qty: "600" },
    ]);
    const result = await reconcileMigration(
      [{ sku: "JELLO-MIXER", warehouseCode: "Mutual", sohFromSheet: 1003 }],
      { getMigratedSoh: async () => 300 }, // expected after adjustment is 403, not 300
      [],
      undefined,
      { plannedShipmentQtyBySkuWarehouse: plannedQty },
    );
    expect(result.passed).toBe(false);
    expect(result.mismatches).toEqual([
      { sku: "JELLO-MIXER", warehouseCode: "Mutual", expected: 403, actual: 300, diff: -103, kind: "soh" },
    ]);
  });

  it("behaves exactly as before when no planned-shipment adjustment is passed (backward compatible)", async () => {
    const result = await reconcileMigration(
      [{ sku: "JELLO-CAL-500", warehouseCode: "FF-DE", sohFromSheet: 150827 }],
      { getMigratedSoh: async () => 150827 },
    );
    expect(result).toEqual({ passed: true, mismatches: [] });
  });

  it("also treats the Sheet's unmodified total as a match when this row's On-Hand formula never inflated in the first place", async () => {
    // Real 2026-09-24 case that the first version of this fix got wrong: a
    // new planned PO ("PO3 Jello", 93600 units) was created mid-session, but
    // the Sheet's Current-On-Hand cell for JELLO/FF did NOT include it --
    // unlike the Mutual/JELLO-MIXER case above, this SKU/warehouse's formula
    // was already correct. Forcing the subtraction unconditionally (the
    // earlier fix) turned a passing check into a false mismatch. The gate
    // must accept either explanation: the raw Sheet total, or the Sheet
    // total minus still-planned quantities -- never force one over the other.
    const plannedQty = computePlannedShipmentQty([{ status: "planned", sku: "JELLO", warehouse: "FF", qty: "93600" }]);
    const result = await reconcileMigration(
      [{ sku: "JELLO", warehouseCode: "FF", sohFromSheet: 221829 }],
      { getMigratedSoh: async () => 221829 },
      [],
      undefined,
      { plannedShipmentQtyBySkuWarehouse: plannedQty },
    );
    expect(result).toEqual({ passed: true, mismatches: [] });
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

  // Regression test for the round-2 "silently passes a NaN/undefined expected
  // value" bug: tolerance(NaN) is itself NaN in JS (Math.max(0.01, NaN) ===
  // NaN), and "anything > NaN" is always false — so a malformed Sheet export
  // value (landedCostFromSheet itself NaN) must be caught by an explicit
  // finiteness check, not just by guarding the platform-computed `actual` side.
  it("fails a landed-cost target whose own landedCostFromSheet is NaN, instead of silently passing it", async () => {
    const result = await reconcileMigration(
      [],
      { getMigratedSoh: async () => 0 },
      [{ shipmentRef: "PO1-W1", sku: "JELLO-CAL-500", landedCostFromSheet: Number.NaN }],
      { getMigratedLandedCost: async () => 1.7 }, // a perfectly valid platform-side value
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
  // Most cases below involve no genuine pooled container at all, so they pass
  // an empty known-pooled-owners set (the safe, fail-closed default — see the
  // Finding-1 fix). Tests that DO exercise real Container-N pooling pass
  // POOLED_CONTAINER2, standing in for what transformShipments would have
  // actually resolved for that container from the real shipment rows.
  const NO_POOLED_OWNERS: ReadonlySet<string> = new Set();
  const POOLED_CONTAINER2: ReadonlySet<string> = new Set(["PO1-Wave4-Container2"]);

  it("maps a well-formed payment row", () => {
    const rows = [
      { po_number: "PO3-JELLO", sequence_no: "1", expected_amount: "30746.70", expected_date: "2026-09-09", currency: "USD" },
    ];
    const result = transformPayments(rows, NO_POOLED_OWNERS);
    expect(result.skipped).toEqual([]);
    expect(result.payments[0]).toMatchObject({ poNumber: "PO3-JELLO", sequenceNo: 1, expectedAmount: "30746.70", currency: "USD" });
  });

  it("quarantines a row with a non-numeric expected amount", () => {
    const rows = [{ po_number: "PO3-JELLO", sequence_no: "1", expected_amount: "not-a-number", expected_date: "2026-09-09", currency: "USD" }];
    const result = transformPayments(rows, NO_POOLED_OWNERS);
    expect(result.payments).toEqual([]);
    expect(result.skipped[0].reason).toContain("expected_amount");
  });

  it("quarantines a row with a non-numeric sequence_no instead of writing NaN", () => {
    const rows = [{ po_number: "PO3-JELLO", sequence_no: "abc", expected_amount: "30746.70", expected_date: "2026-09-09", currency: "USD" }];
    const result = transformPayments(rows, NO_POOLED_OWNERS);
    expect(result.payments).toEqual([]);
    expect(result.skipped[0].reason).toContain("sequence_no");
  });

  it("maps paid=TRUE with a paid_date to paid: true and the parsed paidDate", () => {
    const rows = [
      { po_number: "PO3-JELLO", sequence_no: "1", expected_amount: "30746.70", expected_date: "2026-09-09", currency: "USD", paid: "TRUE", paid_date: "2026-09-10" },
    ];
    const result = transformPayments(rows, NO_POOLED_OWNERS);
    expect(result.skipped).toEqual([]);
    expect(result.payments[0]).toMatchObject({ paid: true, paidDate: new Date("2026-09-10") });
  });

  it("defaults paid to false and paidDate to null when the Sheet leaves them blank", () => {
    const rows = [{ po_number: "PO3-JELLO", sequence_no: "1", expected_amount: "30746.70", expected_date: "2026-09-09", currency: "USD" }];
    const result = transformPayments(rows, NO_POOLED_OWNERS);
    expect(result.payments[0]).toMatchObject({ paid: false, paidDate: null });
  });

  it("quarantines a row marked paid without a paid_date instead of defaulting silently", () => {
    const rows = [{ po_number: "PO3-JELLO", sequence_no: "1", expected_amount: "30746.70", expected_date: "2026-09-09", currency: "USD", paid: "TRUE" }];
    const result = transformPayments(rows, NO_POOLED_OWNERS);
    expect(result.payments).toEqual([]);
    expect(result.skipped[0].reason).toContain("paid_date");
  });

  it("quarantines a row with an unparseable paid_date", () => {
    const rows = [{ po_number: "PO3-JELLO", sequence_no: "1", expected_amount: "30746.70", expected_date: "2026-09-09", currency: "USD", paid: "TRUE", paid_date: "not-a-date" }];
    const result = transformPayments(rows, NO_POOLED_OWNERS);
    expect(result.payments).toEqual([]);
    expect(result.skipped[0].reason).toContain("paid_date");
  });

  it("maps a well-formed shipment-owned payment row (shipment_ref instead of po_number)", () => {
    const rows = [{ po_number: "", shipment_ref: "PO1-W3", sequence_no: "1", expected_amount: "19056.71", expected_date: "2026-07-21", currency: "EUR" }];
    const result = transformPayments(rows, NO_POOLED_OWNERS);
    expect(result.skipped).toEqual([]);
    expect(result.payments[0]).toMatchObject({ poNumber: null, shipmentRef: "PO1-W3", sequenceNo: 1, expectedAmount: "19056.71" });
  });

  it("quarantines a row that gives both po_number and shipment_ref", () => {
    const rows = [{ po_number: "PO1", shipment_ref: "PO1-W3", sequence_no: "1", expected_amount: "1.00", expected_date: "2026-07-21", currency: "EUR" }];
    const result = transformPayments(rows, NO_POOLED_OWNERS);
    expect(result.payments).toEqual([]);
    expect(result.skipped[0].reason).toContain("exactly one of po_number / shipment_ref");
  });

  it("quarantines a row that gives neither po_number nor shipment_ref", () => {
    const rows = [{ po_number: "", sequence_no: "1", expected_amount: "1.00", expected_date: "2026-07-21", currency: "EUR" }];
    const result = transformPayments(rows, NO_POOLED_OWNERS);
    expect(result.payments).toEqual([]);
    expect(result.skipped[0].reason).toContain("exactly one of po_number / shipment_ref");
  });

  it("sums a pooled container's per-row payment slots (same sequence) under the pooled shipment ref", () => {
    const rows = [
      { po_number: "", shipment_ref: "PO1-Wave4-Container2-JELLO", sequence_no: "1", expected_amount: "300.00", expected_date: "2026-07-21", currency: "EUR", paid: "TRUE", paid_date: "2026-07-21" },
      { po_number: "", shipment_ref: "PO1-Wave4-Container2-STRAW", sequence_no: "1", expected_amount: "300.00", expected_date: "2026-07-21", currency: "EUR", paid: "TRUE", paid_date: "2026-07-21" },
    ];
    const result = transformPayments(rows, POOLED_CONTAINER2);
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
    const result = transformPayments(rows, POOLED_CONTAINER2);
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
    const result = transformPayments(rows, POOLED_CONTAINER2);
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
    const result = transformPayments(rows, POOLED_CONTAINER2);
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
    const result = transformPayments(rows, POOLED_CONTAINER2);
    expect(result.payments).toEqual([]);
    expect(result.skipped[0].reason).toContain("disagree on expected_date");
  });

  it("trims whitespace-only po_number the same as an empty one (XOR validation isn't defeated by whitespace)", () => {
    const rows = [{ po_number: "   ", shipment_ref: "PO1-W3", sequence_no: "1", expected_amount: "1.00", expected_date: "2026-07-21", currency: "EUR" }];
    const result = transformPayments(rows, NO_POOLED_OWNERS);
    expect(result.skipped).toEqual([]);
    expect(result.payments[0]).toMatchObject({ poNumber: null, shipmentRef: "PO1-W3" });
  });

  // Round-2 regression: does not throw when a row is missing the po_number
  // key entirely (JSON export that only ever sets shipment_ref on a
  // shipment-owned row) — the old `row.po_number.trim()` crashed the whole
  // migration with "Cannot read properties of undefined (reading 'trim')".
  it("does not crash when po_number is missing from the row entirely (only shipment_ref given)", () => {
    const rows = [{ shipment_ref: "PO1-W3", sequence_no: "1", expected_amount: "1.00", expected_date: "2026-07-21", currency: "EUR" } as unknown as PaymentSheetRow];
    expect(() => transformPayments(rows, NO_POOLED_OWNERS)).not.toThrow();
    const result = transformPayments(rows, NO_POOLED_OWNERS);
    expect(result.skipped).toEqual([]);
    expect(result.payments[0]).toMatchObject({ poNumber: null, shipmentRef: "PO1-W3" });
  });

  // Round-2 Critical regression: two rows genuinely duplicating the same
  // PO+sequence (not a pooled container — POs never pool) must quarantine,
  // never silently sum into one payment carrying double the real amount.
  it("quarantines (never sums) two duplicate PO-owned rows sharing the same po_number and sequence_no", () => {
    const rows = [
      { po_number: "PO1", sequence_no: "1", expected_amount: "300.00", expected_date: "2026-07-21", currency: "EUR" },
      { po_number: "PO1", sequence_no: "1", expected_amount: "300.00", expected_date: "2026-07-21", currency: "EUR" },
    ];
    const result = transformPayments(rows, NO_POOLED_OWNERS);
    expect(result.payments).toEqual([]);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped[0].reason).toContain("duplicate payment rows");
    expect(result.skipped[0].reason).toContain("purchase orders don't pool");
  });

  // Round-2 regression: two rows with the exact same (non-pooled) shipment_ref
  // and sequence are a duplicate, not a genuine pooled container (no distinct
  // per-SKU lines) — must also quarantine rather than silently sum.
  it("quarantines (never sums) two duplicate rows sharing the exact same non-pooled shipment_ref and sequence_no", () => {
    const rows = [
      { po_number: "", shipment_ref: "PO1-W3", sequence_no: "1", expected_amount: "300.00", expected_date: "2026-07-21", currency: "EUR" },
      { po_number: "", shipment_ref: "PO1-W3", sequence_no: "1", expected_amount: "300.00", expected_date: "2026-07-21", currency: "EUR" },
    ];
    const result = transformPayments(rows, NO_POOLED_OWNERS);
    expect(result.payments).toEqual([]);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped[0].reason).toContain("duplicate payment rows");
  });

  // Round-3 Critical (residual) regression: `distinctRawRefs.size > 1` alone
  // is not enough to detect "genuinely pooled" — a duplicate ALONGSIDE
  // genuinely distinct rows (JELLO, JELLO-again, STRAW) still has size 2 > 1
  // and would silently sum the duplicate in too (900.00 for a real 600.00).
  // The correct test is size === group.length (every row distinct).
  it("quarantines the whole group when a duplicate row sits inside an otherwise-genuine pooled container, instead of summing the duplicate in", () => {
    const rows = [
      { po_number: "", shipment_ref: "PO1-Wave4-Container2-JELLO", sequence_no: "1", expected_amount: "300.00", expected_date: "2026-07-21", currency: "EUR" },
      { po_number: "", shipment_ref: "PO1-Wave4-Container2-JELLO", sequence_no: "1", expected_amount: "300.00", expected_date: "2026-07-21", currency: "EUR" }, // exact duplicate of the row above
      { po_number: "", shipment_ref: "PO1-Wave4-Container2-STRAW", sequence_no: "1", expected_amount: "300.00", expected_date: "2026-07-21", currency: "EUR" },
    ];
    const result = transformPayments(rows, POOLED_CONTAINER2);
    expect(result.payments).toEqual([]); // never a payment silently summing to 900.00
    expect(result.skipped).toHaveLength(3);
    expect(result.skipped[0].reason).toContain("duplicate payment rows");
  });

  // Round-2 Important #1 regression: a pooled sibling that fails sequence_no
  // parsing (not just amount/date) must still poison the WHOLE owner — the
  // valid JELLO row must not migrate alone as if its 300.00 were the real
  // 600.00 total, just because the failure mode was sequence_no this time.
  it("quarantines the whole pooled owner when a sibling's sequence_no is unparseable, not just the bad row", () => {
    const rows = [
      { po_number: "", shipment_ref: "PO1-Wave4-Container2-JELLO", sequence_no: "1", expected_amount: "300.00", expected_date: "2026-07-21", currency: "EUR" },
      { po_number: "", shipment_ref: "PO1-Wave4-Container2-STRAW", sequence_no: "", expected_amount: "300.00", expected_date: "2026-07-21", currency: "EUR" },
    ];
    const result = transformPayments(rows, POOLED_CONTAINER2);
    expect(result.payments).toEqual([]);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped.map((s) => s.rowIndex).sort()).toEqual([0, 1]);
  });

  it("quarantines the whole pooled owner when a sibling fails the XOR check (not just sequence_no), same poisoning logic", () => {
    const rows = [
      { po_number: "", shipment_ref: "PO1-Wave4-Container2-JELLO", sequence_no: "1", expected_amount: "300.00", expected_date: "2026-07-21", currency: "EUR" },
      // both po_number and shipment_ref given — XOR failure, but shipment_ref still genuinely names the pooled container
      { po_number: "PO1", shipment_ref: "PO1-Wave4-Container2-STRAW", sequence_no: "1", expected_amount: "300.00", expected_date: "2026-07-21", currency: "EUR" },
    ];
    const result = transformPayments(rows, POOLED_CONTAINER2);
    expect(result.payments).toEqual([]);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped.map((s) => s.rowIndex).sort()).toEqual([0, 1]);
  });

  // A validation failure on a row naming a PLAIN, never-pooled shipment ref
  // must NOT poison an unrelated, otherwise-valid row on that same shipment —
  // there's no pooling ambiguity for a non-Container-N ref, so a sibling row
  // failing for an unrelated reason (e.g. giving both po_number and
  // shipment_ref) must not take down the genuinely valid payment row.
  it("does not poison a plain (non-pooled) shipment owner when an unrelated row referencing it fails validation", () => {
    const rows = [
      { po_number: "", shipment_ref: "PO1-W3", sequence_no: "1", expected_amount: "19056.71", expected_date: "2026-07-21", currency: "EUR" },
      { po_number: "PO1", shipment_ref: "PO1-W3", sequence_no: "2", expected_amount: "1.00", expected_date: "2026-07-21", currency: "EUR" }, // XOR failure, unrelated sequence
    ];
    const result = transformPayments(rows, NO_POOLED_OWNERS);
    expect(result.payments).toHaveLength(1);
    expect(result.payments[0]).toMatchObject({ shipmentRef: "PO1-W3", sequenceNo: 1, expectedAmount: "19056.71" });
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toContain("exactly one of po_number / shipment_ref");
  });

  // Extra finding surfaced while verifying Important #4 (round 2): the same
  // false-positive-pooling risk exists here, not just in transaction
  // matching. A lone payment row naming a real, legitimately-unpooled
  // Container-N-looking shipment (the same false positive
  // transformShipments' own sku cross-check guards against, e.g.
  // "...Container9-Notes") must keep its OWN raw ref as its owner — not the
  // Container-N-pattern candidate, which corresponds to no real shipment
  // since this ref was never actually pooled with anything.
  it("keeps a lone payment row's own raw shipment_ref when it only LOOKS like a pooled-container line (no genuine sibling)", () => {
    const rows = [{ po_number: "", shipment_ref: "PO1-Wave1-Container9-Notes", sequence_no: "1", expected_amount: "50.00", expected_date: "2026-07-21", currency: "EUR" }];
    const result = transformPayments(rows, NO_POOLED_OWNERS);
    expect(result.skipped).toEqual([]);
    expect(result.payments[0]).toMatchObject({ shipmentRef: "PO1-Wave1-Container9-Notes", sequenceNo: 1, expectedAmount: "50.00" });
  });

  // Finding 1 (2026-09-21 final review): the safety net above only covers a
  // LONE coincidental match. Two DISTINCT rows coincidentally sharing a
  // Container-N prefix used to be enough for the old regex-only check to
  // treat them as a genuine pool and sum them — even though the shipment
  // side (which DOES have a real per-row sku to check) never actually pooled
  // anything under that prefix. The fix requires the prefix itself to be a
  // real, actually-pooled shipment owner (knownPooledOwnerRefs, computed
  // once from transformShipments) before ever stripping a suffix, so two
  // unrelated rows that merely share a fabricated prefix must stay two
  // separate, unpooled payments.
  it("does not pool two distinct payment rows sharing a Container-N prefix that is not a genuinely pooled shipment owner, even though there are ≥2 of them", () => {
    const rows = [
      { po_number: "", shipment_ref: "PO1-Wave9-Container3-STRAW", sequence_no: "1", expected_amount: "50.00", expected_date: "2026-07-21", currency: "EUR" },
      { po_number: "", shipment_ref: "PO1-Wave9-Container3-NOTES", sequence_no: "1", expected_amount: "75.00", expected_date: "2026-07-21", currency: "EUR" },
    ];
    // "PO1-Wave9-Container3" is deliberately absent from the known-pooled set
    // — the shipment side never pooled anything under it.
    const result = transformPayments(rows, NO_POOLED_OWNERS);
    expect(result.skipped).toEqual([]);
    expect(result.payments).toHaveLength(2);
    expect(result.payments.map((p) => p.shipmentRef).sort()).toEqual(["PO1-Wave9-Container3-NOTES", "PO1-Wave9-Container3-STRAW"]);
    expect(result.payments.map((p) => p.expectedAmount).sort()).toEqual(["50.00", "75.00"]); // never silently summed to 125.00
  });

  it("pools two distinct payment rows sharing a Container-N prefix that IS a genuinely pooled shipment owner", () => {
    const rows = [
      { po_number: "", shipment_ref: "PO1-Wave9-Container3-STRAW", sequence_no: "1", expected_amount: "50.00", expected_date: "2026-07-21", currency: "EUR" },
      { po_number: "", shipment_ref: "PO1-Wave9-Container3-NOTES", sequence_no: "1", expected_amount: "75.00", expected_date: "2026-07-21", currency: "EUR" },
    ];
    const result = transformPayments(rows, new Set(["PO1-Wave9-Container3"]));
    expect(result.skipped).toEqual([]);
    expect(result.payments).toEqual([expect.objectContaining({ shipmentRef: "PO1-Wave9-Container3", sequenceNo: 1, expectedAmount: "125.00" })]);
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

  // Important #4 (round 2): pooled-owner normalization for matched_ref moved
  // OUT of this transform and into runMigration (see reconcile-migration.ts
  // and its tests) — this layer has no way to know whether a Container-N-
  // looking ref is genuinely pooled or one transformShipments deliberately
  // left standalone (that needs the real shipmentIdByRef/paymentsByOwner
  // runMigration builds), so it must transfer matched_ref completely as-is,
  // never rewriting it, even when it looks like a pooled-container line.
  it("carries a ref naming what looks like a pooled-container line through unchanged (normalization happens in runMigration, not here)", () => {
    const rows = [
      { date: "2026-07-21", amount: "19056.71", currency: "EUR", fx_rate: "1", counterparty: "F", description: "freight", matched_ref: "PO1-Wave4-Container2-JELLO" },
    ];
    const result = transformTransactions(rows);
    expect(result.transactions[0].matchedRef).toBe("PO1-Wave4-Container2-JELLO");
  });

  it("carries a comma-separated multi-line ref through unchanged, only trimmed", () => {
    const rows = [
      { date: "2026-07-21", amount: "19056.71", currency: "EUR", fx_rate: "1", counterparty: "F", description: "freight", matched_ref: "PO1-Wave4-Container2-JELLO, PO1-Wave4-Container2-MIXER, PO1-Wave4-Container2-STRAW" },
    ];
    const result = transformTransactions(rows);
    expect(result.transactions[0].matchedRef).toBe("PO1-Wave4-Container2-JELLO, PO1-Wave4-Container2-MIXER, PO1-Wave4-Container2-STRAW");
  });

  it("carries a ref naming genuinely distinct owners through unchanged", () => {
    const rows = [
      { date: "2026-07-01", amount: "10.00", currency: "EUR", fx_rate: "1", counterparty: "F", description: "split", matched_ref: "PO1, PO1-W1" },
    ];
    const result = transformTransactions(rows);
    expect(result.transactions[0].matchedRef).toBe("PO1, PO1-W1");
  });

  // Finding 3 (2026-09-21 final review): export.ts's exportTransactions
  // computes fxRate as "" for a non-EUR row whose Amount (EUR) cell is
  // blank — an empty string reaching recordTransaction's decimal fxRate
  // column crashes the WHOLE migration transaction under MySQL strict mode,
  // instead of quarantining just this one malformed row like every other
  // bad field on this row. Must be caught here, matching the existing
  // date/amount validation pattern exactly.
  it("quarantines a non-EUR row with a blank fx_rate instead of letting it reach recordTransaction and crash the whole migration", () => {
    const rows = [
      { date: "2026-09-09", amount: "100.00", currency: "USD", fx_rate: "", counterparty: "Test", description: "" },
    ];
    const result = transformTransactions(rows);
    expect(result.transactions).toEqual([]);
    expect(result.skipped).toEqual([{ rowIndex: 0, reason: expect.stringContaining("FX rate") }]);
  });

  it("does not quarantine a EUR row with fx_rate '1', and does not quarantine a non-EUR row with a real fx_rate", () => {
    const rows = [
      { date: "2026-09-09", amount: "100.00", currency: "EUR", fx_rate: "1", counterparty: "Test", description: "" },
      { date: "2026-09-09", amount: "100.00", currency: "USD", fx_rate: "0.93", counterparty: "Test", description: "" },
    ];
    const result = transformTransactions(rows);
    expect(result.skipped).toEqual([]);
    expect(result.transactions).toHaveLength(2);
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
