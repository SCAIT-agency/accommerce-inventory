import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../server/routers";
import { trpc } from "../lib/trpc";

type RouterOutputs = inferRouterOutputs<AppRouter>;
type ShipmentListItem = RouterOutputs["shipments"]["list"][number];

function ShipmentRow({ shipment }: { shipment: ShipmentListItem }) {
  const { data, error, isLoading } = trpc.shipments.getWithLineItems.useQuery(shipment.id);

  if (error) return <tr><td colSpan={3}>Failed to load {shipment.shipmentRef}: {error.message}</td></tr>;
  if (isLoading || !data) return <tr><td colSpan={3}>Loading {shipment.shipmentRef}…</td></tr>;

  return (
    <tr>
      <td>{shipment.shipmentRef}</td>
      <td>{shipment.status}</td>
      <td>
        <ul>
          {data.lineItems.map((li) => (
            <li key={li.id}>SKU {li.skuId} — qty {li.qty}</li>
          ))}
        </ul>
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
        <thead><tr><th>Ref</th><th>Status</th><th>Line items</th></tr></thead>
        <tbody>
          {shipmentsList.map((shipment) => (
            <ShipmentRow key={shipment.id} shipment={shipment} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
