// scripts/run-migration.ts
//
// CLI entrypoint for the migration. Reads a JSON export file and calls runMigration,
// exiting with 0 on success (quarantined rows logged) or 1 on failure
// (a reconciliation failure inside runMigration's own db.transaction is fully
// rolled back; a failure before that — bad path, missing file, malformed
// JSON — never opens a transaction, so there is nothing to roll back).
//
// Usage:
//   pnpm exec tsx scripts/run-migration.ts <path-to-exported-sheet-data.json>

import { readFile } from "node:fs/promises";
import { runMigration } from "./reconcile-migration.ts";

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: pnpm exec tsx scripts/run-migration.ts <path-to-exported-sheet-data.json>");
  process.exit(1);
}

// The 6 array fields RunMigrationInput requires — validated up front so a
// missing key fails with a clear, named message instead of a raw
// "Cannot read properties of undefined" thrown deep inside runMigration.
const REQUIRED_ARRAY_FIELDS = ["ledgerRows", "poRows", "shipmentRows", "paymentRows", "transactionRows", "sheetTotals"];

try {
  const input = JSON.parse(await readFile(inputPath, "utf-8"));

  const missingOrInvalid = REQUIRED_ARRAY_FIELDS.filter((field) => !Array.isArray(input[field]));
  if (missingOrInvalid.length > 0) {
    console.error(`Malformed input: missing or non-array field(s) ${missingOrInvalid.join(", ")} in ${inputPath}`);
    process.exit(1);
  }

  const result = await runMigration(input);

  const totalQuarantined = Object.values(result.quarantined).reduce((sum, arr) => sum + arr.length, 0);
  console.log(`Migration complete. Quarantined rows: ${totalQuarantined}`);
  if (totalQuarantined > 0) {
    console.log(JSON.stringify(result.quarantined, null, 2));
  }
  process.exit(0);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error("Migration failed:", message);
  process.exit(1);
}
