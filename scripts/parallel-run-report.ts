import { reconcileMigration, type SkuWarehouseTotal, type ReconciliationDeps, type Mismatch } from "./migrate-from-sheet";

export interface ParallelRunReport {
  runDate: string;
  safeToCutOver: boolean;
  mismatches: Mismatch[];
}

export async function generateParallelRunReport(
  sheetSnapshot: SkuWarehouseTotal[],
  deps: ReconciliationDeps,
): Promise<ParallelRunReport> {
  if (sheetSnapshot.length === 0) {
    throw new Error("sheetSnapshot is empty — refusing to report safeToCutOver on an unvalidated comparison");
  }
  const { passed, mismatches } = await reconcileMigration(sheetSnapshot, deps);
  return {
    runDate: new Date().toISOString().slice(0, 10),
    safeToCutOver: passed,
    mismatches,
  };
}
