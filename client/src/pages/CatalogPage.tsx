import { useState } from "react";
import { trpc } from "../lib/trpc";
import { SKU_IDENTIFIER_TYPES } from "../../../shared/constants";

// The 4 non-sku/non-name identifier types have no dedicated field on this
// form — sku/name double as free reference fields for those, and this one
// input carries the actual primary identifier value.
const OTHER_IDENTIFIER_TYPES = new Set<(typeof SKU_IDENTIFIER_TYPES)[number]>(["ssku", "asin", "ean", "fnsku"]);

function SkusSection() {
  const utils = trpc.useUtils();
  const skusQuery = trpc.catalog.listSkus.useQuery();
  const [sku, setSku] = useState("");
  const [name, setName] = useState("");
  const [otherIdentifierValue, setOtherIdentifierValue] = useState("");
  const [primaryIdentifierType, setPrimaryIdentifierType] = useState<(typeof SKU_IDENTIFIER_TYPES)[number]>("sku");
  const createSku = trpc.catalog.createSku.useMutation({
    onSuccess: () => {
      setSku("");
      setName("");
      setOtherIdentifierValue("");
      utils.catalog.listSkus.invalidate();
    },
  });

  if (skusQuery.error) return <div>Failed to load SKUs: {skusQuery.error.message}</div>;

  const needsOtherIdentifier = OTHER_IDENTIFIER_TYPES.has(primaryIdentifierType);
  // Must require the field matching the SELECTED type, not just "either
  // field" — picking "sku" but only filling Name (or vice versa) would
  // otherwise submit with the primary identifier's own column empty, which
  // fails the same NOT NULL constraint this form exists to satisfy.
  const canCreate = needsOtherIdentifier
    ? otherIdentifierValue.trim().length > 0
    : primaryIdentifierType === "sku"
      ? sku.trim().length > 0
      : name.trim().length > 0;

  return (
    <div>
      <h2>SKUs</h2>
      <table>
        <thead><tr><th>SKU</th><th>Name</th><th>Identifier Type</th><th>Status</th><th>Lead Time (days)</th><th>Safety Stock (days)</th></tr></thead>
        <tbody>
          {(skusQuery.data ?? []).map((s) => <SkuRow key={s.id} sku={s} onUpdated={() => utils.catalog.listSkus.invalidate()} />)}
        </tbody>
      </table>
      <div>
        <input placeholder="SKU code" value={sku} onChange={(e) => setSku(e.target.value)} />
        <input placeholder="name" value={name} onChange={(e) => setName(e.target.value)} />
        <select value={primaryIdentifierType} onChange={(e) => setPrimaryIdentifierType(e.target.value as (typeof SKU_IDENTIFIER_TYPES)[number])}>
          {SKU_IDENTIFIER_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        {needsOtherIdentifier && (
          <input
            placeholder={`${primaryIdentifierType} value`}
            value={otherIdentifierValue}
            onChange={(e) => setOtherIdentifierValue(e.target.value)}
          />
        )}
        <button
          disabled={createSku.isPending || !canCreate}
          onClick={() =>
            createSku.mutate({
              sku: sku || undefined,
              name: name || undefined,
              ssku: primaryIdentifierType === "ssku" ? otherIdentifierValue : undefined,
              asin: primaryIdentifierType === "asin" ? otherIdentifierValue : undefined,
              ean: primaryIdentifierType === "ean" ? otherIdentifierValue : undefined,
              fnsku: primaryIdentifierType === "fnsku" ? otherIdentifierValue : undefined,
              primaryIdentifierType,
            })
          }
        >
          Add SKU
        </button>
        {createSku.error && <div>Failed to save: {createSku.error.message}</div>}
      </div>
    </div>
  );
}

function SkuRow({ sku, onUpdated }: { sku: { id: number; sku: string | null; name: string | null; primaryIdentifierType: string; status: "active" | "inactive"; leadTimeDays: number; safetyStockDays: number }; onUpdated: () => void }) {
  const [leadTimeDays, setLeadTimeDays] = useState(String(sku.leadTimeDays));
  const [safetyStockDays, setSafetyStockDays] = useState(String(sku.safetyStockDays));
  const updateSku = trpc.catalog.updateSku.useMutation({ onSuccess: onUpdated });

  return (
    <>
      <tr>
        <td>{sku.sku ?? "—"}</td>
        <td>{sku.name ?? "—"}</td>
        <td>{sku.primaryIdentifierType}</td>
        <td>
          <button
            disabled={updateSku.isPending}
            onClick={() => updateSku.mutate({ id: sku.id, status: sku.status === "active" ? "inactive" : "active" })}
          >
            {sku.status}
          </button>
        </td>
        <td>
          <input type="number" value={leadTimeDays} onChange={(e) => setLeadTimeDays(e.target.value)} style={{ width: "4em" }} />
          <button disabled={updateSku.isPending || leadTimeDays.trim() === ""} onClick={() => updateSku.mutate({ id: sku.id, leadTimeDays: Number(leadTimeDays) })}>Save</button>
        </td>
        <td>
          <input type="number" value={safetyStockDays} onChange={(e) => setSafetyStockDays(e.target.value)} style={{ width: "4em" }} />
          <button disabled={updateSku.isPending || safetyStockDays.trim() === ""} onClick={() => updateSku.mutate({ id: sku.id, safetyStockDays: Number(safetyStockDays) })}>Save</button>
        </td>
      </tr>
      {updateSku.error && (
        <tr>
          <td colSpan={6}>Failed: {updateSku.error.message}</td>
        </tr>
      )}
    </>
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
        <thead><tr><th>Name</th><th>Contact Email</th><th>Actions</th></tr></thead>
        <tbody>
          {(vendorsQuery.data ?? []).map((v) => <VendorRow key={v.id} vendor={v} onUpdated={() => utils.catalog.listVendors.invalidate()} />)}
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

function VendorRow({ vendor, onUpdated }: { vendor: { id: number; name: string; contactEmail: string | null }; onUpdated: () => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(vendor.name);
  const [contactEmail, setContactEmail] = useState(vendor.contactEmail ?? "");
  const updateVendor = trpc.catalog.updateVendor.useMutation({ onSuccess: () => { setEditing(false); onUpdated(); } });

  if (!editing) {
    return (
      <tr>
        <td>{vendor.name}</td>
        <td>{vendor.contactEmail ?? "—"}</td>
        <td><button onClick={() => setEditing(true)}>Edit</button></td>
      </tr>
    );
  }
  return (
    <tr>
      <td><input value={name} onChange={(e) => setName(e.target.value)} /></td>
      <td><input value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} /></td>
      <td>
        <button disabled={updateVendor.isPending || !name} onClick={() => updateVendor.mutate({ id: vendor.id, name, contactEmail: contactEmail || undefined })}>Save</button>
        <button onClick={() => setEditing(false)}>Cancel</button>
        {updateVendor.error && <div>Failed: {updateVendor.error.message}</div>}
      </td>
    </tr>
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
        <thead><tr><th>Code</th><th>Name</th><th>Actions</th></tr></thead>
        <tbody>
          {(warehousesQuery.data ?? []).map((w) => <WarehouseRow key={w.id} warehouse={w} onUpdated={() => utils.catalog.listWarehouses.invalidate()} />)}
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

function WarehouseRow({ warehouse, onUpdated }: { warehouse: { id: number; code: string; name: string }; onUpdated: () => void }) {
  const [editing, setEditing] = useState(false);
  const [code, setCode] = useState(warehouse.code);
  const [name, setName] = useState(warehouse.name);
  const updateWarehouse = trpc.catalog.updateWarehouse.useMutation({ onSuccess: () => { setEditing(false); onUpdated(); } });

  if (!editing) {
    return (
      <tr>
        <td>{warehouse.code}</td>
        <td>{warehouse.name}</td>
        <td><button onClick={() => setEditing(true)}>Edit</button></td>
      </tr>
    );
  }
  return (
    <tr>
      <td><input value={code} onChange={(e) => setCode(e.target.value)} /></td>
      <td><input value={name} onChange={(e) => setName(e.target.value)} /></td>
      <td>
        <button disabled={updateWarehouse.isPending || !code || !name} onClick={() => updateWarehouse.mutate({ id: warehouse.id, code, name })}>Save</button>
        <button onClick={() => setEditing(false)}>Cancel</button>
        {updateWarehouse.error && <div>Failed: {updateWarehouse.error.message}</div>}
      </td>
    </tr>
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
