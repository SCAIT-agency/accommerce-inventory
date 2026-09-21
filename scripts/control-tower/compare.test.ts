import { describe, it, expect } from "vitest";
import { compareReports, digestReport, renderDelta } from "./compare";

const report = (verdict: string, r4: number, findings: string[], migration = "Migration: 20 paid payments transferred, 20 transaction links transferred, 0 rows quarantined, 0 links not transferable, 0 export issues.") => `# Real-data dry-run — 2026-09-19

**Verdict: ${verdict}**

Source: x

## Summary

| Target | Checked | Mismatched | Unclassified |
|---|---:|---:|---:|
| R1 — SOH today | 6 | 0 | 0 |
| R4 — Landed cost per shipment line | 24 | ${r4} | 0 |
| L — Sheet match hints | 0 | 0 | 0 |

${migration}

## Findings by target

### R1 — SOH today

All 6 checks matched.

### R4 — Landed cost per shipment line

| Key | Sheet | Platform | Diff | Class | Note |
|---|---:|---:|---:|---|---|
${findings.map((f) => `| ${f} | 1 | 2 | 1 | sheet_bug |  |`).join("\n")}

## Quarantines

None.
`;

describe("digestReport", () => {
  it("extracts verdict, summary counts, finding keys and the migration line", () => {
    const d = digestReport(report("SAFE TO CUT OVER", 1, ["Mutual-PO2-Delivered / Mixer qty"]).replace("**Verdict: SAFE TO CUT OVER**", "**Verdict: SAFE TO CUT OVER** — 1 item needs your decision"));
    expect(d.verdict).toBe("SAFE TO CUT OVER — 1 item needs your decision");
    expect(d.summary.get("R4")).toEqual({ checked: 24, mismatched: 1, unclassified: 0 });
    expect(d.summary.get("L")).toEqual({ checked: 0, mismatched: 0, unclassified: 0 });
    expect([...d.findingKeys]).toEqual(["Mutual-PO2-Delivered / Mixer qty"]);
    expect(d.migrationLine).toMatch(/^Migration: 20 paid/);
  });
});

describe("compareReports + renderDelta", () => {
  it("reports verdict, per-target count changes, new and resolved findings", () => {
    const prev = report("SAFE TO CUT OVER", 1, ["Mutual-PO2-Delivered / Mixer qty"]);
    const curr = report("NOT SAFE TO CUT OVER", 2, ["PO1-Wave3 / Jello", "PO2-Jello-Wave1 / Jello"]);
    const delta = compareReports(prev, curr);
    expect(delta).toEqual({
      verdictChanged: true,
      previousVerdict: "SAFE TO CUT OVER",
      currentVerdict: "NOT SAFE TO CUT OVER",
      targetChanges: [{ target: "R4", previousMismatched: 1, currentMismatched: 2, previousChecked: 24, currentChecked: 24 }],
      newFindings: ["PO1-Wave3 / Jello", "PO2-Jello-Wave1 / Jello"],
      resolvedFindings: ["Mutual-PO2-Delivered / Mixer qty"],
    });
    const md = renderDelta({ currentDate: "2026-09-20", previousDate: "2026-09-19", current: curr, delta });
    expect(md).toContain("# Parallel run — 2026-09-20");
    expect(md).toContain("**NOT SAFE TO CUT OVER**");
    expect(md).toContain("- Verdict changed: SAFE TO CUT OVER → NOT SAFE TO CUT OVER");
    expect(md).toContain("- R4: mismatched 1 → 2 (checked 24 → 24)");
    expect(md).toContain("### New findings");
    expect(md).toContain("### Resolved since last run\n\n- Mutual-PO2-Delivered / Mixer qty");
  });

  it("says so when nothing changed, and handles a first run", () => {
    const r = report("SAFE TO CUT OVER", 0, []);
    const md = renderDelta({ currentDate: "2026-09-20", previousDate: "2026-09-19", current: r, delta: compareReports(r, r) });
    expect(md).toContain("- Verdict unchanged.");
    expect(md).toContain("- Mismatch counts unchanged on every target.");
    expect(md).not.toContain("### New findings");
    expect(renderDelta({ currentDate: "2026-09-19", previousDate: null, current: r, delta: null })).toContain("First run — nothing to compare against yet.");
  });
});
