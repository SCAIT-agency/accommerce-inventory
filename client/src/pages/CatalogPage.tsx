import { useState } from "react";
import { trpc } from "../lib/trpc";
import { SKU_IDENTIFIER_TYPES } from "../../../shared/constants";
import { VENDOR_TYPES } from "../../../drizzle/schema";
import { BulkPasteImport } from "../components/BulkPasteImport";
import type { BulkPasteColumn } from "../lib/bulkPaste";

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
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive">("all");
  const [bundleOnly, setBundleOnly] = useState(false);
  const bulkCreateSkusMutation = trpc.catalog.bulkCreateSkus.useMutation();
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

  const filtered = (skusQuery.data ?? []).filter((s) => {
    if (statusFilter !== "all" && s.status !== statusFilter) return false;
    if (bundleOnly && !s.isBundle) return false;
    if (search.trim()) {
      const needle = search.trim().toLowerCase();
      const haystack = `${s.sku ?? ""} ${s.name ?? ""}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });

  return (
    <div>
      <h2>SKUs</h2>
      <div>
        <input placeholder="search SKU/name" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}>
          <option value="all">All statuses</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
        <label>
          <input type="checkbox" checked={bundleOnly} onChange={(e) => setBundleOnly(e.target.checked)} /> Bundle only
        </label>
      </div>
      <table>
        <thead><tr><th>SKU</th><th>Name</th><th>Identifier</th><th>Bundle</th><th>Status</th><th>Lead Time (days)</th><th>Safety Stock (days)</th></tr></thead>
        <tbody>
          {filtered.map((s) => <SkuRow key={s.id} sku={s} onUpdated={() => utils.catalog.listSkus.invalidate()} />)}
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
      <BulkPasteImport<{ sku: string; name: string; primaryIdentifierType: "sku" }>
        columns={[
          { key: "sku", label: "SKU", parse: (raw) => (raw.trim() ? { ok: true, value: raw.trim() } : { ok: false, error: "required" }) },
          { key: "name", label: "Name", parse: (raw) => ({ ok: true, value: raw.trim() }) },
        ] as BulkPasteColumn<{ sku: string; name: string; primaryIdentifierType: "sku" }>[]}
        onSubmit={(rows) =>
          bulkCreateSkusMutation.mutateAsync(rows.map((r) => ({ sku: r.sku, name: r.name || undefined, primaryIdentifierType: "sku" as const })))
        }
        onImported={() => utils.catalog.listSkus.invalidate()}
      />
    </div>
  );
}

function SkuRow({ sku, onUpdated }: {
  sku: {
    id: number; sku: string | null; name: string | null; primaryIdentifierType: (typeof SKU_IDENTIFIER_TYPES)[number];
    status: "active" | "inactive"; isBundle: boolean; leadTimeDays: number; safetyStockDays: number;
    identifierValue: string;
  };
  onUpdated: () => void;
}) {
  const [leadTimeDays, setLeadTimeDays] = useState(String(sku.leadTimeDays));
  const [safetyStockDays, setSafetyStockDays] = useState(String(sku.safetyStockDays));
  const updateSku = trpc.catalog.updateSku.useMutation({ onSuccess: onUpdated });

  const identifierValue = sku.identifierValue ?? "—";

  return (
    <>
      <tr>
        <td>{sku.sku ?? "—"}</td>
        <td>{sku.name ?? "—"}</td>
        <td>{identifierValue} <span style={{ color: "var(--neutral-status)" }}>({sku.primaryIdentifierType})</span></td>
        <td>{sku.isBundle && <span className="badge badge-info">Bundle</span>}</td>
        <td>
          <span className={sku.status === "active" ? "badge badge-ok" : "badge badge-neutral"}>{sku.status}</span>{" "}
          <button
            disabled={updateSku.isPending}
            onClick={() => updateSku.mutate({ id: sku.id, status: sku.status === "active" ? "inactive" : "active" })}
          >
            {sku.status === "active" ? "Deactivate" : "Activate"}
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
          <td colSpan={7}>Failed: {updateSku.error.message}</td>
        </tr>
      )}
    </>
  );
}

function VendorsSection() {
  const utils = trpc.useUtils();
  const vendorsQuery = trpc.catalog.listVendors.useQuery();
  const [name, setName] = useState("");
  const bulkCreateVendorsMutation = trpc.catalog.bulkCreateVendors.useMutation();
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
        <thead><tr><th>Name</th><th>Type</th><th>Products</th><th>Contact Email</th><th>Notes</th><th>Active</th><th>Actions</th></tr></thead>
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
      <BulkPasteImport<{ name: string; type: (typeof VENDOR_TYPES)[number] }>
        columns={[
          { key: "name", label: "Name", parse: (raw) => (raw.trim() ? { ok: true, value: raw.trim() } : { ok: false, error: "required" }) },
          { key: "type", label: "Type", parse: (raw) =>
            VENDOR_TYPES.includes(raw.trim() as (typeof VENDOR_TYPES)[number])
              ? { ok: true, value: raw.trim() as (typeof VENDOR_TYPES)[number] }
              : { ok: false, error: `must be one of: ${VENDOR_TYPES.join(", ")}` } },
        ]}
        onSubmit={(rows) => bulkCreateVendorsMutation.mutateAsync(rows)}
        onImported={() => utils.catalog.listVendors.invalidate()}
      />
    </div>
  );
}

function VendorRow({ vendor, onUpdated }: {
  vendor: { id: number; name: string; contactEmail: string | null; notes: string | null; type: (typeof VENDOR_TYPES)[number]; products: string[]; active: boolean };
  onUpdated: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(vendor.name);
  const [contactEmail, setContactEmail] = useState(vendor.contactEmail ?? "");
  const [notes, setNotes] = useState(vendor.notes ?? "");
  const [type, setType] = useState(vendor.type);
  const [productsText, setProductsText] = useState(vendor.products.join(", "));
  const updateVendor = trpc.catalog.updateVendor.useMutation({ onSuccess: () => { setEditing(false); onUpdated(); } });
  const toggleActive = trpc.catalog.updateVendor.useMutation({ onSuccess: onUpdated });

  if (!editing) {
    return (
      <tr>
        <td>{vendor.name}</td>
        <td>{vendor.type}</td>
        <td>{vendor.products.join(", ") || "—"}</td>
        <td>{vendor.contactEmail ?? "—"}</td>
        <td>{vendor.notes ?? "—"}</td>
        <td>
          <span className={vendor.active ? "badge badge-ok" : "badge badge-neutral"}>{vendor.active ? "active" : "inactive"}</span>{" "}
          <button disabled={toggleActive.isPending} onClick={() => toggleActive.mutate({ id: vendor.id, active: !vendor.active })}>
            {vendor.active ? "Deactivate" : "Activate"}
          </button>
        </td>
        <td><button onClick={() => setEditing(true)}>Edit</button></td>
      </tr>
    );
  }
  return (
    <tr>
      <td><input value={name} onChange={(e) => setName(e.target.value)} /></td>
      <td>
        <select value={type} onChange={(e) => setType(e.target.value as (typeof VENDOR_TYPES)[number])}>
          {VENDOR_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </td>
      <td><input value={productsText} onChange={(e) => setProductsText(e.target.value)} placeholder="comma-separated" /></td>
      <td><input value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} /></td>
      <td><input value={notes} onChange={(e) => setNotes(e.target.value)} /></td>
      <td>{vendor.active ? "active" : "inactive"}</td>
      <td>
        <button
          disabled={updateVendor.isPending || !name}
          onClick={() =>
            updateVendor.mutate({
              id: vendor.id,
              name,
              contactEmail: contactEmail || undefined,
              notes: notes || undefined,
              type,
              products: productsText.split(",").map((p) => p.trim()).filter((p) => p.length > 0),
            })
          }
        >
          Save
        </button>
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
        <thead><tr><th>Code</th><th>Name</th><th>Active</th><th>Actions</th></tr></thead>
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

function WarehouseRow({ warehouse, onUpdated }: { warehouse: { id: number; code: string; name: string; active: boolean }; onUpdated: () => void }) {
  const [editing, setEditing] = useState(false);
  const [code, setCode] = useState(warehouse.code);
  const [name, setName] = useState(warehouse.name);
  const updateWarehouse = trpc.catalog.updateWarehouse.useMutation({ onSuccess: () => { setEditing(false); onUpdated(); } });
  const toggleActive = trpc.catalog.updateWarehouse.useMutation({ onSuccess: onUpdated });

  if (!editing) {
    return (
      <tr>
        <td>{warehouse.code}</td>
        <td>{warehouse.name}</td>
        <td>
          <span className={warehouse.active ? "badge badge-ok" : "badge badge-neutral"}>{warehouse.active ? "active" : "inactive"}</span>{" "}
          <button disabled={toggleActive.isPending} onClick={() => toggleActive.mutate({ id: warehouse.id, active: !warehouse.active })}>
            {warehouse.active ? "Deactivate" : "Activate"}
          </button>
        </td>
        <td><button onClick={() => setEditing(true)}>Edit</button></td>
      </tr>
    );
  }
  return (
    <tr>
      <td><input value={code} onChange={(e) => setCode(e.target.value)} /></td>
      <td><input value={name} onChange={(e) => setName(e.target.value)} /></td>
      <td>{warehouse.active ? "active" : "inactive"}</td>
      <td>
        <button disabled={updateWarehouse.isPending || !code || !name} onClick={() => updateWarehouse.mutate({ id: warehouse.id, code, name })}>Save</button>
        <button onClick={() => setEditing(false)}>Cancel</button>
        {updateWarehouse.error && <div>Failed: {updateWarehouse.error.message}</div>}
      </td>
    </tr>
  );
}

export function CatalogPage() {
  const [tab, setTab] = useState<"skus" | "vendors" | "warehouses">("skus");
  return (
    <div>
      <h1>Catalog</h1>
      <div>
        <button onClick={() => setTab("skus")}>SKUs</button>
        <button onClick={() => setTab("vendors")}>Vendors</button>
        <button onClick={() => setTab("warehouses")}>Warehouses</button>
      </div>
      {tab === "skus" && <SkusSection />}
      {tab === "vendors" && <VendorsSection />}
      {tab === "warehouses" && <WarehousesSection />}
    </div>
  );
}
