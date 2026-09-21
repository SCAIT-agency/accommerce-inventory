import { describe, it, expect, beforeAll } from "vitest";
import { computeFifoDailySeries } from "../../server/landedCost";
import { exportPayments, exportShipmentPayments, exportShipments, platformShipmentRef } from "./export";
import { transformPayments, transformShipments, resolveShipmentOwnerRef } from "../migrate-from-sheet";
import { reconcile, type ReconcileDeps } from "./reconcile";
import { loadFixtureSnapshot, type ControlTowerSnapshot } from "./snapshot";
import { pairKey, readLandedCostTarget, readReceipts, readSalesActuals, readSohToday, readStockByDay, seriesKey } from "./targets";

const TODAY = "2026-09-19";
const utc = (s: string) => new Date(`${s}T00:00:00.000Z`);

let snap: ControlTowerSnapshot;
beforeAll(async () => {
  snap = await loadFixtureSnapshot();
});

/** Fake platform reads that answer exactly what the Sheet says — the "perfect migration". */
function perfectDeps(forSnap: ControlTowerSnapshot = snap): ReconcileDeps {
  const stock = readStockByDay(forSnap);
  const receipts = readReceipts(forSnap);
  const sales = readSalesActuals(forSnap, TODAY);
  const landed = readLandedCostTarget(forSnap);
  // Mirrors reconcile.ts's own R5 computation: exportShipmentPayments now
  // emits raw, un-pooled rows (Task 7 adaptation — see export.ts's module
  // comment), so the "true" post-migration payment shape is obtained by
  // running them through the same transformPayments pooling runMigration
  // itself uses, not by re-deriving it here. That pooling now requires the
  // real known-pooled-owners set from transformShipments (Finding 1), and a
  // lone pooled container's payment slot needs the same extra owner
  // resolution runMigration applies (resolveShipmentOwnerRef, Finding 2) —
  // both threaded through here exactly as reconcile.ts's own R5 does, so
  // this fake keeps mirroring the real migration, not a stale approximation.
  const { shipments: mockShipments, pooledOwnerRefs } = transformShipments(exportShipments(forSnap).rows);
  const knownShipmentRefs = new Set(mockShipments.map((s) => s.shipmentRef));
  const { payments: pooledPayments } = transformPayments([...exportPayments(forSnap), ...exportShipmentPayments(forSnap)], pooledOwnerRefs);
  const paymentsByOwner = new Map<string, typeof pooledPayments>();
  for (const p of pooledPayments) {
    const owner = p.poNumber ?? resolveShipmentOwnerRef(p.shipmentRef!, knownShipmentRefs, pooledOwnerRefs);
    paymentsByOwner.set(owner, [...(paymentsByOwner.get(owner) ?? []), p]);
  }
  const skus = ["Jello", "Mixer", "Straw"];
  const lineQty = new Map<string, number>();
  for (const r of forSnap.shipments.rows) {
    const ref = platformShipmentRef(r[forSnap.shipments.header.indexOf("Shipment ID")], skus);
    for (const sku of ["Jello", "Mixer", "Straw"]) {
      const q = r[forSnap.shipments.header.indexOf(`${sku} Qty`)];
      if (q) lineQty.set(`${ref}::${sku}`, (lineQty.get(`${ref}::${sku}`) ?? 0) + parseFloat(q));
    }
  }
  const tab = forSnap.transactions;
  const eur = tab.header.indexOf("Amount (EUR)");
  const ref = tab.header.indexOf("PO#/Shipment Ref");
  return {
    async getSoh(sku, wh, asOf) {
      if (!asOf) return readSohToday(forSnap).find((s) => s.sku === sku && s.warehouse === wh)!.qty;
      const day = new Date(asOf.getTime() + 1).toISOString().slice(0, 10);
      return stock.get(seriesKey(sku, wh, day)) ?? Number.NaN;
    },
    async getDailySeries(sku, wh, from, to) {
      return computeFifoDailySeries(
        receipts.filter((r) => r.sku === sku && r.warehouse === wh).map((r) => ({ qty: r.qty, unitCost: r.unitCost, date: utc(r.date) })),
        sales.filter((s) => s.sku === sku && s.warehouse === wh).map((s) => ({ qty: s.qty, date: utc(s.date) })),
        from,
        to,
      );
    },
    async getLandedCost(shipmentRef, sku) {
      return landed.find((l) => platformShipmentRef(l.shipmentRef, skus) === shipmentRef && l.sku === sku)?.landedCost ?? Number.NaN;
    },
    async getShipmentLineQty(ref, sku) {
      return lineQty.get(`${ref}::${sku}`) ?? Number.NaN;
    },
    async listPayments(owner) {
      const key = "poNumber" in owner ? owner.poNumber : owner.shipmentRef;
      return (paymentsByOwner.get(key) ?? []).map((p) => ({
        sequenceNo: p.sequenceNo,
        expectedAmount: parseFloat(p.expectedAmount),
        expectedDate: p.expectedDate.toISOString().slice(0, 10),
        paid: p.paid,
        paidDate: p.paid ? p.paidDate!.toISOString().slice(0, 10) : null,
      }));
    },
    async transactionStats() {
      return {
        count: tab.rows.length,
        sumEur: tab.rows.reduce((a, r) => a + parseFloat(r[eur]), 0),
        matched: tab.rows.filter((r) => r[ref] !== "").length,
      };
    },
    async salesActualTotals() {
      const out = new Map<string, number>();
      for (const s of sales) out.set(pairKey(s.sku, s.warehouse), (out.get(pairKey(s.sku, s.warehouse)) ?? 0) + s.qty);
      return out;
    },
  };
}

describe("reconcile", () => {
  it("reports only the Sheet's own Landed Cost Summary qty error when the platform answers exactly what the Sheet says", async () => {
    const { findings, checked } = await reconcile({ snap, today: TODAY, untransferableLinks: 0 }, perfectDeps());
    // Landed Cost Summary restates "Mutual-PO2-Delivered / Mixer" with the Straw
    // row's qty (3,240) while Shipments says 700 — a Sheet-side inconsistency.
    expect(findings).toEqual([{ target: "R4", key: "Mutual-PO2-Delivered / Mixer qty", sheet: 3240, platform: 700, diff: 700 - 3240, classification: "unclassified" }]);
    // 13 PO rows = 11 distinct PO#; 13 shipment rows carry payment slots, Container 2's three merge into one
    expect(checked).toEqual({ R1: 6, R2: 6 * 96, R3: 6 * 95, R4: 24, R5: 11 + 11, R6: 3, R7: 6, Q: 0, L: 0 });
  });

  it("surfaces SOH, landed-cost, payment, transaction and sales divergences as classified findings", async () => {
    const deps = perfectDeps();
    const broken: ReconcileDeps = {
      ...deps,
      getSoh: async (sku, wh, asOf) => (await deps.getSoh(sku, wh, asOf)) + (sku === "Straw" && wh === "Mutual" ? 5 : 0),
      getLandedCost: async (ref, sku) => (ref === "PO1-Wave3" ? Number.NaN : deps.getLandedCost(ref, sku)),
      listPayments: async (owner) => (await deps.listPayments(owner)).map((p) => ("poNumber" in owner && owner.poNumber === "PO1 Jello" && p.sequenceNo === 3 ? { ...p, paid: true } : p)),
      transactionStats: async () => ({ ...(await deps.transactionStats()), matched: 17 }),
      salesActualTotals: async () => {
        const m = await deps.salesActualTotals();
        m.set(pairKey("Jello", "FF"), 1);
        return m;
      },
    };
    const { findings } = await reconcile({ snap, today: TODAY, untransferableLinks: 3 }, broken, (f) =>
      f.target === "R4" ? { classification: "platform_bug", note: "cannot cost" } : { classification: "unclassified" },
    );
    const byTarget = (t: string) => findings.filter((f) => f.target === t);
    expect(byTarget("R1")).toEqual([{ target: "R1", key: "Straw/Mutual", sheet: 2953, platform: 2958, diff: 5, classification: "unclassified" }]);
    expect(byTarget("R2")).toHaveLength(96);
    expect(byTarget("R4").filter((f) => !f.key.endsWith(" qty"))).toEqual([{ target: "R4", key: "PO1-Wave3 / Jello", sheet: expect.any(Number), platform: null, diff: undefined, classification: "platform_bug", note: "cannot cost" }]);
    expect(byTarget("R5")).toEqual([{ target: "R5", key: "PO1 Jello #3 paid", sheet: "false", platform: "true", diff: undefined, classification: "unclassified" }]);
    expect(byTarget("R6")).toEqual([]); // 20 hints − 3 untransferable = 17 expected
    expect(byTarget("R7")).toEqual([{ target: "R7", key: "Jello/FF", sheet: 158415, platform: 1, diff: 1 - 158415, classification: "unclassified" }]);
  });

  it("flags a missing platform day and money outside a cent as R3 findings", async () => {
    const deps = perfectDeps();
    const broken: ReconcileDeps = {
      ...deps,
      getDailySeries: async (sku, wh, from, to) => {
        const rows = await deps.getDailySeries(sku, wh, from, to);
        if (sku !== "Jello" || wh !== "FF") return rows;
        return rows.filter((r) => r.date !== "2026-07-07").map((r) => (r.date === "2026-07-08" ? { ...r, cogs: r.cogs + 0.02 } : r));
      },
    };
    const { findings } = await reconcile({ snap, today: TODAY, untransferableLinks: 0 }, broken);
    expect(findings.filter((f) => f.target === "R3").map((f) => f.key)).toEqual(["Jello/FF 2026-07-07 (missing day)", "Jello/FF 2026-07-08 cogs"]);
  });

  // Finding 2 (2026-09-21 final review): R5 used to compute a shipment-owned
  // payment's "owner" via transformPayments alone, while the real migration
  // (runMigration) applies an EXTRA raw-first/pooled-fallback resolution step
  // on top (resolveShipmentOwnerRef) for a container that pools genuinely but
  // with only ONE row for a given payment sequence — transformPayments' own
  // pooling needs ≥2 distinct raw refs, so a lone row keeps its raw
  // (un-pooled) ref as `shipmentRef`, and only runMigration's extra step
  // resolves it to the real pooled owner. Reproduced here by renaming a real,
  // single-SKU, single-row shipment ("PO1-Wave1-Jello") so its own sku
  // genuinely matches a fabricated Container-N suffix — transformShipments
  // pools it ALONE (same mechanics as reconcile-migration.test.ts's "resolves
  // a lone payment row on a genuinely (but singly) pooled Container-N
  // shipment" regression), while its corresponding payment row(s) stay raw.
  // If R5 used the old, unresolved owner ("TestContainer9-Jello") to query
  // the platform, it would find nothing under the real DB owner
  // ("TestContainer9") and falsely report a slot-count/missing mismatch
  // against a migration that actually ran correctly.
  it("R5 resolves a lone-row pooled container's payment owner the same way the real migration writes it (Finding 2)", async () => {
    const shipIdx = snap.shipments.header.indexOf("Shipment ID");
    const rows = snap.shipments.rows.map((r) => (r[shipIdx] === "PO1-Wave1-Jello" ? r.map((v, i) => (i === shipIdx ? "TestContainer9-Jello" : v)) : r));
    // Rename the matching Landed Cost Summary row too — R4/receipts key off
    // that tab's own ref independently of the Shipments tab, and this test
    // is about R5, not about introducing an unrelated R4/receipt mismatch.
    const landedIdx = snap.landedCostSummary.header.indexOf("Shipment ID (Wave)");
    const landedRows = snap.landedCostSummary.rows.map((r) =>
      r[landedIdx] === "PO1-Wave1-Jello" ? r.map((v, i) => (i === landedIdx ? "TestContainer9-Jello" : v)) : r,
    );
    const mutated: ControlTowerSnapshot = {
      ...snap,
      shipments: { ...snap.shipments, rows },
      landedCostSummary: { ...snap.landedCostSummary, rows: landedRows },
    };

    // perfectDeps mirrors the real migration exactly (it runs the same
    // transformShipments → transformPayments → resolveShipmentOwnerRef
    // pipeline), so its listPayments answers under the TRUE DB owner
    // ("TestContainer9") — the same ground truth R5 must independently arrive at.
    const { findings, checked } = await reconcile({ snap: mutated, today: TODAY, untransferableLinks: 0 }, perfectDeps(mutated));

    const r5ForTestContainer = findings.filter((f) => f.target === "R5" && f.key.startsWith("TestContainer9"));
    expect(r5ForTestContainer).toEqual([]);
    // Both of "PO1-Wave1-Jello"'s two filled slots (Freight 1, Customs) are checked under the pooled owner.
    expect(checked.R5).toBeGreaterThan(0);
  });
});
