#!/usr/bin/env tsx
// scripts/run-daily-shopify-pull.mjs
//
// CLI entrypoint for the daily Shopify sales pull. Reads a JSON export file
// of Shopify order rows and calls runDailyShopifyPull, exiting with 0 on
// success (including when every row is skipped as a duplicate — that's
// expected, not a failure) or 1 on a hard failure (missing file, malformed
// input, or an unexpected error).
//
// Usage:
//   set -a && source .env && set +a
//   pnpm exec tsx scripts/run-daily-shopify-pull.mjs <path-to-shopify-export.json>
//
// Run with tsx, not plain `node` — this repo uses extensionless relative
// imports (and cross-directory `.ts` imports from `.mjs` scripts) that
// Node's native ESM resolver cannot resolve, even with
// --experimental-strip-types.

import { readFile } from "node:fs/promises";
import { runDailyShopifyPull } from "../server/shopifyDailyPull.ts";
import { listSkus, listWarehouses } from "../server/db.ts";

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: pnpm exec tsx scripts/run-daily-shopify-pull.mjs <path-to-shopify-export.json>");
  process.exit(1);
}

try {
  const rows = JSON.parse(await readFile(inputPath, "utf-8"));

  const skus = await listSkus("active");
  const warehouses = await listWarehouses();
  const skuLookup = Object.fromEntries(skus.filter((s) => s.sku).map((s) => [s.sku, s.id]));
  const warehouseLookup = Object.fromEntries(warehouses.map((w) => [w.code, w.id]));

  const result = await runDailyShopifyPull(rows, skuLookup, warehouseLookup);
  console.log(`Daily Shopify pull complete. Imported: ${result.imported}. Skipped: ${result.skipped.length}.`);
  if (result.skipped.length > 0) {
    console.log(JSON.stringify(result.skipped, null, 2));
  }
  process.exit(0);
} catch (err) {
  console.error("Daily Shopify pull failed:", err.message);
  process.exit(1);
}
