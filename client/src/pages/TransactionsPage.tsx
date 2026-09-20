import { useState } from "react";
import { trpc } from "../lib/trpc";

function MatchTransactionRow({ transaction, unpaidPayments, onMatched }: { transaction: { id: number; amount: string; currency: string; date: Date; counterparty?: string | null }; unpaidPayments: Array<{ id: number; sequenceNo: number; expectedAmount: string; currency: string; poNumber: string | null }>; onMatched: () => void }) {
  const [selectedPaymentId, setSelectedPaymentId] = useState<string>("");
  const matchTransaction = trpc.payments.matchTransaction.useMutation({ onSuccess: onMatched });

  return (
    <>
      <select value={selectedPaymentId} onChange={(e) => setSelectedPaymentId(e.target.value)}>
        <option value="">Match to payment…</option>
        {unpaidPayments.map((p) => (
          <option key={p.id} value={p.id}>{p.poNumber ?? "no PO"} — #{p.sequenceNo} — {p.expectedAmount} {p.currency}</option>
        ))}
      </select>
      <button
        disabled={!selectedPaymentId || matchTransaction.isPending}
        onClick={() => matchTransaction.mutate({ transactionId: transaction.id, paymentId: Number(selectedPaymentId) })}
      >
        Match
      </button>
      {matchTransaction.error && <div>Failed to match: {matchTransaction.error.message}</div>}
    </>
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
      <table>
        <thead><tr><th>Date</th><th>Amount</th><th>Counterparty</th><th>Status</th></tr></thead>
        <tbody>
          {transactionsQuery.data.map((tx) => (
            <tr key={tx.id}>
              <td>{new Date(tx.date).toISOString().slice(0, 10)}</td>
              <td>{tx.amount} {tx.currency}</td>
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
