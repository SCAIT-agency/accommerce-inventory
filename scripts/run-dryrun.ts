#!/usr/bin/env tsx
// scripts/run-dryrun.ts
//
// One-command real-data dry-run: live Control Tower Sheet → snapshot → fresh
// local database → migration → reconciliation → markdown report.
//
// Usage:
//   pnpm dryrun                       # live Sheet, output under docs/dryrun/<today>/
//   pnpm dryrun --fixture             # replay the committed fixtures
//   pnpm dryrun --snapshot <dir>      # replay a saved docs/dryrun/<date>/ directory
//   pnpm dryrun --out <dir>           # override the output directory
//
// DATABASE_URL must point at a database whose name ends in _dryrun (the
// script refuses anything else). Exit code 0 only on SAFE TO CUT OVER.

import { join } from "node:path";
import { runDryRun, type DryRunSource } from "./control-tower/dryrun.ts";
import { classifyKnown } from "./control-tower/classifications.ts";

const CONTROL_TOWER_SHEET_ID = "1pSVrpDwiN6Ja2RfwVbsxj4H6J3eBRtnLtKNc1TGtoMk";

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(name);
const value = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

const snapshotDir = value("--snapshot");
const source: DryRunSource = flag("--fixture")
  ? { kind: "fixture" }
  : snapshotDir
    ? { kind: "snapshot", dir: snapshotDir }
    : { kind: "live", sheetId: CONTROL_TOWER_SHEET_ID };
const outDir = value("--out") ?? join("docs", "dryrun", new Date().toISOString().slice(0, 10));

try {
  const result = await runDryRun({ source, outDir, classify: classifyKnown });
  console.log(result.report);
  console.log(`\nReport written to ${result.reportPath}`);
  process.exit(result.verdict === "SAFE TO CUT OVER" ? 0 : 1);
} catch (err) {
  console.error("Dry-run failed before producing a report:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(2);
}
