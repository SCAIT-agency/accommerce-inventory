// Reconciliation targets R1..R7 (design §4). Pure comparison: every platform
// read is injected, so the same code runs against the real database in the
// dry-run and against fakes in tests. The module never decides what a
// divergence *means* — classification is injected too, and defaults to
// "unclassified", which keeps the verdict at NOT SAFE until a human has
// looked at each finding.

import type { DailyFifoRow } from "../../server/landedCost";
import { exportPayments, exportShipmentPayments, exportShipments, platformShipmentRef } from "./export";
import { transformPayments, transformShipments, resolveShipmentOwnerRef } from "../migrate-from-sheet";
import type { LinkVariance } from "../reconcile-migration";
import type { ControlTowerSnapshot } from "./snapshot";
import {
  WAREHOUSES,
  pairKey,
  readDailyCogsTarget,
  readLandedCostTarget,
  readSalesActuals,
  readSohToday,
  readStockByDay,
  seriesKey,
  skuCodes,
} from "./targets";

export type Target = "R1" | "R2" | "R3" | "R4" | "R5" | "R6" | "R7" | "Q" | "L";

export const TARGET_TITLES: Record<Target, string> = {
  R1: "SOH today per SKU/warehouse (Inventory Ledger — Current On-Hand)",
  R2: "SOH by day (StockModel — Stock)",
  R3: "Daily COGS (Opening Qty/Value, Units Sold, COGS, Unpriced)",
  R4: "Landed cost per shipment line (Landed Cost Summary, net of EUST/VAT)",
  R5: "Payments per PO and per shipment (slots, amounts, paid flags, dates)",
  R6: "Transactions (count, EUR total, transferred matches)",
  R7: "Sales actuals per SKU/warehouse (totals)",
  Q: "Rows the migration quarantined or the exporter could not map",
  L: "Sheet match hints the migration could not transfer",
};

export const EMPTY_CHECKED: Record<Target, number> = { R1: 0, R2: 0, R3: 0, R4: 0, R5: 0, R6: 0, R7: 0, Q: 0, L: 0 };

export type Classification = "platform_bug" | "sheet_bug" | "convention" | "unclassified";

export interface Finding {
  target: Target;
  key: string;
  sheet: string | number | null;
  platform: string | number | null;
  diff?: number;
  classification: Classification;
  note?: string;
}

export type Classifier = (finding: Omit<Finding, "classification" | "note">) => { classification: Classification; note?: string };

export const unclassified: Classifier = () => ({ classification: "unclassified" });

export interface PaymentRead {
  sequenceNo: number;
  expectedAmount: number;
  expectedDate: string; // YYYY-MM-DD
  paid: boolean;
  paidDate: string | null;
}

export type PaymentOwner = { poNumber: string } | { shipmentRef: string };

export interface ReconcileDeps {
  getSoh(sku: string, warehouse: string, asOf?: Date): Promise<number>;
  getDailySeries(sku: string, warehouse: string, from: Date, to: Date): Promise<DailyFifoRow[]>;
  /** NaN when the platform has no such line. */
  getLandedCost(shipmentRef: string, sku: string): Promise<number>;
  /** qty on the platform's shipment line; NaN when absent. */
  getShipmentLineQty(shipmentRef: string, sku: string): Promise<number>;
  listPayments(owner: PaymentOwner): Promise<PaymentRead[]>;
  transactionStats(): Promise<{ count: number; sumEur: number; matched: number }>;
  /** pairKey(sku, warehouse) → total qty in sales_actuals */
  salesActualTotals(): Promise<Map<string, number>>;
}

export interface ReconcileInput {
  snap: ControlTowerSnapshot;
  /** YYYY-MM-DD; StockModel rows after this day are forecasts and are not compared. */
  today: string;
  /** How many Sheet match hints the migration could not transfer (they stay unmatched on purpose). */
  untransferableLinks: number;
  /** Links the migration transferred with an amount variance or onto a slot the Sheet had not marked paid. */
  linkVariances?: LinkVariance[];
}

export interface ReconcileResult {
  findings: Finding[];
  checked: Record<Target, number>;
}

export const TOLERANCE = {
  money: 0.01, // Sheet rounds € to cents
  landedCost: 1e-6, // both sides hold full precision
} as const;

const utc = (day: string) => new Date(`${day}T00:00:00.000Z`);
const endOfPreviousDay = (day: string) => new Date(utc(day).getTime() - 1);
const dateKey = (d: Date): string => d.toISOString().slice(0, 10);

export async function reconcile(input: ReconcileInput, deps: ReconcileDeps, classify: Classifier = unclassified): Promise<ReconcileResult> {
  const { snap, today } = input;
  const findings: Finding[] = [];
  const checked: Record<Target, number> = { ...EMPTY_CHECKED };

  const add = (target: Target, key: string, sheet: Finding["sheet"], platform: Finding["platform"], diff?: number) => {
    const base = { target, key, sheet, platform, diff };
    findings.push({ ...base, ...classify(base) });
  };
  const numbersDiffer = (a: number, b: number, tol: number) => !Number.isFinite(b) || Math.abs(a - b) > tol;

  // R1 — SOH today
  for (const fact of readSohToday(snap)) {
    checked.R1++;
    const platform = await deps.getSoh(fact.sku, fact.warehouse);
    if (platform !== fact.qty) add("R1", `${fact.sku}/${fact.warehouse}`, fact.qty, platform, platform - fact.qty);
  }

  // R2 — SOH by day: StockModel Stock[r] is the start-of-day position, i.e.
  // everything landed and sold through r−1. Only real days (≤ today) count.
  const stock = readStockByDay(snap);
  const sales = readSalesActuals(snap, today);
  const firstSalesDay = sales.map((s) => s.date).sort()[0];
  for (const wh of WAREHOUSES) {
    for (const sku of skuCodes(snap)) {
      for (const [key, sheetStock] of stock) {
        const [k1, k2, day] = key.split("|");
        if (k1 !== sku || k2 !== wh.code || day > today || (firstSalesDay && day < firstSalesDay)) continue;
        checked.R2++;
        const platform = await deps.getSoh(sku, wh.code, endOfPreviousDay(day));
        if (platform !== sheetStock) add("R2", `${sku}/${wh.code} ${day}`, sheetStock, platform, platform - sheetStock);
      }
    }
  }

  // R3 — Daily COGS
  const cogsTarget = readDailyCogsTarget(snap);
  for (const wh of WAREHOUSES) {
    for (const sku of skuCodes(snap)) {
      const days = [...cogsTarget.keys()]
        .filter((k) => k.startsWith(`${sku}|${wh.code}|`))
        .map((k) => k.split("|")[2])
        .filter((d) => d <= today)
        .sort();
      if (days.length === 0) continue;
      const series = await deps.getDailySeries(sku, wh.code, utc(days[0]), utc(days[days.length - 1]));
      const byDay = new Map(series.map((r) => [r.date, r]));
      for (const day of days) {
        const expected = cogsTarget.get(seriesKey(sku, wh.code, day))!;
        const row = byDay.get(day);
        checked.R3++;
        const prefix = `${sku}/${wh.code} ${day}`;
        if (!row) {
          add("R3", `${prefix} (missing day)`, expected.soldQty, null);
          continue;
        }
        const fields: [keyof typeof expected, number][] = [
          ["openingQty", 0],
          ["soldQty", 0],
          ["unpricedQty", 0],
          ["openingValue", TOLERANCE.money],
          ["cogs", TOLERANCE.money],
        ];
        for (const [field, tol] of fields) {
          const got = row[field];
          if (numbersDiffer(expected[field], got, tol)) add("R3", `${prefix} ${field}`, expected[field], got, got - expected[field]);
        }
      }
    }
  }

  // R4 — landed cost per shipment line (and the line's qty, which the Sheet's
  // Landed Cost Summary restates from Shipments and can disagree with)
  for (const fact of readLandedCostTarget(snap)) {
    checked.R4++;
    // Each Landed Cost Summary row is already scoped to one SKU (fact.sku),
    // so the pooled-ref suffix check is exact — same as migrate-from-sheet.ts's
    // own per-row check, not "any SKU in the catalog" (see export.ts's
    // platformShipmentRef doc for the bug that loose check caused).
    const platformRef = platformShipmentRef(fact.shipmentRef, [fact.sku]);
    const platform = await deps.getLandedCost(platformRef, fact.sku);
    if (numbersDiffer(fact.landedCost, platform, TOLERANCE.landedCost)) {
      add("R4", `${fact.shipmentRef} / ${fact.sku}`, fact.landedCost, Number.isFinite(platform) ? platform : null, Number.isFinite(platform) ? platform - fact.landedCost : undefined);
    }
    const qty = await deps.getShipmentLineQty(platformRef, fact.sku);
    if (qty !== fact.qty) add("R4", `${fact.shipmentRef} / ${fact.sku} qty`, fact.qty, Number.isFinite(qty) ? qty : null, Number.isFinite(qty) ? qty - fact.qty : undefined);
  }

  // R5 — payments per owner (PO number or shipment ref).
  //
  // ADAPTATION (Task 7): on the source branch exportPayments/
  // exportShipmentPayments already returned the pooled, per-owner "expected"
  // shape (Container-N rows merged, amounts summed) because export.ts did
  // that grouping itself. Task 5/6 moved that grouping into
  // migrate-from-sheet.ts's transformPayments, and Task 7 in turn stopped
  // export.ts pre-merging shipment-owned payment rows (see export.ts's
  // module comment) — exportShipmentPayments now returns one raw row per
  // Sheet row × slot. So the "expected" values here are computed by running
  // those raw rows through the SAME transformPayments pooling runMigration
  // actually uses, instead of re-deriving (and risking disagreeing with) it.
  // PO-owned rows are unaffected (POs never pool; transformPayments passes
  // them through as one row per PO×sequence, same as before).
  //
  // FINDING 1/2 (2026-09-21 final review): transformPayments now requires a
  // known-pooled-owners set (see migrate-from-sheet.ts's pooledPaymentOwnerRef
  // doc) rather than pooling on the bare Container-N regex alone, so this
  // must run the same shipment rows through transformShipments first — the
  // real, single source of truth for which owners actually pooled — instead
  // of guessing independently. And a lone (singly) pooled container's
  // payment slot needs the SAME extra raw-first/pooled-fallback resolution
  // runMigration itself applies (resolveShipmentOwnerRef, shared with
  // reconcile-migration.ts) — re-deriving owner resolution here instead of
  // reusing it is exactly what caused R5 to disagree with the real
  // migration for that case.
  const { shipments: expectedShipments, pooledOwnerRefs } = transformShipments(exportShipments(snap).rows);
  const knownShipmentRefs = new Set(expectedShipments.map((s) => s.shipmentRef));
  const { payments: expectedPayments } = transformPayments([...exportPayments(snap), ...exportShipmentPayments(snap)], pooledOwnerRefs);
  const ownerOf = (p: (typeof expectedPayments)[number]) =>
    p.poNumber ?? resolveShipmentOwnerRef(p.shipmentRef!, knownShipmentRefs, pooledOwnerRefs);
  const owners = [...new Set(expectedPayments.map(ownerOf))];
  for (const owner of owners) {
    const expected = expectedPayments.filter((p) => ownerOf(p) === owner);
    const actual = await deps.listPayments(expected[0].poNumber !== null ? { poNumber: owner } : { shipmentRef: owner });
    checked.R5++;
    if (actual.length !== expected.length) {
      add("R5", `${owner} slot count`, expected.length, actual.length, actual.length - expected.length);
      continue;
    }
    for (const slot of expected) {
      const got = actual.find((a) => a.sequenceNo === slot.sequenceNo);
      const prefix = `${owner} #${slot.sequenceNo}`;
      if (!got) {
        add("R5", `${prefix} missing`, slot.expectedAmount, null);
        continue;
      }
      const amount = parseFloat(slot.expectedAmount);
      if (numbersDiffer(amount, got.expectedAmount, TOLERANCE.money)) add("R5", `${prefix} amount`, amount, got.expectedAmount, got.expectedAmount - amount);
      const expectedDateStr = dateKey(slot.expectedDate);
      if (expectedDateStr !== got.expectedDate) add("R5", `${prefix} planned date`, expectedDateStr, got.expectedDate);
      const paid = slot.paid;
      // A slot the Sheet left unpaid but linked a transaction to is paid on the
      // platform by that link (reported under "Links transferred with variance").
      const inferred = (input.linkVariances ?? []).some((v) => v.ref === owner && v.sequenceNo === slot.sequenceNo && v.paidInferredFromLink);
      if (paid !== got.paid && !(inferred && got.paid)) add("R5", `${prefix} paid`, String(paid), String(got.paid));
      const paidDateStr = slot.paidDate ? dateKey(slot.paidDate) : null;
      if (paid && paidDateStr && paidDateStr !== got.paidDate) add("R5", `${prefix} paid date`, paidDateStr, got.paidDate);
    }
  }

  // R6 — transactions
  {
    const tab = snap.transactions;
    const eurIdx = tab.header.indexOf("Amount (EUR)");
    const refIdx = tab.header.indexOf("PO#/Shipment Ref");
    const sheetCount = tab.rows.length;
    const sheetSum = tab.rows.reduce((a, r) => a + parseFloat(r[eurIdx] || "0"), 0);
    const sheetHints = tab.rows.filter((r) => (r[refIdx] ?? "").trim() !== "").length;
    const expectedMatched = sheetHints - input.untransferableLinks;
    const stats = await deps.transactionStats();
    checked.R6 += 3;
    if (stats.count !== sheetCount) add("R6", "count", sheetCount, stats.count, stats.count - sheetCount);
    if (numbersDiffer(sheetSum, stats.sumEur, TOLERANCE.money)) add("R6", "sum EUR", Number(sheetSum.toFixed(2)), Number(stats.sumEur.toFixed(2)), stats.sumEur - sheetSum);
    if (stats.matched !== expectedMatched) add("R6", "matched (transferred hints)", expectedMatched, stats.matched, stats.matched - expectedMatched);
  }

  // R7 — sales actual totals
  {
    const totals = new Map<string, number>();
    for (const s of sales) totals.set(pairKey(s.sku, s.warehouse), (totals.get(pairKey(s.sku, s.warehouse)) ?? 0) + s.qty);
    const platform = await deps.salesActualTotals();
    for (const [key, sheetQty] of totals) {
      checked.R7++;
      const got = platform.get(key) ?? 0;
      if (got !== sheetQty) add("R7", key.replace("|", "/"), sheetQty, got, got - sheetQty);
    }
  }

  return { findings, checked };
}
