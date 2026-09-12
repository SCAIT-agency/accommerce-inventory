import { useMemo } from "react";
import { trpc } from "../lib/trpc";

const STATUS_COLORS: Record<string, string> = {
  critical: "#b00020",
  low: "#b36b00",
  ok: "#1a7f37",
  overstock: "#5a5a5a",
  unknown: "#5a5a5a",
};

export function StockPage() {
  const stockQuery = trpc.dashboards.stock.useQuery();
  const warehousesQuery = trpc.catalog.listWarehouses.useQuery();

  const warehouseLabels = useMemo(() => {
    const map = new Map<number, string>();
    for (const w of warehousesQuery.data ?? []) map.set(w.id, `${w.code} — ${w.name}`);
    return map;
  }, [warehousesQuery.data]);

  const error = stockQuery.error ?? warehousesQuery.error;
  if (error) return <div>Failed to load: {error.message}</div>;

  const isLoading = stockQuery.isLoading || warehousesQuery.isLoading;
  const data = stockQuery.data;
  if (isLoading || !data) return <div>Loading…</div>;

  return (
    <div>
      <h1>Stock</h1>
      <table>
        <thead>
          <tr>
            <th>SKU</th>
            <th>Warehouse</th>
            <th>SOH</th>
            <th>Avg daily sales</th>
            <th>Days of cover</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {data.flatMap((row) =>
            row.byWarehouse.map((w) => (
              <tr key={`${row.skuId}-${w.warehouseId}`}>
                <td>{row.sku}</td>
                <td>{warehouseLabels.get(w.warehouseId) ?? `#${w.warehouseId}`}</td>
                <td>{w.soh}</td>
                <td>{w.avgDailySales.toFixed(2)}</td>
                <td>{w.daysOfCover === null ? "—" : w.daysOfCover.toFixed(1)}</td>
                <td style={{ color: STATUS_COLORS[w.status] }}>{w.status}</td>
              </tr>
            )),
          )}
        </tbody>
      </table>
    </div>
  );
}
