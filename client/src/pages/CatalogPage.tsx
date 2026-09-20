import { useState } from "react";
import { trpc } from "../lib/trpc";

function SkusSection() {
  const utils = trpc.useUtils();
  const skusQuery = trpc.catalog.listSkus.useQuery();
  const [sku, setSku] = useState("");
  const [name, setName] = useState("");
  const [primaryIdentifierType, setPrimaryIdentifierType] = useState("sku");
  const createSku = trpc.catalog.createSku.useMutation({
    onSuccess: () => {
      setSku("");
      setName("");
      utils.catalog.listSkus.invalidate();
    },
  });

  if (skusQuery.error) return <div>Failed to load SKUs: {skusQuery.error.message}</div>;

  return (
    <div>
      <h2>SKUs</h2>
      <table>
        <thead><tr><th>SKU</th><th>Name</th><th>Identifier Type</th></tr></thead>
        <tbody>
          {(skusQuery.data ?? []).map((s) => (
            <tr key={s.id}><td>{s.sku ?? "—"}</td><td>{s.name ?? "—"}</td><td>{s.primaryIdentifierType}</td></tr>
          ))}
        </tbody>
      </table>
      <div>
        <input placeholder="SKU code" value={sku} onChange={(e) => setSku(e.target.value)} />
        <input placeholder="name" value={name} onChange={(e) => setName(e.target.value)} />
        <select value={primaryIdentifierType} onChange={(e) => setPrimaryIdentifierType(e.target.value)}>
          <option value="sku">sku</option>
          <option value="barcode">barcode</option>
        </select>
        <button
          disabled={createSku.isPending || (!sku && !name)}
          onClick={() => createSku.mutate({ sku: sku || undefined, name: name || undefined, primaryIdentifierType })}
        >
          Add SKU
        </button>
        {createSku.error && <div>Failed to save: {createSku.error.message}</div>}
      </div>
    </div>
  );
}

function VendorsSection() {
  const utils = trpc.useUtils();
  const vendorsQuery = trpc.catalog.listVendors.useQuery();
  const [name, setName] = useState("");
  const createVendor = trpc.catalog.createVendor.useMutation({
    onSuccess: () => {
      setName("");
      utils.catalog.listVendors.invalidate();
    },
  });

  if (vendorsQuery.error) return <div>Failed to load vendors: {vendorsQuery.error.message}</div>;

  return (
    <div>
      <h2>Vendors</h2>
      <table>
        <thead><tr><th>Name</th></tr></thead>
        <tbody>
          {(vendorsQuery.data ?? []).map((v) => (<tr key={v.id}><td>{v.name}</td></tr>))}
        </tbody>
      </table>
      <div>
        <input placeholder="vendor name" value={name} onChange={(e) => setName(e.target.value)} />
        <button disabled={createVendor.isPending || !name} onClick={() => createVendor.mutate({ name })}>
          Add Vendor
        </button>
        {createVendor.error && <div>Failed to save: {createVendor.error.message}</div>}
      </div>
    </div>
  );
}

function WarehousesSection() {
  const utils = trpc.useUtils();
  const warehousesQuery = trpc.catalog.listWarehouses.useQuery();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const createWarehouse = trpc.catalog.createWarehouse.useMutation({
    onSuccess: () => {
      setCode("");
      setName("");
      utils.catalog.listWarehouses.invalidate();
    },
  });

  if (warehousesQuery.error) return <div>Failed to load warehouses: {warehousesQuery.error.message}</div>;

  return (
    <div>
      <h2>Warehouses</h2>
      <table>
        <thead><tr><th>Code</th><th>Name</th></tr></thead>
        <tbody>
          {(warehousesQuery.data ?? []).map((w) => (<tr key={w.id}><td>{w.code}</td><td>{w.name}</td></tr>))}
        </tbody>
      </table>
      <div>
        <input placeholder="code (e.g. FF-DE)" value={code} onChange={(e) => setCode(e.target.value)} />
        <input placeholder="name" value={name} onChange={(e) => setName(e.target.value)} />
        <button disabled={createWarehouse.isPending || !code || !name} onClick={() => createWarehouse.mutate({ code, name })}>
          Add Warehouse
        </button>
        {createWarehouse.error && <div>Failed to save: {createWarehouse.error.message}</div>}
      </div>
    </div>
  );
}

export function CatalogPage() {
  return (
    <div>
      <h1>Catalog</h1>
      <SkusSection />
      <VendorsSection />
      <WarehousesSection />
    </div>
  );
}
