// server/nightlyExport.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { db } from "./dbClient";
import { warehouses } from "../drizzle/schema";
import { createWarehouse } from "./db";
import { generateCsvExport, runNightlyExport, exportTableToCsv } from "./nightlyExport";

describe("generateCsvExport", () => {
  it("renders rows as CSV with a header row matching the first row's keys", () => {
    const rows = [
      { id: 1, sku: "JELLO-CAL-500", status: "active" },
      { id: 2, sku: "JELLO-MIX-250", status: "inactive" },
    ];
    const csv = generateCsvExport(rows);
    expect(csv).toBe(
      "id,sku,status\n1,JELLO-CAL-500,active\n2,JELLO-MIX-250,inactive",
    );
  });

  it("quotes a field that contains a comma", () => {
    const csv = generateCsvExport([{ id: 1, notes: "delayed, per artwork" }]);
    expect(csv).toBe('id,notes\n1,"delayed, per artwork"');
  });

  it("returns just a header-less empty string for an empty table", () => {
    expect(generateCsvExport([])).toBe("");
  });

  it("quotes a field that contains an embedded newline", () => {
    const csv = generateCsvExport([{ id: 1, notes: "line one\nline two" }]);
    expect(csv).toBe('id,notes\n1,"line one\nline two"');
  });
});

describe("exportTableToCsv / runNightlyExport", () => {
  let outDir: string;

  beforeEach(async () => {
    // Same FK-disable-and-cleanup pattern as server/shipments.test.ts: this
    // DB is shared across test files with no per-file isolation, so a
    // leftover warehouse row from another file's last test can otherwise
    // collide with this file's own unique `code` values or block deletion.
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
      try {
        await tx.delete(warehouses);
      } finally {
        await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
      }
    });
    outDir = await mkdtemp(join(tmpdir(), "nightly-export-test-"));
  });

  it("fetches a table across multiple bounded pages and writes output identical to a single-query export", async () => {
    for (let i = 0; i < 5; i++) {
      await createWarehouse({ code: `NLX-${i}`, name: `Nightly Export Test ${i}` });
    }
    const allRows = await db.select().from(warehouses);
    const expectedCsv = generateCsvExport(allRows as unknown as Record<string, unknown>[]);

    const path = join(outDir, "warehouses.csv");
    // pageSize: 2 against 5 rows forces 3 round trips (2 + 2 + 1) — if this
    // silently fell back to a single unbounded query (or truncated to one
    // page), the written file would not match a real single-query export.
    await exportTableToCsv(warehouses, path, 2);

    const written = await readFile(path, "utf-8");
    expect(written).toBe(expectedCsv);
    expect(written.split("\n")).toHaveLength(6); // 1 header + 5 rows
  });

  it("writes an empty file for a table with no rows", async () => {
    const path = join(outDir, "warehouses.csv");
    await exportTableToCsv(warehouses, path, 2);
    const written = await readFile(path, "utf-8");
    expect(written).toBe("");
  });

  it("runNightlyExport writes a CSV file for every CORE_TABLES entry, including the sales-plan-weekly tables added after the schema drift fix", async () => {
    const paths = await runNightlyExport(outDir);

    // The two Stream H tables (sales_plan_weekly_inputs,
    // sales_plan_weekly_recipe_lines) were imported into nightlyExport.ts by
    // commit c8f99a3 but never actually added to CORE_TABLES — silently
    // dropped from every export since. This is the regression test for that.
    const fileNames = paths.map((p) => p.split("/").pop());
    expect(fileNames).toContain("sales_plan_weekly_inputs.csv");
    expect(fileNames).toContain("sales_plan_weekly_recipe_lines.csv");
    expect(paths).toHaveLength(15);

    for (const path of paths) {
      // Every file must actually exist and be readable (empty is fine —
      // most tables have no seeded data in this test).
      await expect(readFile(path, "utf-8")).resolves.toEqual(expect.any(String));
    }
  });

  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });
});
