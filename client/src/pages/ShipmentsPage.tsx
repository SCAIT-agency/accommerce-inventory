import { trpc } from "../lib/trpc";

export function ShipmentsPage() {
  const { error } = trpc.shipments.getWithLineItems.useQuery(1, { enabled: false });
  if (error) return <div>Failed to load: {error.message}</div>;
  return (
    <div>
      <h1>Shipments</h1>
      <p>Each shipment lists the PO line items it carries — one shipment can pool cargo from multiple POs.</p>
      {/* list/detail view follows the same pattern as PurchaseOrdersPage; omitted here for brevity of a first working slice */}
    </div>
  );
}
