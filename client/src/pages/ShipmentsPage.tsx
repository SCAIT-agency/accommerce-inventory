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

// "planned" has no entry here on purpose: the only forward transition out of
// "planned" is marking a shipment departed, which must go through
// markShipmentDeparted (records the actual depart date and enforces the
// planned-depart-date precondition) — updateShipmentStatus now rejects
// "departed" outright, so no button here may call it. See docs/BACKLOG.md
// Stream A for the still-open gap: no UI exists yet to set plannedDepartDate
// or call markShipmentDeparted.
const VALID_SHIPMENT_TRANSITIONS: Record<string, string[]> = {
  departed: ["in_transit"],
  in_transit: ["customs"],
  customs: ["delivered"],
  delivered: [],
};

interface StatusTransitionFormState {
  reasonCategory: ReasonCategory;
  reasonNote: string;
}

function defaultStatusTransitionForm(): StatusTransitionFormState {
  return { reasonCategory: "logistics_delay", reasonNote: "" };
}

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

interface CustomsArrivalFormState {
  customsStatus: string;
  actualArrivalDate: string;
  reasonCategory: ReasonCategory;
  reasonNote: string;
}

const CUSTOMS_STATUSES = ["not_declared", "declared", "held", "cleared"] as const;

function defaultCustomsArrivalForm(shipment: ShipmentListItem): CustomsArrivalFormState {
  return {
    customsStatus: shipment.customsStatus,
    actualArrivalDate: shipment.actualArrivalDate ? new Date(shipment.actualArrivalDate).toISOString().slice(0, 10) : "",
    reasonCategory: "customs_hold",
    reasonNote: "",
  };
}

interface DepartDateCorrectionFormState {
  newDate: string;
  reasonCategory: ReasonCategory;
  reasonNote: string;
}

function defaultDepartDateCorrectionForm(): DepartDateCorrectionFormState {
  return { newDate: new Date().toISOString().slice(0, 10), reasonCategory: "logistics_delay", reasonNote: "" };
}

function StatusTransitionControl({ shipment, onUpdated }: { shipment: ShipmentListItem; onUpdated: () => void }) {
  const updateStatus = trpc.shipments.updateStatus.useMutation({ onSuccess: onUpdated });
  const [form, setForm] = useState<StatusTransitionFormState>(() => defaultStatusTransitionForm());
  const nextStatuses = VALID_SHIPMENT_TRANSITIONS[shipment.status] ?? [];
  const noteRequired = form.reasonCategory === "other";
  const canSave = !noteRequired || form.reasonNote.trim().length > 0;

  if (nextStatuses.length === 0) return null;

  return (
    <div>
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
      {nextStatuses.map((next) => (
        <button
          key={next}
          disabled={!canSave || updateStatus.isPending}
          onClick={() =>
            updateStatus.mutate({
              id: shipment.id,
              newStatus: next as ShipmentListItem["status"],
              reasonCategory: form.reasonCategory,
              reasonNote: noteRequired ? form.reasonNote : undefined,
            })
          }
        >
          Mark {next}
        </button>
      ))}
      {updateStatus.error && <div>Failed to update status: {updateStatus.error.message}</div>}
    </div>
  );
}

function CustomsArrivalControl({ shipment, onUpdated }: { shipment: ShipmentListItem; onUpdated: () => void }) {
  const setCustomsStatus = trpc.shipments.setCustomsStatus.useMutation({ onSuccess: onUpdated });
  const markArrived = trpc.shipments.markArrived.useMutation({ onSuccess: onUpdated });
  const [form, setForm] = useState<CustomsArrivalFormState>(() => defaultCustomsArrivalForm(shipment));
  const noteRequired = form.reasonCategory === "other";
  const canSave = !noteRequired || form.reasonNote.trim().length > 0;

  return (
    <div>
      <div>Customs: {shipment.customsStatus} · Arrived: {shipment.actualArrivalDate ? new Date(shipment.actualArrivalDate).toISOString().slice(0, 10) : "—"}</div>
      <select
        value={form.customsStatus}
        onChange={(e) => setForm((prev) => ({ ...prev, customsStatus: e.target.value }))}
      >
        {CUSTOMS_STATUSES.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
      <input
        type="date"
        value={form.actualArrivalDate}
        onChange={(e) => setForm((prev) => ({ ...prev, actualArrivalDate: e.target.value }))}
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
        disabled={!canSave || setCustomsStatus.isPending}
        onClick={() =>
          setCustomsStatus.mutate({
            id: shipment.id,
            newStatus: form.customsStatus as (typeof CUSTOMS_STATUSES)[number],
            reasonCategory: form.reasonCategory,
            reasonNote: noteRequired ? form.reasonNote : undefined,
          })
        }
      >
        Save customs status
      </button>
      <button
        disabled={!canSave || !form.actualArrivalDate || markArrived.isPending}
        onClick={() =>
          markArrived.mutate({
            id: shipment.id,
            actualArrivalDate: new Date(form.actualArrivalDate),
            reasonCategory: form.reasonCategory,
            reasonNote: noteRequired ? form.reasonNote : undefined,
          })
        }
      >
        Save arrival date
      </button>
      {(setCustomsStatus.error ?? markArrived.error) && <div>Failed to save: {(setCustomsStatus.error ?? markArrived.error)!.message}</div>}
    </div>
  );
}

function DepartDateCorrectionControl({ shipment, onUpdated }: { shipment: ShipmentListItem; onUpdated: () => void }) {
  const correctDate = trpc.shipments.correctActualDepartDate.useMutation({ onSuccess: onUpdated });
  const [form, setForm] = useState<DepartDateCorrectionFormState>(() => defaultDepartDateCorrectionForm());
  const noteRequired = form.reasonCategory === "other";
  const canSave = !noteRequired || form.reasonNote.trim().length > 0;

  // markShipmentDeparted hasn't set an actual depart date yet on this shipment —
  // nothing to correct, so don't render the control at all.
  if (!shipment.actualDepartDate) return null;

  return (
    <div>
      <span>Actual depart: {new Date(shipment.actualDepartDate).toISOString().slice(0, 10)}</span>
      <input
        type="date"
        value={form.newDate}
        onChange={(e) => setForm((prev) => ({ ...prev, newDate: e.target.value }))}
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
        disabled={!canSave || correctDate.isPending}
        onClick={() =>
          correctDate.mutate({
            id: shipment.id,
            newDate: new Date(form.newDate),
            reasonCategory: form.reasonCategory,
            reasonNote: noteRequired ? form.reasonNote : undefined,
          })
        }
      >
        Correct depart date
      </button>
      {correctDate.error && <div>Failed to correct: {correctDate.error.message}</div>}
    </div>
  );
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
      <td>
        {shipment.status}
        <div style={{ marginTop: "8px" }}>
          <StatusTransitionControl shipment={shipment} onUpdated={() => { refetch(); utils.shipments.list.invalidate(); }} />
        </div>
        <div style={{ marginTop: "8px" }}>
          <CustomsArrivalControl shipment={shipment} onUpdated={() => { refetch(); utils.shipments.list.invalidate(); }} />
        </div>
        <div style={{ marginTop: "8px" }}>
          <DepartDateCorrectionControl shipment={shipment} onUpdated={() => { refetch(); utils.shipments.list.invalidate(); }} />
        </div>
      </td>
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
