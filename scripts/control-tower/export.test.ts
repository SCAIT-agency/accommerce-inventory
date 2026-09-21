import { describe, it, expect, beforeAll } from "vitest";
import { loadFixtureSnapshot, cell, type ControlTowerSnapshot } from "./snapshot";
import {
  PO_STATUS_MAP,
  buildMigrationInput,
  computeShares,
  exportLandedCostTotals,
  exportLedgerReceipts,
  exportPayments,
  exportPurchaseOrders,
  exportSalesActuals,
  exportSalesPlan,
  exportShipmentPayments,
  exportShipments,
  platformShipmentRef,
  sheetSplitShares,
  exportSheetTotals,
  exportTransactions,
  shipmentStatusFromDates,
} from "./export";
import { transformPayments, transformPurchaseOrders, transformShipments, transformTransactions } from "../migrate-from-sheet";

const TODAY = "2026-09-19";
let snap: ControlTowerSnapshot;
beforeAll(async () => {
  snap = await loadFixtureSnapshot();
});

describe("purchase orders & payments", () => {
  it("exports 13 real PO lines with Full Factory Cost/unit as the line price and mapped statuses", () => {
    const rows = exportPurchaseOrders(snap);
    expect(rows).toHaveLength(13);
    const po1 = rows.find((r) => r.po_number === "PO1 Jello")!;
    const sheetRow = snap.purchaseOrders.rows.find((r) => cell(snap.purchaseOrders, r, "PO#") === "PO1 Jello")!;
    expect(po1).toMatchObject({ vendor_name: "Guangzhou Lvmengkang", sku: "Jello", qty: "300960", currency: "EUR", status: "closed" });
    expect(po1.unit_price).toBe(cell(snap.purchaseOrders, sheetRow, "Full Factory Cost/unit"));
    expect(parseFloat(po1.unit_price)).toBeGreaterThan(parseFloat(cell(snap.purchaseOrders, sheetRow, "EXW/unit")));
    expect(new Set(rows.map((r) => r.status))).toEqual(new Set(["closed", "shipped", "in_production"]));
    expect(transformPurchaseOrders(rows).skipped).toEqual([]);
  });

  it("covers every Sheet status and passes unknown ones through for the transform to quarantine", () => {
    expect(Object.keys(PO_STATUS_MAP)).toEqual(["Draft", "Placed", "In Production", "Partially Shipped", "Closed"]);
    const mutated = { ...snap, purchaseOrders: { ...snap.purchaseOrders, rows: snap.purchaseOrders.rows.map((r) => r.map((v) => (v === "Closed" ? "Cancelled" : v))) } };
    const result = transformPurchaseOrders(exportPurchaseOrders(mutated));
    expect(result.skipped.length).toBeGreaterThan(0);
    expect(result.skipped[0].reason).toContain('"Cancelled"');
  });

  it("exports one payment row per filled slot with paid flag and actual date", () => {
    const rows = exportPayments(snap);
    const po1 = rows.filter((r) => r.po_number === "PO1 Jello");
    expect(po1.map((r) => [r.sequence_no, r.paid])).toEqual([["1", "TRUE"], ["2", "TRUE"], ["3", "FALSE"]]);
    expect(po1[0]).toMatchObject({ expected_amount: "171271.88", expected_date: "2026-05-11", currency: "EUR" });
    expect(po1[0].paid_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // PO1 Mixer has only two slots filled
    expect(rows.filter((r) => r.po_number === "PO1 Mixer")).toHaveLength(2);
  });

  it("re-issues slot numbers as one running sequence per PO# when a PO spans several Sheet rows", () => {
    const procware = exportPayments(snap).filter((r) => r.po_number === "Procware Heritage");
    expect(procware.map((r) => [r.sequence_no, r.expected_amount])).toEqual([
      ["1", "36809.6512"],
      ["2", "425.4936"],
      ["3", "1136.2062"],
    ]);
  });

  it("exports one raw payment row per Sheet row × filled shipment-level slot, sequenced per pooled-container group", () => {
    const rows = exportShipmentPayments(snap);
    // 28 row-level slot fillings; unlike the source branch this no longer
    // pre-collapses Container 2's three rows — that pooling now happens in
    // migrate-from-sheet.ts's transformPayments (checked below).
    expect(rows).toHaveLength(28);
    expect(rows.every((r) => r.po_number === "" && r.shipment_ref)).toBe(true);
    const wave3 = rows.filter((r) => r.shipment_ref === "PO1-Wave3");
    expect(wave3.map((r) => [r.sequence_no, r.expected_amount, r.paid, r.paid_date])).toEqual([
      ["1", "19056.71", "TRUE", "2026-07-21"],
      ["2", "19209.21", "TRUE", "2026-07-23"],
      ["3", "15092.83", "FALSE", ""],
    ]);
    expect(transformPayments(rows).skipped).toEqual([]);

    // Container 2's three raw rows share sequence numbers 1 (Freight) and 2
    // (Customs, Freight-2 being blank for all three) so transformPayments'
    // own pooling groups and sums them into the same two owner-level slots
    // the source branch's pre-merged exporter used to emit directly.
    const c2Raw = rows.filter((r) => r.shipment_ref?.startsWith("PO1-Wave4-Container2-"));
    expect(c2Raw).toHaveLength(6); // 3 rows × 2 present slots
    expect(new Set(c2Raw.map((r) => r.sequence_no))).toEqual(new Set(["1", "2"]));
    const { payments: pooled } = transformPayments(rows);
    const c2Pooled = pooled.filter((p) => p.shipmentRef === "PO1-Wave4-Container2").sort((a, b) => a.sequenceNo - b.sequenceNo);
    expect(c2Pooled.map((p) => [p.sequenceNo, p.expectedAmount, p.paid])).toEqual([
      [1, (8536.77 + 689.82 + 2510.38).toFixed(2), false],
      [2, (13393.53 + 840.91 + 1677.75).toFixed(2), false],
    ]);
  });

  it("transformPayments quarantines a paid slot with no actual date", () => {
    const rows = exportPayments(snap).map((r) => (r.po_number === "PO1 Jello" && r.sequence_no === "1" ? { ...r, paid_date: "" } : r));
    const result = transformPayments(rows);
    expect(result.skipped).toEqual([{ rowIndex: expect.any(Number), reason: "paid without a paid_date (PO1 Jello #1)" }]);
    expect(result.payments.find((p) => p.poNumber === "PO1 Jello" && p.sequenceNo === 2)).toMatchObject({ paid: true, paidDate: expect.any(Date) });
  });
});

describe("shipments", () => {
  it("emits one raw row per Sheet row (Mutual-PO2-Delivered's two rows keep the same raw ref; Container 2's three keep their own)", () => {
    const { rows, issues } = exportShipments(snap);
    expect(issues).toEqual([]);
    expect(rows).toHaveLength(25);
    // Container 2's three rows are NOT collapsed to one ref any more —
    // that's migrate-from-sheet.ts's transformShipments' job now.
    expect(new Set(rows.map((r) => r.shipment_ref)).size).toBe(24); // 25 rows, only Mutual-PO2-Delivered's two share a literal ref
    const merged = rows.filter((r) => r.shipment_ref === "Mutual-PO2-Delivered");
    expect(merged.map((r) => r.sku).sort()).toEqual(["Mixer", "Straw"]);
    expect(merged.map((r) => r.po_line_item_ref).sort()).toEqual(["PO2 Mixer::Mixer", "PO2 Straw::Straw"]);
    const w = merged.reduce((a, r) => a + parseFloat(r.weight_share), 0);
    const v = merged.reduce((a, r) => a + parseFloat(r.value_share), 0);
    expect(w).toBeCloseTo(1, 5);
    expect(v).toBeCloseTo(1, 5);
    expect(transformShipments(rows).skipped).toEqual([]);
  });

  it("takes freight from Delivery + Admin Fees and duty from the non-refundable actual", () => {
    const { rows } = exportShipments(snap);
    const w1 = rows.find((r) => r.shipment_ref === "PO1-Wave1-Jello")!;
    expect(w1.freight_cost).toBe((36395.82 + 1953.69).toFixed(2));
    expect(w1.duty_cost).toBe("7083.14");
    expect(w1).toMatchObject({ cost_currency: "EUR", weight_share: "1", value_share: "1", status: "delivered", customs_status: "cleared", actual_arrival_date: "2026-07-06", actual_depart_date: "2026-06-23", planned_arrival_date: "2026-07-06" });
  });

  it("derives status from dates", () => {
    expect(shipmentStatusFromDates("2026-07-06", "2026-06-23")).toBe("delivered");
    expect(shipmentStatusFromDates(null, "2026-06-23")).toBe("in_transit");
    expect(shipmentStatusFromDates(null, null)).toBe("planned");
    const { rows } = exportShipments(snap);
    expect(rows.find((r) => r.shipment_ref === "PO3 Jello")).toMatchObject({ status: "planned", freight_cost: "", duty_cost: "", customs_status: "not_declared" });
  });

  it("computes each Container<N>-<SKU> row's own fractional share of the pooled group's cost split, so migrate-from-sheet.ts reassembles one pooled shipment", () => {
    expect(platformShipmentRef("PO1-Wave4-Container2-Jello", ["Jello", "Mixer", "Straw"])).toBe("PO1-Wave4-Container2");
    expect(platformShipmentRef("PO1-Wave4-Container1 WAE2026071000047", ["Jello", "Mixer", "Straw"])).toBe("PO1-Wave4-Container1 WAE2026071000047");
    expect(platformShipmentRef("PO1-Wave1-Jello", ["Jello", "Mixer", "Straw"])).toBe("PO1-Wave1-Jello");
    expect(platformShipmentRef("PO1-Wave4-Container2-Nope", ["Jello", "Mixer", "Straw"])).toBe("PO1-Wave4-Container2-Nope");
    // The second argument must be the SKU(s) actually present on the row, not
    // the full catalog — a ref whose suffix is a valid catalog SKU that just
    // isn't present on THIS row must not be treated as pooled (bug fixed
    // 2026-09-21: this call used to receive the whole catalog, so a row
    // named "...Container5-Straw" whose only filled qty column was Mixer got
    // silently pooled with the real Container5-Mixer/-Straw rows).
    expect(platformShipmentRef("PO1-Wave4-Container2-Straw", ["Mixer"])).toBe("PO1-Wave4-Container2-Straw");

    const { rows } = exportShipments(snap);
    const c2 = rows.filter((r) => r.shipment_ref.startsWith("PO1-Wave4-Container2-"));
    expect(c2.map((r) => r.sku).sort()).toEqual(["Jello", "Mixer", "Straw"]);
    expect(c2.map((r) => r.shipment_ref).sort()).toEqual(["PO1-Wave4-Container2-Jello", "PO1-Wave4-Container2-Mixer", "PO1-Wave4-Container2-Straw"]);
    // freight = Σ (Delivery + Admin) over the three rows; duty = Σ duty; every
    // row of the group carries the SAME total (transformShipments takes only
    // the first row's value as the whole shipment's); shares are each row's part.
    const freight = parseFloat(c2[0].freight_cost);
    const duty = parseFloat(c2[0].duty_cost);
    expect(c2.every((r) => r.freight_cost === c2[0].freight_cost && r.duty_cost === c2[0].duty_cost)).toBe(true);
    expect(c2.reduce((a, r) => a + parseFloat(r.weight_share), 0)).toBeCloseTo(1, 5);
    expect(c2.reduce((a, r) => a + parseFloat(r.value_share), 0)).toBeCloseTo(1, 5);
    const jello = c2.find((r) => r.sku === "Jello")!;
    const tab = snap.shipments;
    const jelloRow = tab.rows.find((r) => cell(tab, r, "Shipment ID") === "PO1-Wave4-Container2-Jello")!;
    const jelloFreight = parseFloat(cell(tab, jelloRow, "Actual — Delivery")) + parseFloat(cell(tab, jelloRow, "Actual — Admin Fees"));
    expect(freight * parseFloat(jello.weight_share)).toBeCloseTo(jelloFreight, 1);
    expect(duty * parseFloat(jello.value_share)).toBeCloseTo(parseFloat(cell(tab, jelloRow, "Actual — Duty (non-refundable)")), 1);
    expect(jello).toMatchObject({ status: "delivered", actual_arrival_date: "2026-09-03", customs_status: "cleared" });

    // Reassembled through the real migration transform, the three raw rows
    // merge into one pooled shipment with shares still summing to 1.
    const { shipments: transformed, skipped } = transformShipments(rows);
    expect(skipped).toEqual([]);
    const pooled = transformed.find((s) => s.shipmentRef === "PO1-Wave4-Container2")!;
    expect(pooled.lineItems.map((li) => li.sku).sort()).toEqual(["Jello", "Mixer", "Straw"]);
    expect(pooled.lineItems.reduce((a, li) => a + parseFloat(li.weightShare), 0)).toBeCloseTo(1, 5);
    expect(pooled.lineItems.reduce((a, li) => a + parseFloat(li.valueShare), 0)).toBeCloseTo(1, 5);
  });

  it("does not pool two unrelated rows just because a fabricated Container ref's suffix happens to be a valid catalog SKU — it must be that row's own present SKU", () => {
    // Two real, independent single-SKU Mixer shipments. Renamed so their raw
    // refs share a Container-N prefix but the SECOND row's suffix names a
    // SKU ("Straw") that is a real catalog SKU yet is NOT what this row
    // actually carries (only "Mixer Qty" is filled on it) — the exact
    // failure scenario from the 2026-09-21 bug: export.ts used to pool this
    // with the first row purely because "Straw" is some valid SKU, mirroring
    // the mismatch onto both rows' freight/duty totals and shares even
    // though migrate-from-sheet.ts would (correctly) keep the row standalone
    // once it reached its own per-row `sku` check.
    const shipIdx = snap.shipments.header.indexOf("Shipment ID");
    const renameRef = (rows: string[][], oldRef: string, newRef: string) =>
      rows.map((r) => (r[shipIdx] === oldRef ? r.map((v, i) => (i === shipIdx ? newRef : v)) : r));
    let rows = snap.shipments.rows;
    rows = renameRef(rows, "PO1-Wave1-Mixer", "TestGroup-Container9-Mixer");
    rows = renameRef(rows, "PO1-Wave2-Mixer", "TestGroup-Container9-Straw");
    const mutated = { ...snap, shipments: { ...snap.shipments, rows } };

    const { rows: out } = exportShipments(mutated);
    const g1 = out.find((r) => r.shipment_ref === "TestGroup-Container9-Mixer")!;
    const g2 = out.find((r) => r.shipment_ref === "TestGroup-Container9-Straw")!;
    expect(g1).toBeDefined();
    expect(g2).toBeDefined();

    // Each stays a standalone (1-line) shipment — not merged into one pooled
    // group — so both keep whole (1/1) shares, not a fractional split.
    expect(g1.weight_share).toBe("1");
    expect(g1.value_share).toBe("1");
    expect(g2.weight_share).toBe("1");
    expect(g2.value_share).toBe("1");

    // And each keeps its OWN freight/duty — not summed with the other row's,
    // which is what pooling them would have done.
    const original = exportShipments(snap).rows;
    const origWave1 = original.find((r) => r.shipment_ref === "PO1-Wave1-Mixer")!;
    const origWave2 = original.find((r) => r.shipment_ref === "PO1-Wave2-Mixer")!;
    expect(g1.freight_cost).toBe(origWave1.freight_cost);
    expect(g1.duty_cost).toBe(origWave1.duty_cost);
    expect(g2.freight_cost).toBe(origWave2.freight_cost);
    expect(g2.duty_cost).toBe(origWave2.duty_cost);
  });

  it("sheetSplitShares applies only when every line carries the Sheet's split", () => {
    expect(sheetSplitShares([{ freight: 75, duty: 10 }, { freight: 25, duty: 30 }])).toEqual([
      { weightShare: "0.75000000", valueShare: "0.25000000" },
      { weightShare: "0.25000000", valueShare: "0.75000000" },
    ]);
    expect(sheetSplitShares([{ freight: 75, duty: 10 }, { freight: null, duty: 30 }])).toBeNull();
    expect(sheetSplitShares([{ freight: 75, duty: 10 }])).toBeNull();
  });

  it("computeShares splits multi-line shipments by weight and value", () => {
    const shares = computeShares([
      { sku: "A", qty: 100, kgPerUnit: 0.1, unitPrice: 2 },
      { sku: "B", qty: 100, kgPerUnit: 0.3, unitPrice: 1 },
    ]);
    expect(shares).toEqual([
      { weightShare: "0.25000000", valueShare: "0.66666667" },
      { weightShare: "0.75000000", valueShare: "0.33333333" },
    ]);
  });
});

describe("receipts, landed cost, sales, plan, transactions, totals", () => {
  it("exports one receipt per landed line at the Sheet's net landed cost", () => {
    const { rows, issues } = exportLedgerReceipts(snap);
    expect(issues).toEqual([]);
    expect(rows).toHaveLength(24);
    expect(rows.find((r) => r.source_ref === "PO1-Wave1-Jello")).toEqual({
      sku: "Jello", warehouse: "FF", event_type: "receipt", qty: "50040", unit_cost: "2.0259266586730615", date: "2026-07-06", source_ref: "PO1-Wave1-Jello",
    });
    expect(exportLandedCostTotals(snap)).toHaveLength(24);
  });

  it("reports a landed line with no Landed Cost Summary row instead of inventing a cost", () => {
    const lcs = snap.landedCostSummary;
    const without = { ...snap, landedCostSummary: { ...lcs, rows: lcs.rows.filter((r) => cell(lcs, r, "Shipment ID (Wave)") !== "PO1-Wave3") } };
    const { rows, issues } = exportLedgerReceipts(without);
    expect(issues).toEqual([{ entity: "receipt", key: "PO1-Wave3::Jello", reason: "landed line has no Landed Cost Summary row" }]);
    expect(rows.some((r) => r.source_ref === "PO1-Wave3")).toBe(false);
  });

  it("exports sales actuals through today and plan rows from their first planned day", () => {
    const sales = exportSalesActuals(snap, TODAY);
    expect(sales.find((s) => s.sku === "Jello" && s.warehouse === "FF" && s.date === "2026-06-16")?.qty).toBe("1720");
    expect(sales.filter((s) => s.sku === "Jello" && s.warehouse === "FF")).toHaveLength(95);
    const plan = exportSalesPlan(snap);
    expect(plan.filter((p) => p.sku === "Jello" && p.warehouse === "FF").map((p) => p.date).sort()[0]).toBe("2026-07-13");
  });

  it("exports all 153 transactions with derived fx, raw carried refs, and nothing bank-related", () => {
    const rows = exportTransactions(snap);
    expect(rows).toHaveLength(153);
    expect(rows.filter((r) => r.matched_ref).length).toBe(20);
    const eur = rows.find((r) => r.currency === "EUR")!;
    expect(eur.fx_rate).toBe("1");
    const usd = rows.find((r) => r.currency === "USD")!;
    expect(parseFloat(usd.fx_rate)).toBeGreaterThan(0.5);
    expect(parseFloat(usd.fx_rate)).toBeLessThan(1.2);
    expect(JSON.stringify(rows)).not.toMatch(/bank/i);
    expect(transformTransactions(rows).skipped).toEqual([]);
    expect(rows[0]).toMatchObject({ date: "2026-06-27", amount: "166.57", counterparty: "Hangzhou Miqiu Internet Technology Co., Ltd" });
    expect(rows[0].description).toMatch(/^Fulfillment — /);
    // Comma-separated pooled-container hints are carried raw now — resolving
    // them (including the pooled-owner collapse) is reconcile-migration.ts's
    // own resolveRef fallback, not this exporter's job.
    const pooledHints = rows.filter((r) => (r.matched_ref ?? "").includes("Container2"));
    expect(pooledHints.length).toBeGreaterThan(0);
    expect(pooledHints.every((r) => (r.matched_ref ?? "").includes(","))).toBe(true);
  });

  it("assembles the full migration input with Current On-Hand totals", () => {
    const { input, issues } = buildMigrationInput(snap, TODAY);
    expect(issues).toEqual([]);
    expect(input.sheetTotals).toHaveLength(6);
    expect(exportSheetTotals(snap)).toContainEqual({ sku: "Jello", warehouseCode: "FF", sohFromSheet: 228585 });
    expect(input.poRows).toHaveLength(13);
    expect(input.shipmentRows).toHaveLength(25);
    expect(input.ledgerRows).toHaveLength(24);
    expect(input.transactionRows).toHaveLength(153);
    expect(input.landedCostTotals).toHaveLength(24);
    expect(input.salesActualRows.length).toBeGreaterThan(500);
    expect(input.salesPlanRows.length).toBeGreaterThan(500);
    expect(input.salesPlanRows.every((r) => /^-?\d+$/.test(r.qty))).toBe(true); // rounded, see EXPORT_CONVENTIONS
    expect(input.paymentRows).toHaveLength(exportPayments(snap).length + 28);
  });
});
