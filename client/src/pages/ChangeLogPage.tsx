import { trpc } from "../lib/trpc";

export function ChangeLogPage({ entityType, entityId }: { entityType: "purchase_order" | "shipment"; entityId: number }) {
  const poHistory = trpc.purchaseOrders.history.useQuery(entityId, { enabled: entityType === "purchase_order" });
  const shipmentHistory = trpc.shipments.history.useQuery(entityId, { enabled: entityType === "shipment" });

  const error = entityType === "purchase_order" ? poHistory.error : shipmentHistory.error;
  if (error) return <div>Failed to load: {error.message}</div>;

  const isLoading = entityType === "purchase_order" ? poHistory.isLoading : shipmentHistory.isLoading;
  const entries = entityType === "purchase_order" ? poHistory.data : shipmentHistory.data;
  if (isLoading || !entries) return <div>Loading…</div>;

  return (
    <div>
      <h1>Change Log</h1>
      <table>
        <thead><tr><th>Field</th><th>Old</th><th>New</th><th>Reason</th><th>When</th></tr></thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id}>
              <td>{e.field}</td><td>{e.oldValue}</td><td>{e.newValue}</td>
              <td>{e.reasonCategory ?? "—"}{e.reasonNote ? `: ${e.reasonNote}` : ""}</td>
              <td>{e.changedAt.toString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
