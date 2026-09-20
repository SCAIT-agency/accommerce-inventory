import { useMemo, useState } from "react";
import { trpc } from "../lib/trpc";

function skuLabel(s: { id: number; sku?: string | null; name?: string | null }): string {
  return s.name || s.sku || `SKU #${s.id}`;
}

export function MoneyPage() {
  const [tab, setTab] = useState<"cashflow" | "landed_cost" | "daily_cogs">("cashflow");

  // Daily COGS needs a SKU+warehouse to scope to; Landed Cost needs a shipment.
  const skusQuery = trpc.catalog.listSkus.useQuery();
  const warehousesQuery = trpc.catalog.listWarehouses.useQuery();
  const shipmentsQuery = trpc.shipments.list.useQuery();

  const [skuId, setSkuId] = useState<string>("");
  const [warehouseId, setWarehouseId] = useState<string>("");
  const [shipmentId, setShipmentId] = useState<string>("");

  const selectedSkuId = skuId ? Number(skuId) : undefined;
  const selectedWarehouseId = warehouseId ? Number(warehouseId) : undefined;
  const selectedShipmentId = shipmentId ? Number(shipmentId) : undefined;

  // Computed once per mount, not inline per render: a fresh `new Date(Date.now() ± …)`
  // on every render changes react-query's input-derived cache key by a few
  // milliseconds each time, which never lets the query settle — it restarts
  // in "loading" state forever instead of resolving.
  const { from, to } = useMemo(
    () => ({ from: new Date(Date.now() - 30 * 86400000), to: new Date(Date.now() + 30 * 86400000) }),
    [],
  );

  const moneyQuery = trpc.dashboards.money.useQuery({
    from,
    to,
    skuId: selectedSkuId,
    warehouseId: selectedWarehouseId,
    shipmentId: selectedShipmentId,
  });

  const error = skusQuery.error ?? warehousesQuery.error ?? shipmentsQuery.error ?? moneyQuery.error;
  if (error) return <div>Failed to load: {error.message}</div>;

  const isLoading = skusQuery.isLoading || warehousesQuery.isLoading || shipmentsQuery.isLoading || moneyQuery.isLoading;
  const data = moneyQuery.data;
  if (isLoading || !data) return <div>Loading…</div>;

  return (
    <div>
      <h1>Cost & Cashflow</h1>
      <div>
        <button onClick={() => setTab("cashflow")}>Cashflow</button>
        <button onClick={() => setTab("landed_cost")}>Landed Cost</button>
        <button onClick={() => setTab("daily_cogs")}>Daily COGS/Sales</button>
      </div>
      {tab === "daily_cogs" && (
        <div>
          <select value={skuId} onChange={(e) => setSkuId(e.target.value)}>
            <option value="">Select a SKU…</option>
            {(skusQuery.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>{skuLabel(s)}</option>
            ))}
          </select>
          <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
            <option value="">Select a warehouse…</option>
            {(warehousesQuery.data ?? []).map((w) => (
              <option key={w.id} value={w.id}>{w.name} ({w.code})</option>
            ))}
          </select>
        </div>
      )}
      {tab === "landed_cost" && (
        <div>
          <select value={shipmentId} onChange={(e) => setShipmentId(e.target.value)}>
            <option value="">Select a shipment…</option>
            {(shipmentsQuery.data ?? []).map((sh) => (
              <option key={sh.id} value={sh.id}>{sh.shipmentRef}</option>
            ))}
          </select>
        </div>
      )}
      {tab === "cashflow" && (
        <>
          <table>
            <thead><tr><th>Date</th><th>Planned</th><th>Actual</th></tr></thead>
            <tbody>
              {data.cashflow.map((d) => (
                <tr key={d.date}>
                  <td>{d.date}</td>
                  <td>{d.plannedOutflowIsEstimated && "≈ "}{d.plannedOutflow.toFixed(2)}</td>
                  <td>{d.actualOutflow.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.cashflow.some((d) => d.plannedOutflowIsEstimated) && (
            <p>≈ estimated using a standard FX rate (this period mixes currencies with no locked-in rate yet)</p>
          )}
        </>
      )}
      {tab === "daily_cogs" && (
        !selectedSkuId || !selectedWarehouseId ? (
          <p>Select a SKU and a warehouse above to see Daily COGS.</p>
        ) : data.dailyCogsError ? (
          <div>Failed to compute daily COGS: {data.dailyCogsError}</div>
        ) : (
          <table>
            <thead><tr><th>Date</th><th>COGS</th></tr></thead>
            <tbody>
              {data.dailyCogs.map((d) => (
                <tr key={d.date}><td>{d.date}</td><td>{d.cogs.toFixed(2)}</td></tr>
              ))}
            </tbody>
          </table>
        )
      )}
      {tab === "landed_cost" && (
        !selectedShipmentId ? (
          <p>Select a shipment above to see its landed cost.</p>
        ) : data.landedCostError ? (
          <div>Failed to compute landed cost: {data.landedCostError}</div>
        ) : (
          <table>
            <thead><tr><th>SKU</th><th>Landed unit cost</th></tr></thead>
            <tbody>
              {data.landedCost.map((row) => (
                <tr key={row.skuId}><td>{row.skuId}</td><td>{row.landedUnitCost.toFixed(4)}</td></tr>
              ))}
            </tbody>
          </table>
        )
      )}
    </div>
  );
}
