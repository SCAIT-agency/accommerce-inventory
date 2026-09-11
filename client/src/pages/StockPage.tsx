import { trpc } from "../lib/trpc";

export function StockPage() {
  const { data, isLoading, error } = trpc.dashboards.stock.useQuery();
  if (error) return <div>Failed to load: {error.message}</div>;
  if (isLoading || !data) return <div>Loading…</div>;
  return (
    <table>
      <thead><tr><th>SKU</th><th>Warehouse</th><th>SOH</th></tr></thead>
      <tbody>
        {data.flatMap((row) =>
          row.byWarehouse.map((w) => (
            <tr key={`${row.skuId}-${w.warehouseId}`}>
              <td>{row.sku}</td><td>{w.warehouseId}</td><td>{w.soh}</td>
            </tr>
          )),
        )}
      </tbody>
    </table>
  );
}
