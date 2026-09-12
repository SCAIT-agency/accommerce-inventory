#!/usr/bin/env tsx
// scripts/run-parallel-check.mjs
//
// CLI entrypoint for the parallel-run comparison check. Reads a JSON export of
// today's sheet snapshot and verifies that Control Tower (db) matches it
// perfectly for all SKU/warehouse pairs.
//
// Usage:
//   pnpm exec tsx scripts/run-parallel-check.mjs <path-to-todays-sheet-snapshot.json>
//
// JSON format: array of { sku, warehouseCode, sohFromSheet }
// Exits 0 (safeToCutOver: true) only if all balances match exactly.

import { readFile } from "node:fs/promises";
import { db } from "../server/dbClient.ts";
import { listSkus, listWarehouses } from "../server/db.ts";
import { getSoh } from "../server/inventoryLedger.ts";
import { generateParallelRunReport } from "./parallel-run-report.ts";

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: pnpm exec tsx scripts/run-parallel-check.mjs <path-to-todays-sheet-snapshot.json>");
  process.exit(1);
}

try {
  const sheetSnapshot = JSON.parse(await readFile(inputPath, "utf-8"));

  // Build lookup maps for SKU and warehouse IDs.
  const skuByCode = new Map((await listSkus()).map((s) => [s.sku, s.id]));
  const warehouseByCode = new Map((await listWarehouses()).map((w) => [w.code, w.id]));

  // Construct the reconciliation deps with a getMigratedSoh function.
  const deps = {
    getMigratedSoh: async (sku, warehouseCode) => {
      const skuId = skuByCode.get(sku);
      const warehouseId = warehouseByCode.get(warehouseCode);
      if (!skuId || !warehouseId) {
        // SKU or warehouse not found in Control Tower — return 0 so the mismatch
        // is visible (sheet expects data but Control Tower has none).
        return 0;
      }
      return getSoh(skuId, warehouseId);
    },
  };

  const report = await generateParallelRunReport(sheetSnapshot, deps);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.safeToCutOver ? 0 : 1);
} catch (err) {
  console.error("Parallel-run check failed:", err.message);
  process.exit(1);
}
