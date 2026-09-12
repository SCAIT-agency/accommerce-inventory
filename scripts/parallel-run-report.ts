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
  const { passed, mismatches } = await reconcileMigration(sheetSnapshot, deps);
  return {
    runDate: new Date().toISOString().slice(0, 10),
    safeToCutOver: passed,
    mismatches,
  };
}
