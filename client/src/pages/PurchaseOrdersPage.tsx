import { useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../server/routers";
import { trpc } from "../lib/trpc";

const REASON_CATEGORIES = [
  "production_delay", "artwork_delay", "customs_hold", "logistics_delay",
  "payment_timing", "vendor_price_change", "freight_rate_change", "holiday_capacity", "other",
] as const;

type ReasonCategory = (typeof REASON_CATEGORIES)[number];

type RouterOutputs = inferRouterOutputs<AppRouter>;
type Payment = RouterOutputs["payments"]["createExpectedPayment"];

interface RowState {
  reasonCategory: ReasonCategory;
  reasonNote: string;
  newDate: string;
}

function toDateInputValue(date: Date | null | undefined): string {
  const base = date ?? new Date();
  return base.toISOString().slice(0, 10);
}

function defaultRowState(plannedReadyDate: Date | null | undefined): RowState {
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

function MarkPaidRow({ payment, onPaid }: { payment: Payment; onPaid: (updated: Payment) => void }) {
  const markPaid = trpc.payments.markPaid.useMutation({ onSuccess: onPaid });
  const [form, setForm] = useState<MarkPaidFormState>(() => defaultMarkPaidForm(payment.expectedAmount));
  const noteRequired = form.reasonCategory === "other";
  const canSave = form.amount.trim().length > 0 && form.fxRate.trim().length > 0
    && (!noteRequired || form.reasonNote.trim().length > 0);

  if (payment.paid) {
    return (
      <li>
        Payment #{payment.sequenceNo}: paid {payment.paidAmount} {payment.currency} on {payment.paidDate?.toString()}
      </li>
    );
  }

  return (
    <li>
      Payment #{payment.sequenceNo}: expected {payment.expectedAmount} {payment.currency} on {payment.expectedDate.toString()}
      {" — "}
      <input
        placeholder="amount"
        value={form.amount}
        onChange={(e) => setForm((prev) => ({ ...prev, amount: e.target.value }))}
      />
      <input
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
    </li>
  );
}

function PoPaymentsSection({ poId }: { poId: number }) {
  const utils = trpc.useUtils();
  const [payments, setPayments] = useState<Payment[]>([]);
  const [form, setForm] = useState<NewPaymentFormState>(() => defaultNewPaymentForm());
  const createPayment = trpc.payments.createExpectedPayment.useMutation({
    onSuccess: (payment) => {
      setPayments((prev) => [...prev, payment]);
      setForm((prev) => ({ ...defaultNewPaymentForm(), sequenceNo: String(Number(prev.sequenceNo) + 1) }));
      utils.dashboards.money.invalidate();
    },
  });
  const canCreate = form.expectedAmount.trim().length > 0 && form.currency.trim().length > 0;

  const refreshAfterPaid = (updated: Payment) => {
    setPayments((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
    utils.dashboards.money.invalidate();
  };

  return (
    <div>
      <strong>Payments</strong>
      {payments.length > 0 && (
        <ul>
          {payments.map((payment) => (
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
          placeholder="sequence no"
          value={form.sequenceNo}
          onChange={(e) => setForm((prev) => ({ ...prev, sequenceNo: e.target.value }))}
        />
        <input
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

export function PurchaseOrdersPage() {
  const { data: pos, isLoading, error, refetch } = trpc.purchaseOrders.list.useQuery();
  const updateDate = trpc.purchaseOrders.updatePlannedReadyDate.useMutation({ onSuccess: () => refetch() });
  const [rowState, setRowState] = useState<Record<number, RowState>>({});

  if (error) return <div>Failed to load: {error.message}</div>;
  if (isLoading || !pos) return <div>Loading…</div>;

  const setRow = (id: number, plannedReadyDate: Date | null | undefined, patch: Partial<RowState>) =>
    setRowState((prev) => ({ ...prev, [id]: { ...(prev[id] ?? defaultRowState(plannedReadyDate)), ...patch } }));

  return (
    <div>
      <h1>Purchase Orders</h1>
      <table>
        <thead><tr><th>PO</th><th>Status</th><th>Planned Ready</th><th>Change date</th><th>Payments</th></tr></thead>
        <tbody>
          {pos.map((po) => {
            const row = rowState[po.id] ?? defaultRowState(po.plannedReadyDate);
            const noteRequired = row.reasonCategory === "other";
            const canSave = !noteRequired || row.reasonNote.trim().length > 0;
            return (
              <tr key={po.id}>
                <td>{po.poNumber}</td>
                <td>{po.status}</td>
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
              </tr>
            );
          })}
        </tbody>
      </table>
      {updateDate.error && <div>Failed to save: {updateDate.error.message}</div>}
    </div>
  );
}
