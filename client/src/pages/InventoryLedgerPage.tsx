import { trpc } from "../lib/trpc";

export function InventoryLedgerPage({ skuId, warehouseId }: { skuId: number; warehouseId: number }) {
  const batchesQuery = trpc.inventoryLedger.remainingBatches.useQuery({ skuId, warehouseId });

  if (batchesQuery.error) return <div>Failed to load batches: {batchesQuery.error.message}</div>;
  if (batchesQuery.isLoading || !batchesQuery.data) return <div>Loading…</div>;

  return (
    <div>
      <h1>Inventory Ledger — Batch Detail</h1>
      <p>SKU #{skuId}, warehouse #{warehouseId} — oldest batch first (the order units are actually consumed in).</p>
      <table>
        <thead><tr><th>Batch Date</th><th>Source</th><th>Unit Cost</th><th>Remaining Qty</th></tr></thead>
        <tbody>
          {batchesQuery.data.map((b, i) => (
            <tr key={i}>
              <td>{new Date(b.batchDate).toISOString().slice(0, 10)}</td>
              <td>{b.sourceRef ?? "—"}</td>
              <td>{b.unitCost.toFixed(4)}</td>
              <td>{b.remainingQty}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {batchesQuery.data.length === 0 && <p>No remaining stock for this SKU/warehouse.</p>}
    </div>
  );
}
