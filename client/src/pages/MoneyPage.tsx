import { useMemo, useState } from "react";
import { trpc } from "../lib/trpc";

export function MoneyPage() {
  const [tab, setTab] = useState<"cashflow" | "landed_cost" | "daily_cogs">("cashflow");

  // Daily COGS needs a SKU+warehouse to scope to; Landed Cost needs a shipment.
  // A real picker belongs in a follow-up polish pass — these are placeholder
  // selections (first SKU/warehouse/shipment in each list) just to prove the
  // wiring end-to-end for V1.
  const skusQuery = trpc.catalog.listSkus.useQuery();
  const warehousesQuery = trpc.catalog.listWarehouses.useQuery();
  const shipmentsQuery = trpc.shipments.list.useQuery();

  const selectedSkuId = skusQuery.data?.[0]?.id;
  const selectedWarehouseId = warehousesQuery.data?.[0]?.id;
  const selectedShipmentId = shipmentsQuery.data?.[0]?.id;

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
      <h1>Money</h1>
      <div>
        <button onClick={() => setTab("cashflow")}>Cashflow</button>
        <button onClick={() => setTab("landed_cost")}>Landed Cost</button>
        <button onClick={() => setTab("daily_cogs")}>Daily COGS/Sales</button>
      </div>
      {tab === "cashflow" && (
        <>
          <table>
            <thead><tr><th>Date</th><th>Planned</th><th>Actual</th></tr></thead>
            <tbody>
              {data.cashflow.map((d) => (
                <tr key={d.date}><td>{d.date}</td><td>{d.plannedOutflow.toFixed(2)}</td><td>{d.actualOutflow.toFixed(2)}</td></tr>
              ))}
            </tbody>
          </table>
          {data.unmatchedTransactions.length > 0 && (
            <p>{data.unmatchedTransactions.length} unmatched transaction(s) — needs manual review.</p>
          )}
        </>
      )}
      {tab === "daily_cogs" && (
        <table>
          <thead><tr><th>Date</th><th>COGS</th></tr></thead>
          <tbody>
            {data.dailyCogs.map((d) => (
              <tr key={d.date}><td>{d.date}</td><td>{d.cogs.toFixed(2)}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      {tab === "landed_cost" && (
        <table>
          <thead><tr><th>SKU</th><th>Landed unit cost</th></tr></thead>
          <tbody>
            {data.landedCost.map((row) => (
              <tr key={row.skuId}><td>{row.skuId}</td><td>{row.landedUnitCost.toFixed(4)}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
