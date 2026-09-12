import { useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../server/routers";
import { trpc } from "../lib/trpc";

type RouterOutputs = inferRouterOutputs<AppRouter>;
type ShipmentListItem = RouterOutputs["shipments"]["list"][number];

const REASON_CATEGORIES = [
  "production_delay", "artwork_delay", "customs_hold", "logistics_delay",
  "payment_timing", "vendor_price_change", "freight_rate_change", "holiday_capacity", "other",
] as const;

type ReasonCategory = (typeof REASON_CATEGORIES)[number];

interface CostsFormState {
  freightCost: string;
  dutyCost: string;
  costCurrency: string;
  reasonCategory: ReasonCategory;
  reasonNote: string;
}

function defaultCostsForm(shipment: ShipmentListItem): CostsFormState {
  return {
    freightCost: shipment.freightCost ?? "",
    dutyCost: shipment.dutyCost ?? "",
    costCurrency: shipment.costCurrency ?? "USD",
    reasonCategory: "freight_rate_change",
    reasonNote: "",
  };
}

function ShipmentRow({ shipment }: { shipment: ShipmentListItem }) {
  const { data, error, isLoading, refetch } = trpc.shipments.getWithLineItems.useQuery(shipment.id);
  const utils = trpc.useUtils();
  const recordCosts = trpc.shipments.recordCosts.useMutation({
    onSuccess: () => {
      refetch();
      utils.shipments.list.invalidate();
      utils.dashboards.money.invalidate();
    },
  });
  const [form, setForm] = useState<CostsFormState>(() => defaultCostsForm(shipment));

  if (error) return <tr><td colSpan={4}>Failed to load {shipment.shipmentRef}: {error.message}</td></tr>;
  if (isLoading || !data) return <tr><td colSpan={4}>Loading {shipment.shipmentRef}…</td></tr>;

  const noteRequired = form.reasonCategory === "other";
  const canSave = form.freightCost.trim().length > 0 && form.dutyCost.trim().length > 0 && form.costCurrency.trim().length > 0
    && (!noteRequired || form.reasonNote.trim().length > 0);

  return (
    <tr>
      <td>{shipment.shipmentRef}</td>
      <td>{shipment.status}</td>
      <td>
        <ul>
          {data.lineItems.map((li) => (
            <li key={li.id}>SKU {li.skuId} — qty {li.qty}</li>
          ))}
        </ul>
      </td>
      <td>
        <div>Freight: {shipment.freightCost ?? "—"} · Duty: {shipment.dutyCost ?? "—"} {shipment.costCurrency ?? ""}</div>
        <input
          placeholder="freight cost"
          value={form.freightCost}
          onChange={(e) => setForm((prev) => ({ ...prev, freightCost: e.target.value }))}
        />
        <input
          placeholder="duty cost"
          value={form.dutyCost}
          onChange={(e) => setForm((prev) => ({ ...prev, dutyCost: e.target.value }))}
        />
        <input
          placeholder="currency"
          value={form.costCurrency}
          onChange={(e) => setForm((prev) => ({ ...prev, costCurrency: e.target.value }))}
        />
        <select
          value={form.reasonCategory}
          onChange={(e) => setForm((prev) => ({ ...prev, reasonCategory: e.target.value as ReasonCategory }))}
        >
          {REASON_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        {noteRequired && (
          <input
            placeholder="required note"
            value={form.reasonNote}
            onChange={(e) => setForm((prev) => ({ ...prev, reasonNote: e.target.value }))}
          />
        )}
        <button
          disabled={!canSave || recordCosts.isPending}
          onClick={() =>
            recordCosts.mutate({
              id: shipment.id,
              freightCost: form.freightCost,
              dutyCost: form.dutyCost,
              costCurrency: form.costCurrency,
              reasonCategory: form.reasonCategory,
              reasonNote: noteRequired ? form.reasonNote : undefined,
            })
          }
        >
          Save costs
        </button>
        {recordCosts.error && <div>Failed to save: {recordCosts.error.message}</div>}
      </td>
    </tr>
  );
}

export function ShipmentsPage() {
  const { data: shipmentsList, error, isLoading } = trpc.shipments.list.useQuery();

  if (error) return <div>Failed to load: {error.message}</div>;
  if (isLoading || !shipmentsList) return <div>Loading…</div>;

  return (
    <div>
      <h1>Shipments</h1>
      <p>Each shipment lists the PO line items it carries — one shipment can pool cargo from multiple POs.</p>
      <table>
        <thead><tr><th>Ref</th><th>Status</th><th>Line items</th><th>Costs</th></tr></thead>
        <tbody>
          {shipmentsList.map((shipment) => (
            <ShipmentRow key={shipment.id} shipment={shipment} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
