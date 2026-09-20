import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { trpc } from "../lib/trpc";

const STATUS_BADGE_CLASS: Record<string, string> = {
  critical: "badge badge-critical",
  low: "badge badge-warning",
  ok: "badge badge-ok",
  overstock: "badge badge-overstock",
  unknown: "badge badge-unknown",
};

interface SalesPlanFormState {
  skuId: string;
  warehouseId: string;
  periodDate: string;
  plannedQty: string;
}

function defaultSalesPlanForm(): SalesPlanFormState {
  return { skuId: "", warehouseId: "", periodDate: new Date().toISOString().slice(0, 10), plannedQty: "" };
}

function SalesPlanSection({ warehouseFilter }: { warehouseFilter: number | "all" }) {
  const utils = trpc.useUtils();
  const skusQuery = trpc.catalog.listSkus.useQuery();
  const warehousesQuery = trpc.catalog.listWarehouses.useQuery();
  const [form, setForm] = useState<SalesPlanFormState>(() => ({
    ...defaultSalesPlanForm(),
    warehouseId: warehouseFilter === "all" ? "" : String(warehouseFilter),
  }));
  const createEntry = trpc.salesPlan.create.useMutation({
    onSuccess: () => {
      setForm(defaultSalesPlanForm());
      utils.salesPlan.planActualDeviation.invalidate();
      utils.salesPlan.volatility.invalidate();
    },
  });

  const catalogError = skusQuery.error ?? warehousesQuery.error;

  const selectedSkuId = form.skuId ? Number(form.skuId) : undefined;
  const selectedWarehouseId = form.warehouseId ? Number(form.warehouseId) : undefined;

  // 30-day window ending today, matching the convention used for MoneyPage's cashflow window.
  const { from, to } = useMemo(
    () => ({ from: new Date(Date.now() - 30 * 86400000), to: new Date(Date.now()) }),
    [],
  );

  const deviationQuery = trpc.salesPlan.planActualDeviation.useQuery(
    { skuId: selectedSkuId ?? 0, warehouseId: selectedWarehouseId ?? 0, from, to },
    { enabled: selectedSkuId !== undefined && selectedWarehouseId !== undefined },
  );
  const volatilityQuery = trpc.salesPlan.volatility.useQuery(
    { skuId: selectedSkuId ?? 0, warehouseId: selectedWarehouseId ?? 0, weeks: 8 },
    { enabled: selectedSkuId !== undefined && selectedWarehouseId !== undefined },
  );

  const canCreate = selectedSkuId !== undefined && selectedWarehouseId !== undefined
    && form.plannedQty.trim().length > 0;

  if (catalogError) return <div>Failed to load catalogs: {catalogError.message}</div>;

  return (
    <div>
      <h2>Sales Plan</h2>
      <div>
        <select value={form.skuId} onChange={(e) => setForm((prev) => ({ ...prev, skuId: e.target.value }))}>
          <option value="">SKU…</option>
          {(skusQuery.data ?? []).map((sku) => <option key={sku.id} value={sku.id}>{sku.sku ?? sku.name ?? `#${sku.id}`}</option>)}
        </select>
        <select value={form.warehouseId} onChange={(e) => setForm((prev) => ({ ...prev, warehouseId: e.target.value }))}>
          <option value="">Warehouse…</option>
          {(warehousesQuery.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}
        </select>
        <input
          type="date"
          value={form.periodDate}
          onChange={(e) => setForm((prev) => ({ ...prev, periodDate: e.target.value }))}
        />
        <input
          type="text"
          placeholder="planned qty"
          value={form.plannedQty}
          onChange={(e) => setForm((prev) => ({ ...prev, plannedQty: e.target.value }))}
        />
        <button
          disabled={!canCreate || createEntry.isPending}
          onClick={() =>
            createEntry.mutate({
              skuId: selectedSkuId!,
              warehouseId: selectedWarehouseId!,
              periodDate: new Date(form.periodDate),
              plannedQty: Number(form.plannedQty),
            })
          }
        >
          Add plan entry
        </button>
        {createEntry.error && <div>Failed to save: {createEntry.error.message}</div>}
      </div>
      {selectedSkuId !== undefined && selectedWarehouseId !== undefined && (
        <div>
          <p>Sales volatility (last 8 weeks): {volatilityQuery.data !== undefined ? volatilityQuery.data.toFixed(2) : "…"}</p>
          <table>
            <thead><tr><th>Date</th><th>Planned</th><th>Actual</th><th>Deviation</th></tr></thead>
            <tbody>
              {(deviationQuery.data ?? []).map((row) => (
                <tr key={row.date}><td>{row.date}</td><td>{row.planned}</td><td>{row.actual}</td><td>{row.deviation}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function StockPage() {
  const stockQuery = trpc.dashboards.stock.useQuery();
  const warehousesQuery = trpc.catalog.listWarehouses.useQuery();
  const [warehouseFilter, setWarehouseFilter] = useState<number | "all">("all");

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
      <div>
        <button onClick={() => setWarehouseFilter("all")} disabled={warehouseFilter === "all"}>All warehouses</button>
        {(warehousesQuery.data ?? []).map((w) => (
          <button key={w.id} onClick={() => setWarehouseFilter(w.id)} disabled={warehouseFilter === w.id}>
            {w.code}
          </button>
        ))}
      </div>
      <table>
        <thead>
          <tr>
            <th>SKU</th>
            <th>Warehouse</th>
            <th>SOH</th>
            <th>Avg daily sales</th>
            <th>Days of cover</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {data.flatMap((row) =>
            row.byWarehouse
              .filter((w) => warehouseFilter === "all" || w.warehouseId === warehouseFilter)
              .map((w) => (
                <tr key={`${row.skuId}-${w.warehouseId}`}>
                  <td>{row.sku}</td>
                  <td>{warehouseLabels.get(w.warehouseId) ?? `#${w.warehouseId}`}</td>
                  <td>{w.soh}</td>
                  <td>{w.avgDailySales.toFixed(2)}</td>
                  <td>{w.daysOfCover === null ? "—" : w.daysOfCover.toFixed(1)}</td>
                  <td><span className={STATUS_BADGE_CLASS[w.status]}>{w.status}</span></td>
                  <td><Link to={`/inventory-ledger/${row.skuId}/${w.warehouseId}`}>Batches</Link></td>
                </tr>
              )),
          )}
        </tbody>
      </table>
      <SalesPlanSection warehouseFilter={warehouseFilter} />
    </div>
  );
}
