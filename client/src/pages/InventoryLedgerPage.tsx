import { trpc } from "../lib/trpc";
import { skuLabel, warehouseLabel } from "../lib/labels";

export function InventoryLedgerPage({ skuId, warehouseId }: { skuId: number; warehouseId: number }) {
  const batchesQuery = trpc.inventoryLedger.remainingBatches.useQuery({ skuId, warehouseId });
  const skusQuery = trpc.catalog.listSkus.useQuery();
  const warehousesQuery = trpc.catalog.listWarehouses.useQuery();

  const error = batchesQuery.error ?? skusQuery.error ?? warehousesQuery.error;
  if (error) return <div>Failed to load: {error.message}</div>;

  const isLoading = batchesQuery.isLoading || skusQuery.isLoading || warehousesQuery.isLoading;
  if (isLoading || !batchesQuery.data) return <div>Loading…</div>;

  const sku = (skusQuery.data ?? []).find((s) => s.id === skuId);
  const warehouse = (warehousesQuery.data ?? []).find((w) => w.id === warehouseId);

  return (
    <div>
      <h1>Inventory Ledger — Batch Detail</h1>
      <p>
        {skuLabel(sku ?? { id: skuId })}, {warehouse ? warehouseLabel(warehouse) : `warehouse #${warehouseId}`}
        {" "}— oldest batch first (the order units are actually consumed in).
      </p>
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
