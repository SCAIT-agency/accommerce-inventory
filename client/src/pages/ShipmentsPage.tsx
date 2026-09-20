import { useState } from "react";
import { Link } from "react-router-dom";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../server/routers";
import { trpc } from "../lib/trpc";
import { skuLabel, formatMoney } from "../lib/labels";

type RouterOutputs = inferRouterOutputs<AppRouter>;
type ShipmentListItem = RouterOutputs["shipments"]["list"][number];

const REASON_CATEGORIES = [
  "production_delay", "artwork_delay", "customs_hold", "logistics_delay",
  "payment_timing", "vendor_price_change", "freight_rate_change", "holiday_capacity", "other",
] as const;

type ReasonCategory = (typeof REASON_CATEGORIES)[number];

const SHIPMENT_STATUS_BADGE_CLASS: Record<string, string> = {
  delivered: "badge badge-ok",
  customs: "badge badge-warning",
};
const DEFAULT_STATUS_BADGE_CLASS = "badge badge-neutral";

const CUSTOMS_STATUS_BADGE_CLASS: Record<string, string> = {
  held: "badge badge-warning",
  cleared: "badge badge-ok",
};

// "planned" has no entry here on purpose: the only forward transition out of
// "planned" is marking a shipment departed, which must go through
// markShipmentDeparted (records the actual depart date and enforces the
// planned-depart-date precondition) — updateShipmentStatus now rejects
// "departed" outright, so no button here may call it. PlannedDepartureControl
// below is what actually drives that transition.
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

interface PlannedDepartureFormState {
  plannedDepartDate: string;
  actualDepartDate: string;
  reasonCategory: ReasonCategory;
  reasonNote: string;
}

function defaultPlannedDepartureForm(shipment: ShipmentListItem): PlannedDepartureFormState {
  return {
    plannedDepartDate: shipment.plannedDepartDate ? new Date(shipment.plannedDepartDate).toISOString().slice(0, 10) : "",
    actualDepartDate: new Date().toISOString().slice(0, 10),
    reasonCategory: "logistics_delay",
    reasonNote: "",
  };
}

// Only relevant while a shipment is still "planned" — updateShipmentStatus
// rejects a direct transition to "departed" precisely so this is the only
// path a shipment can take out of "planned". markShipmentDeparted itself
// enforces that plannedDepartDate must already be set, which is why "Mark
// departed" only appears once shipment.plannedDepartDate is non-null.
function PlannedDepartureControl({ shipment, onUpdated }: { shipment: ShipmentListItem; onUpdated: () => void }) {
  const updatePlannedDepartDate = trpc.shipments.updatePlannedDepartDate.useMutation({ onSuccess: onUpdated });
  const markDeparted = trpc.shipments.markDeparted.useMutation({ onSuccess: onUpdated });
  const [form, setForm] = useState<PlannedDepartureFormState>(() => defaultPlannedDepartureForm(shipment));
  const noteRequired = form.reasonCategory === "other";
  const canSavePlanned = !noteRequired || form.reasonNote.trim().length > 0;

  if (shipment.status !== "planned") return null;

  return (
    <div>
      <div>Planned depart: {shipment.plannedDepartDate ? new Date(shipment.plannedDepartDate).toISOString().slice(0, 10) : "not set"}</div>
      <input
        type="date"
        value={form.plannedDepartDate}
        onChange={(e) => setForm((prev) => ({ ...prev, plannedDepartDate: e.target.value }))}
      />
      <select
        value={form.reasonCategory}
        onChange={(e) => setForm((prev) => ({ ...prev, reasonCategory: e.target.value as ReasonCategory }))}
      >
        {REASON_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
      {noteRequired && (
        <input
          type="text"
          placeholder="required note"
          value={form.reasonNote}
          onChange={(e) => setForm((prev) => ({ ...prev, reasonNote: e.target.value }))}
        />
      )}
      <button
        disabled={!canSavePlanned || !form.plannedDepartDate || updatePlannedDepartDate.isPending}
        onClick={() =>
          updatePlannedDepartDate.mutate({
            id: shipment.id,
            newDate: new Date(form.plannedDepartDate),
            reasonCategory: form.reasonCategory,
            reasonNote: noteRequired ? form.reasonNote : undefined,
          })
        }
      >
        Save planned depart date
      </button>
      {updatePlannedDepartDate.error && <div>Failed to save: {updatePlannedDepartDate.error.message}</div>}

      {shipment.plannedDepartDate && (
        <div style={{ marginTop: "4px" }}>
          <input
            type="date"
            value={form.actualDepartDate}
            onChange={(e) => setForm((prev) => ({ ...prev, actualDepartDate: e.target.value }))}
          />
          <button
            disabled={markDeparted.isPending}
            onClick={() => markDeparted.mutate({ id: shipment.id, actualDate: new Date(form.actualDepartDate) })}
          >
            Mark departed
          </button>
          {markDeparted.error && <div>Failed to mark departed: {markDeparted.error.message}</div>}
        </div>
      )}
    </div>
  );
}

function StatusTransitionControl({ shipment, onUpdated }: { shipment: ShipmentListItem; onUpdated: () => void }) {
  const updateStatus = trpc.shipments.updateStatus.useMutation({ onSuccess: onUpdated });
  const [form, setForm] = useState<StatusTransitionFormState>(() => defaultStatusTransitionForm());
  // "delivered" always has a dedicated control (CustomsArrivalControl's
  // "Save arrival date" button) -- offering it here too would render a
  // working-looking option that updateShipmentStatus (server/shipments.ts)
  // unconditionally rejects. ("departed" needs no such filter: it isn't a key
  // in VALID_SHIPMENT_TRANSITIONS at all, so it never appears here in the
  // first place — see the comment on that constant above.)
  const nextStatuses = (VALID_SHIPMENT_TRANSITIONS[shipment.status] ?? []).filter(
    (s) => s !== "delivered",
  );
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
          type="text"
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
  const costsRecorded = shipment.freightCost != null && shipment.dutyCost != null && shipment.costCurrency != null;

  return (
    <div>
      <div>
        Customs: <span className={CUSTOMS_STATUS_BADGE_CLASS[shipment.customsStatus] ?? DEFAULT_STATUS_BADGE_CLASS}>{shipment.customsStatus}</span>
        {" "}· Arrived: {shipment.actualArrivalDate ? new Date(shipment.actualArrivalDate).toISOString().slice(0, 10) : "—"}
      </div>
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
          type="text"
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
        disabled={!canSave || !form.actualArrivalDate || shipment.status !== "customs" || !costsRecorded || markArrived.isPending}
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
      {shipment.status !== "customs" && shipment.status !== "delivered" && <p>Available once the shipment has reached customs.</p>}
      {shipment.status === "customs" && !costsRecorded && <p>Available once freight/duty costs are recorded.</p>}
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
          type="text"
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
  const skusQuery = trpc.catalog.listSkus.useQuery();
  const skusById = new Map((skusQuery.data ?? []).map((s) => [s.id, s]));
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
        <span className={SHIPMENT_STATUS_BADGE_CLASS[shipment.status] ?? DEFAULT_STATUS_BADGE_CLASS}>{shipment.status}</span>
        <div style={{ marginTop: "8px" }}>
          <PlannedDepartureControl shipment={shipment} onUpdated={() => { refetch(); utils.shipments.list.invalidate(); }} />
        </div>
        <div style={{ marginTop: "8px" }}>
          <StatusTransitionControl shipment={shipment} onUpdated={() => { refetch(); utils.shipments.list.invalidate(); }} />
        </div>
        <div style={{ marginTop: "8px" }}>
          <CustomsArrivalControl shipment={shipment} onUpdated={() => { refetch(); utils.shipments.list.invalidate(); }} />
        </div>
        <div style={{ marginTop: "8px" }}>
          <DepartDateCorrectionControl shipment={shipment} onUpdated={() => { refetch(); utils.shipments.list.invalidate(); }} />
        </div>
        <div style={{ marginTop: "8px" }}><Link to={`/change-log/shipment/${shipment.id}`}>History</Link></div>
      </td>
      <td>
        <ul>
          {data.lineItems.map((li) => (
            <li key={li.id}>{skuLabel(skusById.get(li.skuId) ?? { id: li.skuId })} — qty {li.qty}</li>
          ))}
        </ul>
      </td>
      <td>
        <div>
          Freight: {shipment.freightCost != null && shipment.costCurrency ? formatMoney(shipment.freightCost, shipment.costCurrency) : "—"}
          {" · "}
          Duty: {shipment.dutyCost != null && shipment.costCurrency ? formatMoney(shipment.dutyCost, shipment.costCurrency) : "—"}
        </div>
        <input
          type="text"
          placeholder="freight cost"
          value={form.freightCost}
          onChange={(e) => setForm((prev) => ({ ...prev, freightCost: e.target.value }))}
        />
        <input
          type="text"
          placeholder="duty cost"
          value={form.dutyCost}
          onChange={(e) => setForm((prev) => ({ ...prev, dutyCost: e.target.value }))}
        />
        <input
          type="text"
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
            type="text"
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

interface NewShipmentLineItem {
  poLineItemId: number;
  skuId: number;
  qty: number;
  weightShare: string;
  valueShare: string;
}

function NewLineItemPicker({ onAdd }: { onAdd: (li: NewShipmentLineItem) => void }) {
  const posQuery = trpc.purchaseOrders.list.useQuery();
  const skusQuery = trpc.catalog.listSkus.useQuery();
  const skusById = new Map((skusQuery.data ?? []).map((s) => [s.id, s]));
  const [poId, setPoId] = useState("");
  const poLineItemsQuery = trpc.purchaseOrders.getWithLineItems.useQuery(Number(poId), { enabled: poId !== "" });
  const [poLineItemId, setPoLineItemId] = useState("");
  const [qty, setQty] = useState("");
  const [weightShare, setWeightShare] = useState("1.0");
  const [valueShare, setValueShare] = useState("1.0");

  if (posQuery.error) return <div>Failed to load purchase orders: {posQuery.error.message}</div>;

  const selectedLineItem = poLineItemsQuery.data?.lineItems.find((li) => li.id === Number(poLineItemId));
  const canAdd = poId !== "" && poLineItemId !== "" && qty.trim().length > 0 && weightShare.trim().length > 0 && valueShare.trim().length > 0;

  return (
    <div>
      <select value={poId} onChange={(e) => { setPoId(e.target.value); setPoLineItemId(""); }}>
        <option value="">PO…</option>
        {(posQuery.data ?? []).map((po) => <option key={po.id} value={po.id}>{po.poNumber}</option>)}
      </select>
      {poId !== "" && poLineItemsQuery.isLoading && <span>Loading line items…</span>}
      {poId !== "" && poLineItemsQuery.error && <span>Failed to load line items: {poLineItemsQuery.error.message}</span>}
      {poId !== "" && poLineItemsQuery.data && (
        <select value={poLineItemId} onChange={(e) => setPoLineItemId(e.target.value)}>
          <option value="">Line item…</option>
          {poLineItemsQuery.data.lineItems.map((li) => (
            <option key={li.id} value={li.id}>{skuLabel(skusById.get(li.skuId) ?? { id: li.skuId })} — qty {li.qty} @ {formatMoney(li.unitPrice, li.currency)}</option>
          ))}
        </select>
      )}
      <input type="text" placeholder="qty" value={qty} onChange={(e) => setQty(e.target.value)} />
      <input type="text" placeholder="weight share" value={weightShare} onChange={(e) => setWeightShare(e.target.value)} />
      <input type="text" placeholder="value share" value={valueShare} onChange={(e) => setValueShare(e.target.value)} />
      <button
        disabled={!canAdd}
        onClick={() => {
          if (!selectedLineItem) return;
          onAdd({ poLineItemId: selectedLineItem.id, skuId: selectedLineItem.skuId, qty: Number(qty), weightShare, valueShare });
          setPoLineItemId("");
          setQty("");
        }}
      >
        Add line item
      </button>
    </div>
  );
}

function CreateShipmentForm() {
  const utils = trpc.useUtils();
  const warehousesQuery = trpc.catalog.listWarehouses.useQuery();
  const skusQuery = trpc.catalog.listSkus.useQuery();
  const skusById = new Map((skusQuery.data ?? []).map((s) => [s.id, s]));
  const [shipmentRef, setShipmentRef] = useState("");
  const [warehouseId, setWarehouseId] = useState("");
  const [lineItems, setLineItems] = useState<NewShipmentLineItem[]>([]);
  const createShipment = trpc.shipments.create.useMutation({
    onSuccess: () => {
      setShipmentRef("");
      setWarehouseId("");
      setLineItems([]);
      utils.shipments.list.invalidate();
    },
  });

  if (warehousesQuery.error) return <div>Failed to load warehouses: {warehousesQuery.error.message}</div>;

  const canCreate = shipmentRef.trim().length > 0 && warehouseId !== "" && lineItems.length > 0;

  return (
    <div>
      <h2>New Shipment</h2>
      <input type="text" placeholder="shipment ref" value={shipmentRef} onChange={(e) => setShipmentRef(e.target.value)} />
      <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
        <option value="">Warehouse…</option>
        {(warehousesQuery.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}
      </select>
      {lineItems.length > 0 && (
        <ul>
          {lineItems.map((li, i) => (
            <li key={i}>
              {skuLabel(skusById.get(li.skuId) ?? { id: li.skuId })} — qty {li.qty} (weight {li.weightShare}, value {li.valueShare}){" "}
              <button onClick={() => setLineItems((prev) => prev.filter((_, idx) => idx !== i))}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      <NewLineItemPicker onAdd={(li) => setLineItems((prev) => [...prev, li])} />
      <button
        disabled={!canCreate || createShipment.isPending}
        onClick={() => createShipment.mutate({ shipmentRef, warehouseId: Number(warehouseId), lineItems })}
      >
        Create shipment
      </button>
      {createShipment.error && <div>Failed to create: {createShipment.error.message}</div>}
    </div>
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
      <CreateShipmentForm />
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
