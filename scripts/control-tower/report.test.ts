import { describe, it, expect } from "vitest";
import { renderReport, verdictFor } from "./report";
import type { Finding } from "./reconcile";

const migration = {
  quarantined: { ledger: [], purchaseOrders: [], shipments: [{ rowIndex: 4, reason: "unrecognized status \"x\"" }], payments: [], transactions: [], salesActuals: [], salesPlan: [] },
  unmatchedManualLinks: [{ transactionIndex: 9, ref: "PO1-W1", reason: "ref is a shipment" }],
  linkVariances: [{ ref: "PO2 Straw", sequenceNo: 1, expectedAmount: 569.83, paidAmount: 597.23, variancePct: 0.048, paidInferredFromLink: false }],
  counts: { matchedTransactions: 3, paidPayments: 7 },
};
const checked = { R1: 6, R2: 570, R3: 570, R4: 24, R5: 13, R6: 3, R7: 6, Q: 0, L: 0 };

describe("verdictFor", () => {
  it("is NOT SAFE while any finding is unclassified or an unfixed platform bug", () => {
    expect(verdictFor([])).toBe("SAFE TO CUT OVER");
    expect(verdictFor([{ target: "R1", key: "k", sheet: 1, platform: 2, classification: "convention" }])).toBe("SAFE TO CUT OVER");
    expect(verdictFor([{ target: "R1", key: "k", sheet: 1, platform: 2, classification: "sheet_bug" }])).toBe("SAFE TO CUT OVER");
    expect(verdictFor([{ target: "R1", key: "k", sheet: 1, platform: 2, classification: "unclassified" }])).toBe("NOT SAFE TO CUT OVER");
    expect(verdictFor([{ target: "R1", key: "k", sheet: 1, platform: 2, classification: "platform_bug" }])).toBe("NOT SAFE TO CUT OVER");
  });
});

describe("renderReport", () => {
  it("leads with the verdict and renders every section in order", () => {
    const findings: Finding[] = [
      { target: "R4", key: "Mutual-PO2-Delivered / Mixer", sheet: 1.376, platform: 1.376, diff: 0, classification: "sheet_bug", note: "LCS qty 3,240 vs 700" },
      { target: "R2", key: "Jello/FF 2026-07-06", sheet: -35986, platform: -35986, classification: "unclassified" },
    ];
    const md = renderReport({ runDate: "2026-09-19", source: "fixtures", today: "2026-09-19", migration, exportIssues: [], reconciliation: { findings, checked }, conventions: ["Plan/day rounded to whole units"] });
    const order = ["**Verdict: NOT SAFE TO CUT OVER**", "## Summary", "| R3 — ", "## Findings by target", "### R2 — ", "Jello/FF 2026-07-06", "### R4 — ", "LCS qty 3,240 vs 700", "## Quarantines", "unrecognized status", "## Manual links not transferable", "PO1-W1", "## Links transferred with variance", "PO2 Straw #1: planned 569.83, paid 597.23 (4.8%)", "## Conventions applied by the exporter", "Plan/day rounded", "## Needs your decision", "[sheet_bug] R4"];
    let last = -1;
    for (const marker of order) {
      const at = md.indexOf(marker);
      expect(at, `missing or out of order: ${marker}`).toBeGreaterThan(last);
      last = at;
    }
    expect(md).toContain("7 paid payments transferred, 3 transaction links transferred, 1 rows quarantined, 1 links not transferable");
    expect(md).toContain("All 6 checks matched.");
  });

  it("qualifies a SAFE verdict with the number of pending decisions", () => {
    const findings: Finding[] = [
      { target: "R4", key: "k", sheet: 1, platform: 2, classification: "sheet_bug" },
      { target: "L", key: "l", sheet: "PO", platform: null, classification: "convention" },
    ];
    const md = renderReport({ runDate: "2026-09-19", source: "fixtures", today: "2026-09-19", migration, exportIssues: [], reconciliation: { findings, checked }, conventions: [] });
    expect(md).toContain("**Verdict: SAFE TO CUT OVER** — 2 items need your decision (Sheet bugs / conventions); none blocks the platform");
  });
});
