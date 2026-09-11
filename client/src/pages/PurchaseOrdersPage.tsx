import { useState } from "react";
import { trpc } from "../lib/trpc";

const REASON_CATEGORIES = [
  "production_delay", "artwork_delay", "customs_hold", "logistics_delay",
  "payment_timing", "vendor_price_change", "freight_rate_change", "holiday_capacity", "other",
] as const;

type ReasonCategory = (typeof REASON_CATEGORIES)[number];

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
        <thead><tr><th>PO</th><th>Status</th><th>Planned Ready</th><th>Change date</th></tr></thead>
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
              </tr>
            );
          })}
        </tbody>
      </table>
      {updateDate.error && <div>Failed to save: {updateDate.error.message}</div>}
    </div>
  );
}
