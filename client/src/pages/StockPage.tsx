import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../server/routers";
import { trpc } from "../lib/trpc";

type RouterOutputs = inferRouterOutputs<AppRouter>;

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

function weekEndDateStr(weekStartDate: string): string {
  const d = new Date(weekStartDate);
  d.setUTCDate(d.getUTCDate() + 6);
  return d.toISOString().slice(0, 10);
}

function nextMondays(n: number): string[] {
  const dates: string[] = [];
  const today = new Date();
  const cursor = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const day = cursor.getUTCDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  cursor.setUTCDate(cursor.getUTCDate() + diffToMonday);
  for (let i = 0; i < n; i++) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }
  return dates;
}

type WeeklyInputWithLines = RouterOutputs["salesPlan"]["listWeeklyInputs"][number];

interface WeeklyRecipeLineForm {
  skuId: string;
  unitsPer1000: string;
}

interface WeeklyPlanFormState {
  plannedRevenue: string;
  primaryWarehouseId: string;
  primaryPercent: string;
  secondaryWarehouseId: string;
  recipeLines: WeeklyRecipeLineForm[];
}

function defaultWeeklyPlanForm(existing?: WeeklyInputWithLines): WeeklyPlanFormState {
  if (!existing) {
    return { plannedRevenue: "", primaryWarehouseId: "", primaryPercent: "", secondaryWarehouseId: "", recipeLines: [] };
  }
  return {
    plannedRevenue: existing.plannedRevenue,
    primaryWarehouseId: String(existing.primaryWarehouseId),
    primaryPercent: existing.primaryPercent,
    secondaryWarehouseId: String(existing.secondaryWarehouseId),
    recipeLines: existing.recipeLines.map((l) => ({ skuId: String(l.skuId), unitsPer1000: l.unitsPer1000 })),
  };
}

function WeeklyPlanRow({ weekStartDate, existing, skus, warehouses, onSaved }: {
  weekStartDate: string;
  existing?: WeeklyInputWithLines;
  skus: { id: number; sku: string | null; name: string | null }[];
  warehouses: { id: number; code: string; name: string }[];
  onSaved: () => void;
}) {
  const [form, setForm] = useState<WeeklyPlanFormState>(() => defaultWeeklyPlanForm(existing));
  const upsert = trpc.salesPlan.upsertWeeklyInput.useMutation({ onSuccess: onSaved });

  const isPast = weekEndDateStr(weekStartDate) < new Date().toISOString().slice(0, 10);

  if (isPast) {
    return (
      <tr>
        <td>{weekStartDate}</td>
        <td colSpan={4}>Past — read-only</td>
      </tr>
    );
  }

  const addRecipeLine = () => setForm((prev) => ({ ...prev, recipeLines: [...prev.recipeLines, { skuId: "", unitsPer1000: "" }] }));
  const updateRecipeLine = (i: number, patch: Partial<WeeklyRecipeLineForm>) =>
    setForm((prev) => ({ ...prev, recipeLines: prev.recipeLines.map((l, idx) => (idx === i ? { ...l, ...patch } : l)) }));
  const removeRecipeLine = (i: number) => setForm((prev) => ({ ...prev, recipeLines: prev.recipeLines.filter((_, idx) => idx !== i) }));

  const recipeSkuIds = form.recipeLines.filter((l) => l.skuId !== "").map((l) => l.skuId);
  const canSave = form.plannedRevenue.trim().length > 0
    && form.primaryWarehouseId !== "" && form.secondaryWarehouseId !== "" && form.primaryPercent.trim().length > 0
    && form.primaryWarehouseId !== form.secondaryWarehouseId
    && form.recipeLines.length > 0
    && form.recipeLines.every((l) => l.skuId !== "" && l.unitsPer1000.trim().length > 0)
    && new Set(recipeSkuIds).size === recipeSkuIds.length;

  return (
    <tr>
      <td>{weekStartDate}</td>
      <td>
        <input type="text" placeholder="revenue" value={form.plannedRevenue} onChange={(e) => setForm((prev) => ({ ...prev, plannedRevenue: e.target.value }))} />
      </td>
      <td>
        <select value={form.primaryWarehouseId} onChange={(e) => setForm((prev) => ({ ...prev, primaryWarehouseId: e.target.value }))}>
          <option value="">Primary…</option>
          {warehouses.map((w) => <option key={w.id} value={w.id}>{w.code}</option>)}
        </select>
        <input type="text" placeholder="primary %" value={form.primaryPercent} onChange={(e) => setForm((prev) => ({ ...prev, primaryPercent: e.target.value }))} />
        <select value={form.secondaryWarehouseId} onChange={(e) => setForm((prev) => ({ ...prev, secondaryWarehouseId: e.target.value }))}>
          <option value="">Secondary…</option>
          {warehouses.map((w) => <option key={w.id} value={w.id}>{w.code}</option>)}
        </select>
      </td>
      <td>
        {form.recipeLines.map((line, i) => (
          <div key={i}>
            <select value={line.skuId} onChange={(e) => updateRecipeLine(i, { skuId: e.target.value })}>
              <option value="">SKU…</option>
              {skus.map((s) => <option key={s.id} value={s.id}>{s.sku ?? s.name ?? `#${s.id}`}</option>)}
            </select>
            <input type="text" placeholder="units/1000€" value={line.unitsPer1000} onChange={(e) => updateRecipeLine(i, { unitsPer1000: e.target.value })} />
            <button onClick={() => removeRecipeLine(i)}>Remove</button>
          </div>
        ))}
        <button onClick={addRecipeLine}>Add SKU</button>
      </td>
      <td>
        <button
          disabled={!canSave || upsert.isPending}
          onClick={() =>
            upsert.mutate({
              weekStartDate: new Date(weekStartDate),
              plannedRevenue: form.plannedRevenue,
              primaryWarehouseId: Number(form.primaryWarehouseId),
              primaryPercent: form.primaryPercent,
              secondaryWarehouseId: Number(form.secondaryWarehouseId),
              recipeLines: form.recipeLines.map((l) => ({ skuId: Number(l.skuId), unitsPer1000: l.unitsPer1000 })),
            })
          }
        >
          Save & regenerate
        </button>
        {upsert.error && <div>Failed: {upsert.error.message}</div>}
      </td>
    </tr>
  );
}

function WeeklySalesPlanSection() {
  const utils = trpc.useUtils();
  const warehousesQuery = trpc.catalog.listWarehouses.useQuery();
  const skusQuery = trpc.catalog.listSkus.useQuery();
  const weeks = useMemo(() => nextMondays(26), []);
  const inputsQuery = trpc.salesPlan.listWeeklyInputs.useQuery({
    from: new Date(weeks[0]),
    to: new Date(weeks[weeks.length - 1]),
  });

  const error = warehousesQuery.error ?? skusQuery.error ?? inputsQuery.error;
  if (error) return <div>Failed to load: {error.message}</div>;

  const isLoading = warehousesQuery.isLoading || skusQuery.isLoading || inputsQuery.isLoading;
  if (isLoading || !warehousesQuery.data || !skusQuery.data || !inputsQuery.data) return <div>Loading…</div>;

  const inputsByWeek = new Map(inputsQuery.data.map((w) => [w.weekStartDate, w]));
  const onSaved = () => utils.salesPlan.listWeeklyInputs.invalidate();

  return (
    <div>
      <h2>Weekly Sales Plan</h2>
      <table>
        <thead><tr><th>Week</th><th>Revenue</th><th>Warehouse split</th><th>Recipe (units/1000€)</th><th></th></tr></thead>
        <tbody>
          {weeks.map((week) => (
            <WeeklyPlanRow
              key={week}
              weekStartDate={week}
              existing={inputsByWeek.get(week)}
              skus={skusQuery.data}
              warehouses={warehousesQuery.data}
              onSaved={onSaved}
            />
          ))}
        </tbody>
      </table>
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
      <WeeklySalesPlanSection />
    </div>
  );
}
