#!/usr/bin/env tsx
// scripts/parallel-run.ts
//
// The daily parallel run: today's live dry-run plus a day-over-day delta.
//
//   pnpm parallel-run            # live Sheet → docs/dryrun/<today>/{report.md,delta.md}, docs/dryrun/latest.md
//
// Exit code 0 when the verdict is SAFE TO CUT OVER, 1 otherwise, 2 when the
// run itself failed. Meant to be driven by a scheduler (ops/parallel-run-daily.sh
// + the launchd plist in ops/) but runs by hand just as well.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runDryRun } from "./control-tower/dryrun.ts";
import { classifyKnown } from "./control-tower/classifications.ts";
import { compareReports, renderDelta } from "./control-tower/compare.ts";

const CONTROL_TOWER_SHEET_ID = "1pSVrpDwiN6Ja2RfwVbsxj4H6J3eBRtnLtKNc1TGtoMk";
const ROOT = join("docs", "dryrun");
const today = new Date().toISOString().slice(0, 10);
const outDir = join(ROOT, today);

try {
  const result = await runDryRun({ source: { kind: "live", sheetId: CONTROL_TOWER_SHEET_ID }, outDir, classify: classifyKnown });

  const previousDate = (await readdir(ROOT, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name) && e.name < today)
    .map((e) => e.name)
    .sort()
    .at(-1) ?? null;
  const previous = previousDate ? await readFile(join(ROOT, previousDate, "report.md"), "utf-8").catch(() => null) : null;
  const delta = previous ? compareReports(previous, result.report) : null;
  const deltaMd = renderDelta({ currentDate: today, previousDate: previous ? previousDate : null, current: result.report, delta });

  await writeFile(join(outDir, "delta.md"), deltaMd);
  await writeFile(join(ROOT, "latest.md"), deltaMd);
  console.log(deltaMd);
  process.exit(result.verdict === "SAFE TO CUT OVER" ? 0 : 1);
} catch (err) {
  console.error("Parallel run failed before producing a report:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(2);
}
