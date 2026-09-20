import { useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../server/routers";
import { trpc } from "../lib/trpc";
import { PO_STATUSES } from "../../../drizzle/schema";
import { skuLabel } from "../lib/labels";

const REASON_CATEGORIES = [
  "production_delay", "artwork_delay", "customs_hold", "logistics_delay",
  "payment_timing", "vendor_price_change", "freight_rate_change", "holiday_capacity", "other",
] as const;

type ReasonCategory = (typeof REASON_CATEGORIES)[number];

const PO_STATUS_BADGE_CLASS: Record<string, string> = {
  delivered: "badge badge-ok",
  closed: "badge badge-ok",
  customs: "badge badge-warning",
};
const SHIPMENT_STATUS_BADGE_CLASS: Record<string, string> = {
  delivered: "badge badge-ok",
  customs: "badge badge-warning",
};
const DEFAULT_STATUS_BADGE_CLASS = "badge badge-neutral";

type RouterOutputs = inferRouterOutputs<AppRouter>;
type Payment = RouterOutputs["payments"]["createExpectedPayment"];

interface RowState {
  reasonCategory: ReasonCategory;
  reasonNote: string;
  newDate: string;
}

function toDateInputValue(date: string | Date | null | undefined): string {
  if (typeof date === "string") return date;
  const base = date ?? new Date();
  return base.toISOString().slice(0, 10);
}

function defaultRowState(plannedReadyDate: string | Date | null | undefined): RowState {
  return { reasonCategory: "production_delay", reasonNote: "", newDate: toDateInputValue(plannedReadyDate) };
}

interface NewPaymentFormState {
  sequenceNo: string;
  expectedAmount: string;
  expectedDate: string;
  currency: string;
}

function defaultNewPaymentForm(): NewPaymentFormState {
  return { sequenceNo: "1", expectedAmount: "", expectedDate: toDateInputValue(null), currency: "USD" };
}

interface MarkPaidFormState {
  amount: string;
  fxRate: string;
  paidDate: string;
  reasonCategory: ReasonCategory;
  reasonNote: string;
}

function defaultMarkPaidForm(expectedAmount: string): MarkPaidFormState {
  return {
    amount: expectedAmount,
    fxRate: "1",
    paidDate: toDateInputValue(null),
    reasonCategory: "payment_timing",
    reasonNote: "",
  };
}

function MarkPaidRow({ payment, onPaid }: { payment: Payment; onPaid: () => void }) {
  const markPaid = trpc.payments.markPaid.useMutation({ onSuccess: () => onPaid() });
  const [form, setForm] = useState<MarkPaidFormState>(() => defaultMarkPaidForm(payment.expectedAmount));
  const noteRequired = form.reasonCategory === "other";
  const canSave = form.amount.trim().length > 0 && form.fxRate.trim().length > 0
    && (!noteRequired || form.reasonNote.trim().length > 0);

  if (payment.paid) {
    return (
      <li>
        Payment #{payment.sequenceNo}: paid {payment.paidAmount} {payment.currency} on {payment.paidDate?.toString()}
        <PaymentHistory paymentId={payment.id} />
      </li>
    );
  }

  return (
    <li>
      Payment #{payment.sequenceNo}: expected {payment.expectedAmount} {payment.currency} on {payment.expectedDate.toString()}
      {" — "}
      <input
        type="text"
        placeholder="amount"
        value={form.amount}
        onChange={(e) => setForm((prev) => ({ ...prev, amount: e.target.value }))}
      />
      <input
        type="text"
        placeholder="fx rate"
        value={form.fxRate}
        onChange={(e) => setForm((prev) => ({ ...prev, fxRate: e.target.value }))}
      />
      <input
        type="date"
        value={form.paidDate}
        onChange={(e) => setForm((prev) => ({ ...prev, paidDate: e.target.value }))}
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
        disabled={!canSave || markPaid.isPending}
        onClick={() =>
          markPaid.mutate({
            id: payment.id,
            amount: form.amount,
            fxRate: form.fxRate,
            paidDate: new Date(form.paidDate),
            reasonCategory: form.reasonCategory,
            reasonNote: noteRequired ? form.reasonNote : undefined,
          })
        }
      >
        Mark paid
      </button>
      {markPaid.error && <div>Failed to save: {markPaid.error.message}</div>}
      <PaymentHistory paymentId={payment.id} />
    </li>
  );
}

function PaymentHistory({ paymentId }: { paymentId: number }) {
  const [expanded, setExpanded] = useState(false);
  const historyQuery = trpc.payments.history.useQuery(paymentId, { enabled: expanded });

  return (
    <span>
      {" "}
      <button onClick={() => setExpanded((prev) => !prev)}>{expanded ? "Hide history" : "History"}</button>
      {expanded && historyQuery.data && (
        <ul>
          {historyQuery.data.map((entry) => (
            <li key={entry.id}>
              {entry.field}: {entry.oldValue ?? "—"} → {entry.newValue ?? "—"}
              {entry.reasonCategory && ` (${entry.reasonCategory}${entry.reasonNote ? `: ${entry.reasonNote}` : ""})`}
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}

function PoPaymentsSection({ poId }: { poId: number }) {
  const utils = trpc.useUtils();
  const paymentsQuery = trpc.payments.listForPo.useQuery(poId);
  const [form, setForm] = useState<NewPaymentFormState>(() => defaultNewPaymentForm());
  const createPayment = trpc.payments.createExpectedPayment.useMutation({
    onSuccess: () => {
      utils.payments.listForPo.invalidate(poId);
      setForm((prev) => ({ ...defaultNewPaymentForm(), sequenceNo: String(Number(prev.sequenceNo) + 1) }));
      utils.dashboards.money.invalidate();
    },
  });
  const canCreate = form.expectedAmount.trim().length > 0 && form.currency.trim().length > 0;

  const refreshAfterPaid = () => {
    utils.payments.listForPo.invalidate(poId);
    utils.dashboards.money.invalidate();
  };

  if (paymentsQuery.error) return <div>Failed to load payments: {paymentsQuery.error.message}</div>;

  return (
    <div>
      <strong>Payments</strong>
      {paymentsQuery.isLoading && <div>Loading payments…</div>}
      {paymentsQuery.data && paymentsQuery.data.length > 0 && (
        <ul>
          {paymentsQuery.data.map((payment) => (
            <MarkPaidRow
              key={payment.id}
              payment={payment}
              onPaid={refreshAfterPaid}
            />
          ))}
        </ul>
      )}
      <div>
        <input
          type="text"
          placeholder="sequence no"
          value={form.sequenceNo}
          onChange={(e) => setForm((prev) => ({ ...prev, sequenceNo: e.target.value }))}
        />
        <input
          type="text"
          placeholder="expected amount"
          value={form.expectedAmount}
          onChange={(e) => setForm((prev) => ({ ...prev, expectedAmount: e.target.value }))}
        />
        <input
          type="date"
          value={form.expectedDate}
          onChange={(e) => setForm((prev) => ({ ...prev, expectedDate: e.target.value }))}
        />
        <input
          type="text"
          placeholder="currency"
          value={form.currency}
          onChange={(e) => setForm((prev) => ({ ...prev, currency: e.target.value }))}
        />
        <button
          disabled={!canCreate || createPayment.isPending}
          onClick={() =>
            createPayment.mutate({
              poId,
              sequenceNo: Number(form.sequenceNo) || 1,
              expectedAmount: form.expectedAmount,
              expectedDate: new Date(form.expectedDate),
              currency: form.currency,
            })
          }
        >
          Add expected payment
        </button>
        {createPayment.error && <div>Failed to save: {createPayment.error.message}</div>}
      </div>
    </div>
  );
}

function PoShipmentsSection({ poId }: { poId: number }) {
  const shipmentsQuery = trpc.shipments.listForPo.useQuery(poId);

  if (shipmentsQuery.error) return <div>Failed to load shipments: {shipmentsQuery.error.message}</div>;
  if (shipmentsQuery.isLoading || !shipmentsQuery.data) return <div>Loading shipments…</div>;
  if (shipmentsQuery.data.length === 0) return null;

  return (
    <div>
      <strong>Shipments</strong>
      <ul>
        {shipmentsQuery.data.map((shipment) => (
          <li key={shipment.id}>
            {shipment.shipmentRef} — <span className={SHIPMENT_STATUS_BADGE_CLASS[shipment.status] ?? DEFAULT_STATUS_BADGE_CLASS}>{shipment.status}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface NewPoLineItem {
  skuId: number;
  qty: number;
  unitPrice: string;
  currency: string;
}

function NewPoLineItemPicker({ onAdd }: { onAdd: (li: NewPoLineItem) => void }) {
  const skusQuery = trpc.catalog.listSkus.useQuery();
  const [skuId, setSkuId] = useState("");
  const [qty, setQty] = useState("");
  const [unitPrice, setUnitPrice] = useState("");
  const [currency, setCurrency] = useState("USD");

  if (skusQuery.error) return <div>Failed to load SKUs: {skusQuery.error.message}</div>;

  const canAdd = skuId !== "" && qty.trim().length > 0 && unitPrice.trim().length > 0 && currency.trim().length > 0;

  return (
    <div>
      <select value={skuId} onChange={(e) => setSkuId(e.target.value)}>
        <option value="">SKU…</option>
        {(skusQuery.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.sku ?? s.name ?? `#${s.id}`}</option>)}
      </select>
      <input type="text" placeholder="qty" value={qty} onChange={(e) => setQty(e.target.value)} />
      <input type="text" placeholder="unit price" value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} />
      <input type="text" placeholder="currency" value={currency} onChange={(e) => setCurrency(e.target.value)} />
      <button
        disabled={!canAdd}
        onClick={() => {
          onAdd({ skuId: Number(skuId), qty: Number(qty), unitPrice, currency });
          setSkuId("");
          setQty("");
          setUnitPrice("");
        }}
      >
        Add line item
      </button>
    </div>
  );
}

function CreatePoForm() {
  const utils = trpc.useUtils();
  const vendorsQuery = trpc.catalog.listVendors.useQuery();
  const skusQuery = trpc.catalog.listSkus.useQuery();
  const skusById = new Map((skusQuery.data ?? []).map((s) => [s.id, s]));
  const [poNumber, setPoNumber] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [lineItems, setLineItems] = useState<NewPoLineItem[]>([]);
  const createPo = trpc.purchaseOrders.create.useMutation({
    onSuccess: () => {
      setPoNumber("");
      setVendorId("");
      setLineItems([]);
      utils.purchaseOrders.list.invalidate();
    },
  });

  if (vendorsQuery.error) return <div>Failed to load vendors: {vendorsQuery.error.message}</div>;

  const canCreate = poNumber.trim().length > 0 && vendorId !== "" && lineItems.length > 0;

  return (
    <div>
      <h2>New Purchase Order</h2>
      <input type="text" placeholder="PO number" value={poNumber} onChange={(e) => setPoNumber(e.target.value)} />
      <select value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
        <option value="">Vendor…</option>
        {(vendorsQuery.data ?? []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
      </select>
      {lineItems.length > 0 && (
        <ul>
          {lineItems.map((li, i) => (
            <li key={i}>
              {skuLabel(skusById.get(li.skuId) ?? { id: li.skuId })} — qty {li.qty} @ {li.unitPrice} {li.currency}{" "}
              <button onClick={() => setLineItems((prev) => prev.filter((_, idx) => idx !== i))}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      <NewPoLineItemPicker onAdd={(li) => setLineItems((prev) => [...prev, li])} />
      <button
        disabled={!canCreate || createPo.isPending}
        onClick={() => createPo.mutate({ poNumber, vendorId: Number(vendorId), lineItems })}
      >
        Create PO
      </button>
      {createPo.error && <div>Failed to create: {createPo.error.message}</div>}
    </div>
  );
}

function AdvanceStatusControl({ po, onAdvanced }: { po: { id: number; status: (typeof PO_STATUSES)[number] }; onAdvanced: () => void }) {
  const [reasonCategory, setReasonCategory] = useState<ReasonCategory>("logistics_delay");
  const [reasonNote, setReasonNote] = useState("");
  const updateStatus = trpc.purchaseOrders.updateStatus.useMutation({
    onSuccess: () => {
      setReasonNote("");
      onAdvanced();
    },
  });
  const nextStatus = PO_STATUSES[PO_STATUSES.indexOf(po.status) + 1];
  const noteRequired = reasonCategory === "other";

  if (!nextStatus) return null;

  return (
    <div>
      <select value={reasonCategory} onChange={(e) => setReasonCategory(e.target.value as ReasonCategory)}>
        {REASON_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
      {noteRequired && (
        <input placeholder="required note" value={reasonNote} onChange={(e) => setReasonNote(e.target.value)} />
      )}
      <button
        disabled={(noteRequired && !reasonNote.trim()) || updateStatus.isPending}
        onClick={() =>
          updateStatus.mutate({
            id: po.id,
            newStatus: nextStatus,
            reasonCategory,
            reasonNote: noteRequired ? reasonNote : undefined,
          })
        }
      >
        Advance to {nextStatus}
      </button>
      {updateStatus.error && <div>Failed to advance: {updateStatus.error.message}</div>}
    </div>
  );
}

export function PurchaseOrdersPage() {
  const { data: pos, isLoading, error, refetch } = trpc.purchaseOrders.list.useQuery();
  const updateDate = trpc.purchaseOrders.updatePlannedReadyDate.useMutation({ onSuccess: () => refetch() });
  const [rowState, setRowState] = useState<Record<number, RowState>>({});

  if (error) return <div>Failed to load: {error.message}</div>;
  if (isLoading || !pos) return <div>Loading…</div>;

  const setRow = (id: number, plannedReadyDate: string | Date | null | undefined, patch: Partial<RowState>) =>
    setRowState((prev) => ({ ...prev, [id]: { ...(prev[id] ?? defaultRowState(plannedReadyDate)), ...patch } }));

  return (
    <div>
      <h1>Purchase Orders</h1>
      <CreatePoForm />
      <table>
        <thead><tr><th>PO</th><th>Status</th><th>Planned Ready</th><th>Change date</th><th>Payments</th><th>Shipments</th></tr></thead>
        <tbody>
          {pos.map((po) => {
            const row = rowState[po.id] ?? defaultRowState(po.plannedReadyDate);
            const noteRequired = row.reasonCategory === "other";
            const canSave = !noteRequired || row.reasonNote.trim().length > 0;
            return (
              <tr key={po.id}>
                <td>{po.poNumber}</td>
                <td>
                  <span className={PO_STATUS_BADGE_CLASS[po.status] ?? DEFAULT_STATUS_BADGE_CLASS}>{po.status}</span>
                  <AdvanceStatusControl po={po} onAdvanced={refetch} />
                </td>
                <td>{po.plannedReadyDate?.toString() ?? "—"}</td>
                <td>
                  <input
                    type="date"
                    value={row.newDate}
                    onChange={(e) => setRow(po.id, po.plannedReadyDate, { newDate: e.target.value })}
                  />
                  <select
                    value={row.reasonCategory}
                    onChange={(e) =>
                      setRow(po.id, po.plannedReadyDate, { reasonCategory: e.target.value as ReasonCategory })
                    }
                  >
                    {REASON_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                  {noteRequired && (
                    <input
                      type="text"
                      placeholder="required note"
                      value={row.reasonNote}
                      onChange={(e) => setRow(po.id, po.plannedReadyDate, { reasonNote: e.target.value })}
                    />
                  )}
                  <button
                    disabled={!canSave || updateDate.isPending}
                    onClick={() =>
                      updateDate.mutate({
                        id: po.id,
                        newDate: new Date(row.newDate),
                        reasonCategory: row.reasonCategory,
                        reasonNote: noteRequired ? row.reasonNote : undefined,
                      })
                    }
                  >
                    Save
                  </button>
                </td>
                <td>
                  <PoPaymentsSection poId={po.id} />
                </td>
                <td>
                  <PoShipmentsSection poId={po.id} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {updateDate.error && <div>Failed to save: {updateDate.error.message}</div>}
    </div>
  );
}
