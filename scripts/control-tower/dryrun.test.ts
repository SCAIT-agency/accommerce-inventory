import { describe, it, expect } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertDryRunDatabase, runDryRun } from "./dryrun";

describe("assertDryRunDatabase", () => {
  it("accepts only _dryrun / _dryrun_test database names", () => {
    expect(assertDryRunDatabase("mysql://u:p@localhost:3306/accommerce_dryrun")).toBe("accommerce_dryrun");
    expect(assertDryRunDatabase("mysql://u:p@localhost:3306/accommerce_dryrun_test")).toBe("accommerce_dryrun_test");
    expect(() => assertDryRunDatabase("mysql://u:p@localhost:3306/accommerce_dev")).toThrow(/refusing/);
    expect(() => assertDryRunDatabase("mysql://u:p@host/accommerce_prod")).toThrow(/refusing/);
  });
});

describe("runDryRun (fixture replay, real database)", () => {
  it("runs end to end and writes a report with every target", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "dryrun-"));
    const result = await runDryRun({ source: { kind: "fixture" }, outDir });

    const report = await readFile(join(outDir, "report.md"), "utf-8");
    expect(report.startsWith("# Real-data dry-run — ")).toBe(true);
    expect(report).toContain("**Verdict: ");
    for (const t of ["R1", "R2", "R3", "R4", "R5", "R6", "R7"]) expect(report).toContain(`### ${t} — `);
    expect(report).toContain("| R3 — Daily COGS (Opening Qty/Value, Units Sold, COGS, Unpriced) | 570 |");
    expect(result.reportPath).toBe(join(outDir, "report.md"));
    expect(["SAFE TO CUT OVER", "NOT SAFE TO CUT OVER"]).toContain(result.verdict);
  }, 120_000);
});
