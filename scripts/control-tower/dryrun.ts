// Orchestrator: snapshot → reset → migrate → reconcile → report.
//
// Runs only against a database whose name ends in `_dryrun` or `_dryrun_test`
// — the process's DATABASE_URL is the one the server module already opened,
// so the guard is on that, not on an argument.

import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../server/dbClient";
import { ENV } from "../../server/_core/env";
import {
  appSettings,
  changeLog,
  inventoryLedger,
  payments,
  poLineItems,
  purchaseOrders,
  salesActuals,
  salesPlan,
  shipmentLineItems,
  shipments,
  skus,
  transactions,
  vendors,
  warehouses,
} from "../../drizzle/schema";
import { listSkus, listWarehouses, setAppSetting } from "../../server/db";
import { ALLOW_BACKORDERS_SETTING, getSoh } from "../../server/inventoryLedger";
import { computeFifoDailySeries, getShipmentLandedUnitCost } from "../../server/landedCost";
import { runMigration, type RunMigrationResult } from "../reconcile-migration";
import { computePlannedShipmentQty, type Mismatch } from "../migrate-from-sheet";
import { buildMigrationInput, EXPORT_CONVENTIONS, type ExportIssue } from "./export";
import { liveTabFetcher } from "./gviz";
import { EMPTY_CHECKED, reconcile, TOLERANCE, unclassified, type Classifier, type Finding, type ReconcileDeps, type ReconcileResult } from "./reconcile";
import { renderReport, verdictFor, type Verdict } from "./report";
import { buildSnapshot, loadFixtureSnapshot, type ControlTowerSnapshot } from "./snapshot";

export type DryRunSource = { kind: "live"; sheetId: string } | { kind: "fixture" } | { kind: "snapshot"; dir: string };

export interface DryRunOptions {
  source: DryRunSource;
  outDir: string;
  /** YYYY-MM-DD. Defaults to the fixture's capture day for fixtures, else the current UTC day. */
  today?: string;
  classify?: Classifier;
}

export interface DryRunResult {
  verdict: Verdict;
  findings: Finding[];
  reportPath: string;
  report: string;
}

export const FIXTURE_TODAY = "2026-09-19";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function assertDryRunDatabase(databaseUrl: string): string {
  const name = new URL(databaseUrl).pathname.replace(/^\//, "");
  if (!/_dryrun(_test)?$/.test(name)) {
    throw new Error(`refusing to run the dry-run against database "${name}" — the name must end in _dryrun or _dryrun_test`);
  }
  return name;
}

async function loadSnapshot(source: DryRunSource): Promise<{ snap: ControlTowerSnapshot; label: string }> {
  switch (source.kind) {
    case "live":
      return { snap: await buildSnapshot(liveTabFetcher(source.sheetId)), label: `live Sheet ${source.sheetId}` };
    case "fixture":
      return { snap: await loadFixtureSnapshot(), label: "fixtures captured 2026-09-19" };
    case "snapshot":
      return { snap: JSON.parse(await readFile(join(source.dir, "snapshot.json"), "utf-8")), label: `snapshot ${source.dir}` };
  }
}

/** Apply migrations (idempotent) and empty every table except users. */
export async function resetDatabase(): Promise<void> {
  execFileSync("pnpm", ["exec", "drizzle-kit", "migrate"], { cwd: REPO_ROOT, stdio: "pipe", env: process.env });
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
    try {
      for (const table of [changeLog, appSettings, salesActuals, salesPlan, inventoryLedger, transactions, payments, shipmentLineItems, shipments, poLineItems, purchaseOrders, skus, vendors, warehouses]) {
        await tx.delete(table);
      }
    } finally {
      await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
    }
  });
}

/** Platform reads for the reconciliation, built from the real server functions after the migration committed. */
export async function realReconcileDeps(): Promise<ReconcileDeps> {
  const skuByCode = new Map((await listSkus()).map((s) => [s.sku!, s.id]));
  const warehouseByCode = new Map((await listWarehouses()).map((w) => [w.code, w.id]));
  const ids = (sku: string, warehouse: string) => {
    const skuId = skuByCode.get(sku);
    const warehouseId = warehouseByCode.get(warehouse);
    return skuId !== undefined && warehouseId !== undefined ? { skuId, warehouseId } : null;
  };

  return {
    async getSoh(sku, warehouse, asOf) {
      const pair = ids(sku, warehouse);
      return pair ? getSoh(pair.skuId, pair.warehouseId, asOf) : Number.NaN;
    },
    async getDailySeries(sku, warehouse, from, to) {
      const pair = ids(sku, warehouse);
      if (!pair) return [];
      const events = await db
        .select()
        .from(inventoryLedger)
        .where(and(eq(inventoryLedger.skuId, pair.skuId), eq(inventoryLedger.warehouseId, pair.warehouseId)))
        .orderBy(inventoryLedger.date, inventoryLedger.id);
      const receipts = events.filter((e) => e.eventType === "receipt").map((e) => ({ qty: e.qty, unitCost: parseFloat(e.unitCost ?? "0"), date: e.date }));
      const sales = events.filter((e) => e.eventType === "sale").map((e) => ({ qty: -e.qty, date: e.date }));
      return computeFifoDailySeries(receipts, sales, from, to);
    },
    async getLandedCost(shipmentRef, sku) {
      const [shipment] = await db.select().from(shipments).where(eq(shipments.shipmentRef, shipmentRef));
      const skuId = skuByCode.get(sku);
      if (!shipment || skuId === undefined) return Number.NaN;
      const line = (await getShipmentLandedUnitCost(shipment.id)).find((l) => l.skuId === skuId);
      return line ? line.landedUnitCost : Number.NaN;
    },
    async getShipmentLineQty(shipmentRef, sku) {
      const [shipment] = await db.select().from(shipments).where(eq(shipments.shipmentRef, shipmentRef));
      const skuId = skuByCode.get(sku);
      if (!shipment || skuId === undefined) return Number.NaN;
      const lines = await db.select().from(shipmentLineItems).where(and(eq(shipmentLineItems.shipmentId, shipment.id), eq(shipmentLineItems.skuId, skuId)));
      return lines.length === 0 ? Number.NaN : lines.reduce((a, l) => a + l.qty, 0);
    },
    async listPayments(owner) {
      const rows =
        "poNumber" in owner
          ? await db.select({ p: payments }).from(payments).innerJoin(purchaseOrders, eq(payments.poId, purchaseOrders.id)).where(eq(purchaseOrders.poNumber, owner.poNumber))
          : await db.select({ p: payments }).from(payments).innerJoin(shipments, eq(payments.shipmentId, shipments.id)).where(eq(shipments.shipmentRef, owner.shipmentRef));
      return rows.map(({ p }) => ({
        sequenceNo: p.sequenceNo,
        expectedAmount: parseFloat(p.expectedAmount),
        expectedDate: p.expectedDate.toISOString().slice(0, 10),
        paid: p.paid,
        paidDate: p.paidDate ? p.paidDate.toISOString().slice(0, 10) : null,
      }));
    },
    async transactionStats() {
      const rows = await db.select().from(transactions);
      return {
        count: rows.length,
        sumEur: rows.reduce((a, t) => a + parseFloat(t.amount) * parseFloat(t.fxRate), 0),
        matched: rows.filter((t) => t.matchedPaymentId !== null).length,
      };
    },
    async salesActualTotals() {
      const rows = await db.select().from(salesActuals);
      const skuById = new Map([...skuByCode].map(([code, id]) => [id, code]));
      const whById = new Map([...warehouseByCode].map(([code, id]) => [id, code]));
      const out = new Map<string, number>();
      for (const r of rows) {
        const key = `${skuById.get(r.skuId)}|${whById.get(r.warehouseId)}`;
        out.set(key, (out.get(key) ?? 0) + r.qty);
      }
      return out;
    },
  };
}

const GATE_PREFIX = "migration reconciliation failed: ";

/** A failed in-transaction gate rolled everything back; surface its mismatches as findings instead of a stack trace. */
function gateFindings(err: unknown, classify: Classifier): Finding[] | null {
  const message = err instanceof Error ? err.message : String(err);
  if (!message.startsWith(GATE_PREFIX)) return null;
  const mismatches = JSON.parse(message.slice(GATE_PREFIX.length)) as Mismatch[];
  return mismatches.map((m) => {
    const base = {
      target: (m.kind === "soh" ? "R1" : "R4") as "R1" | "R4",
      key: m.kind === "soh" ? `${m.sku}/${m.warehouseCode} (migration gate — rolled back)` : `${m.warehouseCode} / ${m.sku} (migration gate — rolled back)`,
      sheet: m.expected,
      platform: Number.isFinite(m.actual) ? m.actual : null,
      diff: typeof m.diff === "number" && Number.isFinite(m.diff) ? m.diff : undefined,
    };
    return { ...base, ...classify(base) };
  });
}

export async function runDryRun(opts: DryRunOptions): Promise<DryRunResult> {
  const dbName = assertDryRunDatabase(ENV.databaseUrl);
  const classify = opts.classify ?? unclassified;
  const today = opts.today ?? (opts.source.kind === "fixture" ? FIXTURE_TODAY : new Date().toISOString().slice(0, 10));
  const runDate = new Date().toISOString().slice(0, 10);

  const { snap, label } = await loadSnapshot(opts.source);
  const exported = buildMigrationInput(snap, today);
  await mkdir(opts.outDir, { recursive: true });
  await writeFile(join(opts.outDir, "snapshot.json"), JSON.stringify(snap));
  await writeFile(join(opts.outDir, "migration-input.json"), JSON.stringify(exported.input, null, 2));

  await resetDatabase();
  await setAppSetting(ALLOW_BACKORDERS_SETTING, "true");

  let migration: RunMigrationResult;
  let reconciliation: ReconcileResult;
  const exportIssues: ExportIssue[] = exported.issues;
  try {
    migration = await runMigration(exported.input, { landedCostTolerance: () => TOLERANCE.landedCost });
    reconciliation = await reconcile(
      {
        snap,
        today,
        untransferableLinks: migration.unmatchedManualLinks.length,
        linkVariances: migration.linkVariances,
        plannedShipmentQtyBySkuWarehouse: computePlannedShipmentQty(exported.input.shipmentRows),
      },
      await realReconcileDeps(),
      classify,
    );
  } catch (err) {
    const findings = gateFindings(err, classify);
    if (!findings) throw err;
    migration = {
      quarantined: { ledger: [], purchaseOrders: [], shipments: [], payments: [], transactions: [], salesActuals: [], salesPlan: [] },
      unmatchedManualLinks: [],
      linkVariances: [],
      counts: { matchedTransactions: 0, paidPayments: 0 },
    };
    reconciliation = { findings, checked: { ...EMPTY_CHECKED, R1: findings.length } };
  }

  // Quarantined rows, exporter issues and untransferable links are findings
  // too: each one is data the Sheet holds and the platform now does not, so
  // it must be classified before the verdict can be SAFE.
  const extra: Finding[] = [];
  const addExtra = (base: Omit<Finding, "classification" | "note">) => extra.push({ ...base, ...classify(base) });
  for (const [entity, rows] of Object.entries(migration.quarantined)) {
    for (const r of rows) addExtra({ target: "Q", key: `${entity} row ${r.rowIndex}: ${r.reason}`, sheet: null, platform: null });
  }
  for (const i of exportIssues) addExtra({ target: "Q", key: `${i.entity} ${i.key}: ${i.reason}`, sheet: null, platform: null });
  for (const u of migration.unmatchedManualLinks) addExtra({ target: "L", key: `transaction row ${u.transactionIndex} → ${u.ref}: ${u.reason}`, sheet: u.ref, platform: null });
  reconciliation = {
    findings: [...reconciliation.findings, ...extra],
    checked: { ...reconciliation.checked, Q: extra.filter((f) => f.target === "Q").length, L: extra.filter((f) => f.target === "L").length },
  };

  const report = renderReport({ runDate, source: `${label} → ${dbName}`, today, migration, exportIssues, reconciliation, conventions: EXPORT_CONVENTIONS });
  const reportPath = join(opts.outDir, "report.md");
  await writeFile(reportPath, report);
  return { verdict: verdictFor(reconciliation.findings), findings: reconciliation.findings, reportPath, report };
}
