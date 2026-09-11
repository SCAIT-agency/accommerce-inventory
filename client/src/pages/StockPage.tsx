import { trpc } from "../lib/trpc";

export function StockPage() {
  const { data, isLoading } = trpc.dashboards.stock.useQuery();
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
