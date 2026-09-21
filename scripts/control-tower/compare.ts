// Day-over-day comparison of two dry-run reports (design: "run both systems
// side by side for a defined period; investigate any divergence"). Works on
// the rendered markdown so a saved report from any day can be compared with
// any other, no database needed.

export interface ReportDigest {
  verdict: string;
  /** target id → { checked, mismatched, unclassified } from the Summary table */
  summary: Map<string, { checked: number; mismatched: number; unclassified: number }>;
  /** every finding key from the per-target tables */
  findingKeys: Set<string>;
  migrationLine: string;
}

export function digestReport(markdown: string): ReportDigest {
  // Verdict plus its qualifier ("— N items need your decision …"), so a change
  // in the number of pending decisions shows up as a verdict change.
  const verdictMatch = /^\*\*Verdict: ([^*]+)\*\*(.*)$/m.exec(markdown);
  const verdict = verdictMatch ? `${verdictMatch[1].trim()}${verdictMatch[2].trim() ? ` ${verdictMatch[2].trim()}` : ""}` : "unknown";
  const summary = new Map<string, { checked: number; mismatched: number; unclassified: number }>();
  const summaryRow = /^\| (R\d|Q|L) — [^|]+\| (\d+) \| (\d+) \| (\d+) \|$/gm;
  for (let m = summaryRow.exec(markdown); m; m = summaryRow.exec(markdown)) {
    summary.set(m[1], { checked: Number(m[2]), mismatched: Number(m[3]), unclassified: Number(m[4]) });
  }
  const findingKeys = new Set<string>();
  const findingsSection = markdown.split("## Findings by target")[1]?.split("## Quarantines")[0] ?? "";
  for (const line of findingsSection.split("\n")) {
    if (!line.startsWith("| ") || line.startsWith("| Key |") || line.startsWith("|---")) continue;
    findingKeys.add(line.slice(2, line.indexOf(" |", 2)));
  }
  const migrationLine = /^Migration: .*$/m.exec(markdown)?.[0] ?? "";
  return { verdict, summary, findingKeys, migrationLine };
}

export interface ReportDelta {
  verdictChanged: boolean;
  previousVerdict: string;
  currentVerdict: string;
  targetChanges: { target: string; previousMismatched: number; currentMismatched: number; previousChecked: number; currentChecked: number }[];
  newFindings: string[];
  resolvedFindings: string[];
}

export function compareReports(previous: string, current: string): ReportDelta {
  const a = digestReport(previous);
  const b = digestReport(current);
  const targets = new Set([...a.summary.keys(), ...b.summary.keys()]);
  const targetChanges = [...targets]
    .sort()
    .map((t) => {
      const p = a.summary.get(t) ?? { checked: 0, mismatched: 0, unclassified: 0 };
      const c = b.summary.get(t) ?? { checked: 0, mismatched: 0, unclassified: 0 };
      return { target: t, previousMismatched: p.mismatched, currentMismatched: c.mismatched, previousChecked: p.checked, currentChecked: c.checked };
    })
    .filter((x) => x.previousMismatched !== x.currentMismatched || x.previousChecked !== x.currentChecked);
  return {
    verdictChanged: a.verdict !== b.verdict,
    previousVerdict: a.verdict,
    currentVerdict: b.verdict,
    targetChanges,
    newFindings: [...b.findingKeys].filter((k) => !a.findingKeys.has(k)),
    resolvedFindings: [...a.findingKeys].filter((k) => !b.findingKeys.has(k)),
  };
}

export function renderDelta(input: { currentDate: string; previousDate: string | null; current: string; delta: ReportDelta | null }): string {
  const digest = digestReport(input.current);
  const lines: string[] = [`# Parallel run — ${input.currentDate}`, "", `**${digest.verdict}**`, "", digest.migrationLine, ""];
  if (!input.delta || !input.previousDate) {
    lines.push("First run — nothing to compare against yet.", "");
    return lines.join("\n");
  }
  const d = input.delta;
  lines.push(`## Versus ${input.previousDate}`, "");
  lines.push(d.verdictChanged ? `- Verdict changed: ${d.previousVerdict} → ${d.currentVerdict}` : "- Verdict unchanged.");
  if (d.targetChanges.length === 0) lines.push("- Mismatch counts unchanged on every target.");
  for (const t of d.targetChanges) {
    lines.push(`- ${t.target}: mismatched ${t.previousMismatched} → ${t.currentMismatched} (checked ${t.previousChecked} → ${t.currentChecked})`);
  }
  if (d.newFindings.length > 0) {
    lines.push("", "### New findings", "");
    for (const k of d.newFindings) lines.push(`- ${k}`);
  }
  if (d.resolvedFindings.length > 0) {
    lines.push("", "### Resolved since last run", "");
    for (const k of d.resolvedFindings) lines.push(`- ${k}`);
  }
  lines.push("");
  return lines.join("\n");
}
