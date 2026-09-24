import { Fragment, useState } from "react";
import { Link } from "react-router-dom";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../server/routers";
import { trpc } from "../lib/trpc";
import { PO_STATUSES } from "../../../drizzle/schema";
import { MANUAL_REASON_CATEGORIES } from "../../../shared/constants";
import { skuLabel, formatMoney } from "../lib/labels";

type ReasonCategory = (typeof MANUAL_REASON_CATEGORIES)[number];

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

interface PaymentCorrectionFormState {
  amount: string;
  fxRate: string;
  paidDate: string;
  reasonNote: string;
}

function defaultPaymentCorrectionForm(payment: Payment): PaymentCorrectionFormState {
  return {
    amount: payment.paidAmount ?? "",
    fxRate: payment.fxRate ?? "1",
    paidDate: payment.paidDate ? toDateInputValue(payment.paidDate) : toDateInputValue(null),
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
        Payment #{payment.sequenceNo}: paid {formatMoney(payment.paidAmount!, payment.currency)} on {payment.paidDate ? new Date(payment.paidDate).toISOString().slice(0, 10) : "—"}
        <CorrectPaymentControl payment={payment} onCorrected={onPaid} />
        <PaymentHistory paymentId={payment.id} />
      </li>
    );
  }

  return (
    <li>
      Payment #{payment.sequenceNo}: expected {formatMoney(payment.expectedAmount, payment.currency)} on {new Date(payment.expectedDate).toISOString().slice(0, 10)}
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
        {MANUAL_REASON_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
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

function CorrectPaymentControl({ payment, onCorrected }: { payment: Payment; onCorrected: () => void }) {
  const correctAmount = trpc.payments.correctAmount.useMutation({ onSuccess: onCorrected });
  const [form, setForm] = useState<PaymentCorrectionFormState>(() => defaultPaymentCorrectionForm(payment));
  const canSave = form.amount.trim().length > 0 && form.fxRate.trim().length > 0 && form.reasonNote.trim().length > 0;

  return (
    <span>
      {" "}
      <input
        type="text"
        placeholder="corrected amount"
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
      <input
        type="text"
        placeholder="what changed and why"
        value={form.reasonNote}
        onChange={(e) => setForm((prev) => ({ ...prev, reasonNote: e.target.value }))}
      />
      <button
        disabled={!canSave || correctAmount.isPending}
        onClick={() =>
          correctAmount.mutate({
            id: payment.id,
            amount: form.amount,
            fxRate: form.fxRate,
            paidDate: new Date(form.paidDate),
            reasonNote: form.reasonNote,
          })
        }
      >
        Correct payment
      </button>
      {correctAmount.error && <div>Failed to correct: {correctAmount.error.message}</div>}
    </span>
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

type PoLineItemWithId = RouterOutputs["purchaseOrders"]["getWithLineItems"]["lineItems"][number];

interface CostComponentsFormState {
  exwUnitPrice: string;
  labTestUnitPrice: string;
  inspectionUnitPrice: string;
  addOnUnitPrice: string;
  reasonCategory: ReasonCategory;
  reasonNote: string;
}

function defaultCostComponentsForm(line: PoLineItemWithId): CostComponentsFormState {
  return {
    exwUnitPrice: line.exwUnitPrice ?? "",
    labTestUnitPrice: line.labTestUnitPrice ?? "",
    inspectionUnitPrice: line.inspectionUnitPrice ?? "",
    addOnUnitPrice: line.addOnUnitPrice ?? "",
    reasonCategory: "vendor_price_change",
    reasonNote: "",
  };
}

// Breaks down po_line_items.unitPrice (Control Tower's blended "Full Factory
// Cost/unit") into its 4 real components. unitPrice itself stays the value
// every landed-cost calculation reads -- this control only ever asks the
// server to recompute it from whatever components are known, never sets it
// directly.
function PoLineItemCostComponentsControl({ line, onUpdated }: { line: PoLineItemWithId; onUpdated: () => void }) {
  const updateComponents = trpc.purchaseOrders.updateLineItemCostComponents.useMutation({ onSuccess: onUpdated });
  const [form, setForm] = useState<CostComponentsFormState>(() => defaultCostComponentsForm(line));
  const noteRequired = form.reasonCategory === "other";
  const canSave = !noteRequired || form.reasonNote.trim().length > 0;

  return (
    <div>
      <div>Unit price (EXW+Lab-Test+Inspection+Add-on): {formatMoney(line.unitPrice, line.currency)}</div>
      <input type="text" placeholder="EXW/unit" value={form.exwUnitPrice} onChange={(e) => setForm((prev) => ({ ...prev, exwUnitPrice: e.target.value }))} />
      <input type="text" placeholder="lab-test/unit" value={form.labTestUnitPrice} onChange={(e) => setForm((prev) => ({ ...prev, labTestUnitPrice: e.target.value }))} />
      <input type="text" placeholder="inspection/unit" value={form.inspectionUnitPrice} onChange={(e) => setForm((prev) => ({ ...prev, inspectionUnitPrice: e.target.value }))} />
      <input type="text" placeholder="add-on/unit" value={form.addOnUnitPrice} onChange={(e) => setForm((prev) => ({ ...prev, addOnUnitPrice: e.target.value }))} />
      <select value={form.reasonCategory} onChange={(e) => setForm((prev) => ({ ...prev, reasonCategory: e.target.value as ReasonCategory }))}>
        {MANUAL_REASON_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
      {noteRequired && (
        <input type="text" placeholder="required note" value={form.reasonNote} onChange={(e) => setForm((prev) => ({ ...prev, reasonNote: e.target.value }))} />
      )}
      <button
        disabled={!canSave || updateComponents.isPending}
        onClick={() =>
          updateComponents.mutate({
            lineItemId: line.id,
            exwUnitPrice: form.exwUnitPrice || undefined,
            labTestUnitPrice: form.labTestUnitPrice || undefined,
            inspectionUnitPrice: form.inspectionUnitPrice || undefined,
            addOnUnitPrice: form.addOnUnitPrice || undefined,
            reasonCategory: form.reasonCategory,
            reasonNote: noteRequired ? form.reasonNote : undefined,
          })
        }
      >
        Save cost breakdown
      </button>
      {updateComponents.error && <div>Failed to save: {updateComponents.error.message}</div>}
    </div>
  );
}

// Control Tower's "Qty Ordered/Produced/Remaining to Produce/Remaining to
// Ship" -- factory progress tracking, explicitly in scope per Artem (this
// platform otherwise stays out of production/Ops tracking).
function PoLineItemProductionControl({ line }: { line: PoLineItemWithId }) {
  const progressQuery = trpc.purchaseOrders.lineItemProductionProgress.useQuery(line.id);
  const utils = trpc.useUtils();
  const updateProduction = trpc.purchaseOrders.updateLineItemProduction.useMutation({
    onSuccess: () => utils.purchaseOrders.lineItemProductionProgress.invalidate(line.id),
  });
  const [qtyProduced, setQtyProduced] = useState(String(line.qtyProduced ?? 0));

  if (progressQuery.error) return <div>Failed to load production progress: {progressQuery.error.message}</div>;
  if (progressQuery.isLoading || !progressQuery.data) return <div>Loading production progress…</div>;
  const p = progressQuery.data;

  return (
    <div>
      <div>
        Ordered {p.qtyOrdered} · Produced {p.qtyProduced} · Remaining to produce {p.qtyRemainingToProduce}
        {" · "}Shipped {p.qtyShipped} · Remaining to ship {p.qtyRemainingToShip}
      </div>
      <input
        type="text"
        placeholder="qty produced"
        value={qtyProduced}
        onChange={(e) => setQtyProduced(e.target.value)}
      />
      <button
        disabled={updateProduction.isPending || qtyProduced.trim() === ""}
        onClick={() => updateProduction.mutate({ lineItemId: line.id, qtyProduced: Number(qtyProduced) })}
      >
        Save production progress
      </button>
      {updateProduction.error && <div>Failed to save: {updateProduction.error.message}</div>}
    </div>
  );
}

function PoLineItemsSection({ poId, onUpdated }: { poId: number; onUpdated: () => void }) {
  const linesQuery = trpc.purchaseOrders.getWithLineItems.useQuery(poId);
  const skusQuery = trpc.catalog.listSkus.useQuery();
  const skusById = new Map((skusQuery.data ?? []).map((s) => [s.id, s]));

  if (linesQuery.error) return <div>Failed to load line items: {linesQuery.error.message}</div>;
  if (linesQuery.isLoading || !linesQuery.data) return <div>Loading line items…</div>;
  if (linesQuery.data.lineItems.length === 0) return null;

  return (
    <div>
      <strong>Line items</strong>
      {linesQuery.data.lineItems.map((line) => (
        <div key={line.id} style={{ marginTop: "4px" }}>
          {skuLabel(skusById.get(line.skuId) ?? { id: line.skuId })} — qty {line.qty}
          <PoLineItemCostComponentsControl line={line} onUpdated={onUpdated} />
          <PoLineItemProductionControl line={line} />
        </div>
      ))}
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
              {skuLabel(skusById.get(li.skuId) ?? { id: li.skuId })} — qty {li.qty} @ {formatMoney(li.unitPrice, li.currency)}{" "}
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
        {MANUAL_REASON_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
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

type PoListItem = RouterOutputs["purchaseOrders"]["list"][number];

interface PoLinksFormState {
  contractLink: string;
  invoiceLink: string;
  addOnLink: string;
}

function defaultLinksForm(po: PoListItem): PoLinksFormState {
  return {
    contractLink: po.contractLink ?? "",
    invoiceLink: po.invoiceLink ?? "",
    addOnLink: po.addOnLink ?? "",
  };
}

// Reference links only (Google Drive etc.) -- this platform never stores the
// documents themselves. No reasonCategory/audit trail: these don't affect
// delay or cost, the only things this codebase's change_log tracks.
function ActualReadyDateControl({ po, onUpdated }: { po: PoListItem; onUpdated: () => void }) {
  const updateActualReadyDate = trpc.purchaseOrders.updateActualReadyDate.useMutation({ onSuccess: onUpdated });
  const [newDate, setNewDate] = useState(po.actualReadyDate ? new Date(po.actualReadyDate).toISOString().slice(0, 10) : "");
  const [reasonCategory, setReasonCategory] = useState<ReasonCategory>("production_delay");
  const [reasonNote, setReasonNote] = useState("");
  const noteRequired = reasonCategory === "other";
  const canSave = newDate !== "" && (!noteRequired || reasonNote.trim().length > 0);

  return (
    <div>
      <div>Actual ready: {po.actualReadyDate ? new Date(po.actualReadyDate).toISOString().slice(0, 10) : "—"}</div>
      <input type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} />
      <select value={reasonCategory} onChange={(e) => setReasonCategory(e.target.value as ReasonCategory)}>
        {MANUAL_REASON_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
      {noteRequired && (
        <input type="text" placeholder="required note" value={reasonNote} onChange={(e) => setReasonNote(e.target.value)} />
      )}
      <button
        disabled={!canSave || updateActualReadyDate.isPending}
        onClick={() => updateActualReadyDate.mutate({ id: po.id, newDate: new Date(newDate), reasonCategory, reasonNote: noteRequired ? reasonNote : undefined })}
      >
        Save actual ready date
      </button>
      {updateActualReadyDate.error && <div>Failed to save: {updateActualReadyDate.error.message}</div>}
    </div>
  );
}

function PoLinksControl({ po, onUpdated }: { po: PoListItem; onUpdated: () => void }) {
  const updateLinks = trpc.purchaseOrders.updateLinks.useMutation({ onSuccess: onUpdated });
  const [form, setForm] = useState<PoLinksFormState>(() => defaultLinksForm(po));

  const linkRow = (label: string, url: string | null) =>
    url ? <div>{label}: <a href={url} target="_blank" rel="noreferrer">{label}</a></div> : null;

  return (
    <div>
      {linkRow("Contract", po.contractLink)}
      {linkRow("Invoice", po.invoiceLink)}
      {linkRow("Add-on", po.addOnLink)}
      <input
        type="text"
        placeholder="contract link"
        value={form.contractLink}
        onChange={(e) => setForm((prev) => ({ ...prev, contractLink: e.target.value }))}
      />
      <input
        type="text"
        placeholder="invoice link"
        value={form.invoiceLink}
        onChange={(e) => setForm((prev) => ({ ...prev, invoiceLink: e.target.value }))}
      />
      <input
        type="text"
        placeholder="add-on link"
        value={form.addOnLink}
        onChange={(e) => setForm((prev) => ({ ...prev, addOnLink: e.target.value }))}
      />
      <button
        disabled={updateLinks.isPending}
        onClick={() =>
          updateLinks.mutate({
            id: po.id,
            contractLink: form.contractLink.trim(),
            invoiceLink: form.invoiceLink.trim(),
            addOnLink: form.addOnLink.trim(),
          })
        }
      >
        Save links
      </button>
      {updateLinks.error && <div>Failed to save: {updateLinks.error.message}</div>}
    </div>
  );
}

export function PurchaseOrdersPage() {
  const { data: pos, isLoading, error, refetch } = trpc.purchaseOrders.list.useQuery();
  const updateDate = trpc.purchaseOrders.updatePlannedReadyDate.useMutation({ onSuccess: () => refetch() });
  const [rowState, setRowState] = useState<Record<number, RowState>>({});
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());

  if (error) return <div>Failed to load: {error.message}</div>;
  if (isLoading || !pos) return <div>Loading…</div>;

  const setRow = (id: number, plannedReadyDate: string | Date | null | undefined, patch: Partial<RowState>) =>
    setRowState((prev) => ({ ...prev, [id]: { ...(prev[id] ?? defaultRowState(plannedReadyDate)), ...patch } }));

  const toggleExpanded = (id: number) =>
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  return (
    <div>
      <h1>Purchase Orders</h1>
      <CreatePoForm />
      <table>
        <thead><tr><th>PO</th><th>Status</th><th>Planned Ready</th><th>Change date</th><th>Actual Ready</th><th>Payments</th><th>Shipments</th><th>Line Items</th><th>Links</th></tr></thead>
        <tbody>
          {pos.map((po) => {
            const row = rowState[po.id] ?? defaultRowState(po.plannedReadyDate);
            const noteRequired = row.reasonCategory === "other";
            const canSave = !noteRequired || row.reasonNote.trim().length > 0;
            const expanded = expandedIds.has(po.id);
            return (
              <Fragment key={po.id}>
                <tr>
                  <td>{po.poNumber}</td>
                  <td>
                    <span className={PO_STATUS_BADGE_CLASS[po.status] ?? DEFAULT_STATUS_BADGE_CLASS}>{po.status}</span>
                    <div style={{ marginTop: "8px" }}>
                      <button onClick={() => toggleExpanded(po.id)}>{expanded ? "Hide details ▴" : "Details ▾"}</button>
                    </div>
                  </td>
                  <td>{po.plannedReadyDate ? new Date(po.plannedReadyDate).toISOString().slice(0, 10) : "—"}</td>
                  <td>{expanded ? null : "(see details)"}</td>
                  <td>{po.actualReadyDate ? new Date(po.actualReadyDate).toISOString().slice(0, 10) : "—"}</td>
                  <td>{expanded ? null : "(see details)"}</td>
                  <td>{expanded ? null : "(see details)"}</td>
                  <td>{expanded ? null : "(see details)"}</td>
                  <td>{po.contractLink || po.invoiceLink || po.addOnLink ? "links set" : "—"}</td>
                </tr>
                {expanded && (
                  <tr>
                    <td colSpan={9}>
                      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                        <div>
                          <AdvanceStatusControl po={po} onAdvanced={refetch} />
                          <div><Link to={`/change-log/purchase_order/${po.id}`}>History</Link></div>
                        </div>
                        <div>
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
                            {MANUAL_REASON_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
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
                        </div>
                        <div>
                          <ActualReadyDateControl po={po} onUpdated={refetch} />
                        </div>
                        <div>
                          <PoPaymentsSection poId={po.id} />
                        </div>
                        <div>
                          <PoShipmentsSection poId={po.id} />
                        </div>
                        <div>
                          <PoLineItemsSection poId={po.id} onUpdated={refetch} />
                        </div>
                        <div>
                          <PoLinksControl po={po} onUpdated={refetch} />
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {updateDate.error && <div>Failed to save: {updateDate.error.message}</div>}
    </div>
  );
}
