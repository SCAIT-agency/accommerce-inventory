// Markdown findings report. The verdict line comes first and is the only
// thing a reader needs to act on; everything below is evidence.

import type { RunMigrationResult } from "../reconcile-migration";
import type { ExportIssue } from "./export";
import { TARGET_TITLES, type Finding, type ReconcileResult, type Target } from "./reconcile";

export interface ReportInput {
  runDate: string;
  source: string;
  today: string;
  migration: RunMigrationResult;
  exportIssues: ExportIssue[];
  reconciliation: ReconcileResult;
  /** Exporter conventions applied on every run (design §2) — stated so nothing is silent. */
  conventions: readonly string[];
}

export type Verdict = "SAFE TO CUT OVER" | "NOT SAFE TO CUT OVER";

/** Safe only when nothing is left for a human to look at and no platform bug is open. */
export function verdictFor(findings: Finding[]): Verdict {
  const blocking = findings.some((f) => f.classification === "unclassified" || f.classification === "platform_bug");
  return blocking ? "NOT SAFE TO CUT OVER" : "SAFE TO CUT OVER";
}

const fmt = (v: string | number | null | undefined): string => {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(4);
  return v;
};

export function renderReport(input: ReportInput): string {
  const { findings, checked } = input.reconciliation;
  const verdict = verdictFor(findings);
  const targets = Object.keys(TARGET_TITLES) as Target[];
  const lines: string[] = [];

  const pending = findings.filter((f) => f.classification === "sheet_bug" || f.classification === "convention").length;
  lines.push(`# Real-data dry-run — ${input.runDate}`, "");
  lines.push(
    `**Verdict: ${verdict}**` +
      (verdict === "SAFE TO CUT OVER" && pending > 0
        ? ` — ${pending} item${pending === 1 ? " needs" : "s need"} your decision (Sheet bugs / conventions); none blocks the platform`
        : ""),
    "",
  );
  lines.push(`Source: ${input.source} · today = ${input.today}`, "");

  lines.push("## Summary", "", "| Target | Checked | Mismatched | Unclassified |", "|---|---:|---:|---:|");
  for (const t of targets) {
    const mine = findings.filter((f) => f.target === t);
    lines.push(`| ${t} — ${TARGET_TITLES[t]} | ${checked[t]} | ${mine.length} | ${mine.filter((f) => f.classification === "unclassified").length} |`);
  }
  lines.push("");
  const q = input.migration.quarantined;
  const quarantinedTotal = Object.values(q).reduce((n, arr) => n + arr.length, 0);
  lines.push(
    `Migration: ${input.migration.counts.paidPayments} paid payments transferred, ${input.migration.counts.matchedTransactions} transaction links transferred, ` +
      `${quarantinedTotal} rows quarantined, ${input.migration.unmatchedManualLinks.length} links not transferable, ${input.exportIssues.length} export issues.`,
    "",
  );

  lines.push("## Findings by target", "");
  for (const t of targets) {
    const mine = findings.filter((f) => f.target === t);
    lines.push(`### ${t} — ${TARGET_TITLES[t]}`, "");
    if (mine.length === 0) {
      lines.push(`All ${checked[t]} checks matched.`, "");
      continue;
    }
    lines.push("| Key | Sheet | Platform | Diff | Class | Note |", "|---|---:|---:|---:|---|---|");
    for (const f of mine) {
      lines.push(`| ${f.key} | ${fmt(f.sheet)} | ${fmt(f.platform)} | ${fmt(f.diff)} | ${f.classification} | ${f.note ?? ""} |`);
    }
    lines.push("");
  }

  lines.push("## Quarantines", "");
  if (quarantinedTotal === 0) lines.push("None.", "");
  for (const [entity, rows] of Object.entries(q)) {
    if (rows.length === 0) continue;
    lines.push(`- **${entity}** (${rows.length})`);
    for (const r of rows) lines.push(`  - row ${r.rowIndex}: ${r.reason}`);
  }
  if (input.exportIssues.length > 0) {
    lines.push("- **export issues**");
    for (const i of input.exportIssues) lines.push(`  - ${i.entity} ${i.key}: ${i.reason}`);
  }
  lines.push("");

  lines.push("## Manual links not transferable", "");
  if (input.migration.unmatchedManualLinks.length === 0) lines.push("None.", "");
  for (const u of input.migration.unmatchedManualLinks) lines.push(`- transaction row ${u.transactionIndex}, ref \`${u.ref}\`: ${u.reason}`);
  lines.push("");

  lines.push("## Links transferred with variance", "");
  if (input.migration.linkVariances.length === 0) lines.push("None.", "");
  for (const v of input.migration.linkVariances) {
    lines.push(
      `- ${v.ref} #${v.sequenceNo}: planned ${v.expectedAmount.toFixed(2)}, paid ${v.paidAmount.toFixed(2)} (${(v.variancePct * 100).toFixed(1)}%)` +
        (v.paidInferredFromLink ? " — Sheet slot was unpaid; recorded as paid from the linked transaction" : ""),
    );
  }
  lines.push("");

  lines.push("## Conventions applied by the exporter", "");
  for (const c of input.conventions) lines.push(`- ${c}`);
  lines.push("");

  lines.push("## Needs your decision", "");
  const decisions = findings.filter((f) => f.classification === "sheet_bug" || f.classification === "convention");
  if (decisions.length === 0) lines.push("Nothing pending.", "");
  for (const f of decisions) lines.push(`- [${f.classification}] ${f.target} ${f.key}: Sheet ${fmt(f.sheet)} vs platform ${fmt(f.platform)}${f.note ? ` — ${f.note}` : ""}`);
  lines.push("");

  return lines.join("\n");
}
