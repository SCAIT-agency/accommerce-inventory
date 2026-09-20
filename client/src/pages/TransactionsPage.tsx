import { useState } from "react";
import { trpc } from "../lib/trpc";
import { formatMoney } from "../lib/labels";

const REASON_CATEGORIES = [
  "production_delay",
  "artwork_delay",
  "customs_hold",
  "logistics_delay",
  "payment_timing",
  "vendor_price_change",
  "freight_rate_change",
  "holiday_capacity",
  "other",
] as const;
type ReasonCategory = (typeof REASON_CATEGORIES)[number];

function MatchTransactionRow({ transaction, unpaidPayments, onMatched }: { transaction: { id: number; amount: string; currency: string; date: Date; counterparty?: string | null }; unpaidPayments: Array<{ id: number; sequenceNo: number; expectedAmount: string; currency: string; poNumber: string | null }>; onMatched: () => void }) {
  const [selectedPaymentId, setSelectedPaymentId] = useState<string>("");
  const [reasonCategory, setReasonCategory] = useState<ReasonCategory>("payment_timing");
  const [reasonNote, setReasonNote] = useState("");
  const matchTransaction = trpc.payments.matchTransaction.useMutation({
    onSuccess: () => {
      setSelectedPaymentId("");
      setReasonNote("");
      onMatched();
    },
  });
  const noteRequired = reasonCategory === "other";

  return (
    <>
      <select value={selectedPaymentId} onChange={(e) => setSelectedPaymentId(e.target.value)}>
        <option value="">Match to payment…</option>
        {unpaidPayments.map((p) => (
          <option key={p.id} value={p.id}>{p.poNumber ?? "no PO"} — #{p.sequenceNo} — {formatMoney(p.expectedAmount, p.currency)}</option>
        ))}
      </select>
      <select value={reasonCategory} onChange={(e) => setReasonCategory(e.target.value as ReasonCategory)}>
        {REASON_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
      {noteRequired && (
        <input placeholder="reason note (required)" value={reasonNote} onChange={(e) => setReasonNote(e.target.value)} />
      )}
      <button
        disabled={!selectedPaymentId || (noteRequired && !reasonNote.trim()) || matchTransaction.isPending}
        onClick={() =>
          matchTransaction.mutate({
            transactionId: transaction.id,
            paymentId: Number(selectedPaymentId),
            reasonCategory,
            reasonNote: reasonNote.trim() || undefined,
          })
        }
      >
        Match
      </button>
      {matchTransaction.error && <div>Failed to match: {matchTransaction.error.message}</div>}
    </>
  );
}

interface NewTransactionFormState {
  date: string;
  amount: string;
  currency: string;
  fxRate: string;
  counterparty: string;
  description: string;
}

function defaultNewTransactionForm(): NewTransactionFormState {
  return { date: new Date().toISOString().slice(0, 10), amount: "", currency: "USD", fxRate: "1", counterparty: "", description: "" };
}

function RecordTransactionForm({ onRecorded }: { onRecorded: () => void }) {
  const [form, setForm] = useState<NewTransactionFormState>(defaultNewTransactionForm);
  const recordTransaction = trpc.payments.recordTransaction.useMutation({
    onSuccess: () => {
      setForm(defaultNewTransactionForm());
      onRecorded();
    },
  });
  const canSave = form.amount.trim().length > 0 && form.currency.trim().length > 0 && form.fxRate.trim().length > 0;

  return (
    <div>
      <h2>Record a bank transaction</h2>
      <input type="date" value={form.date} onChange={(e) => setForm((prev) => ({ ...prev, date: e.target.value }))} />
      <input
        type="text"
        placeholder="amount"
        value={form.amount}
        onChange={(e) => setForm((prev) => ({ ...prev, amount: e.target.value }))}
      />
      <input
        type="text"
        placeholder="currency"
        value={form.currency}
        onChange={(e) => setForm((prev) => ({ ...prev, currency: e.target.value }))}
      />
      <input
        type="text"
        placeholder="fx rate to EUR"
        value={form.fxRate}
        onChange={(e) => setForm((prev) => ({ ...prev, fxRate: e.target.value }))}
      />
      <input
        type="text"
        placeholder="counterparty"
        value={form.counterparty}
        onChange={(e) => setForm((prev) => ({ ...prev, counterparty: e.target.value }))}
      />
      <input
        type="text"
        placeholder="description"
        value={form.description}
        onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
      />
      <button
        disabled={!canSave || recordTransaction.isPending}
        onClick={() =>
          recordTransaction.mutate({
            date: new Date(form.date),
            amount: form.amount,
            currency: form.currency,
            fxRate: form.fxRate,
            counterparty: form.counterparty.trim() || undefined,
            description: form.description.trim() || undefined,
          })
        }
      >
        Record transaction
      </button>
      {recordTransaction.error && <div>Failed to record: {recordTransaction.error.message}</div>}
    </div>
  );
}

export function TransactionsPage() {
  const utils = trpc.useUtils();
  const transactionsQuery = trpc.payments.listTransactions.useQuery();
  const unpaidQuery = trpc.payments.listUnpaid.useQuery();

  const error = transactionsQuery.error ?? unpaidQuery.error;
  if (error) return <div>Failed to load: {error.message}</div>;

  const isLoading = transactionsQuery.isLoading || unpaidQuery.isLoading;
  if (isLoading || !transactionsQuery.data) return <div>Loading…</div>;

  const onMatched = () => {
    utils.payments.listTransactions.invalidate();
    utils.payments.listUnpaid.invalidate();
    utils.dashboards.money.invalidate();
  };

  return (
    <div>
      <h1>Transactions</h1>
      <RecordTransactionForm onRecorded={onMatched} />
      <table>
        <thead><tr><th>Date</th><th>Amount</th><th>Counterparty</th><th>Status</th></tr></thead>
        <tbody>
          {transactionsQuery.data.map((tx) => (
            <tr key={tx.id}>
              <td>{new Date(tx.date).toISOString().slice(0, 10)}</td>
              <td>{formatMoney(tx.amount, tx.currency)}</td>
              <td>{tx.counterparty ?? "—"}</td>
              <td>
                {tx.matchedPaymentId != null ? (
                  "Matched"
                ) : (
                  <MatchTransactionRow transaction={tx} unpaidPayments={unpaidQuery.data ?? []} onMatched={onMatched} />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
