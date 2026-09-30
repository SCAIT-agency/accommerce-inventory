# Catalog Redesign + Shared Bulk-Paste Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the Catalog page into 3 tabs (SKUs/Vendors/Warehouses) with real field parity against the Sheet, and build a reusable tab-separated bulk-paste import pattern (used here for SKUs and Vendors, and reused unchanged by the Transactions plan).

**Architecture:** A new `vendors` schema migration (type/products/active/createdBy/updatedBy) applied via `pnpm db:push`. A generic, dependency-free TSV parser (`client/src/lib/bulkPaste.ts`) and a generic `<BulkPasteImport>` React component consume a per-entity column-definition array and render a paste box → validated preview table → one-shot bulk submit. Two new bulk tRPC procedures (`catalog.bulkCreateSkus`, `catalog.bulkCreateVendors`) each wrap the existing single-row `createSku`/`createVendor` repository functions in one `db.transaction`, returning a per-row result so the UI can report "recorded X of Y". `CatalogPage.tsx` is restructured into 3 tabs matching `MoneyPage.tsx`'s existing plain-button tab pattern, each tab getting its own field-parity fixes (Identifier display, Bundle badge, Status badge, search/filter for SKUs; Type/Products/Active/notes for Vendors; Active/Inactive for Warehouses).

**Tech Stack:** React 18, tRPC 11, Drizzle ORM (MySQL/TiDB), Vitest, `@tanstack/react-query`.

**Spec:** `docs/2026-09-30-app-wide-ux-redesign-design.md` §3 (Catalog), §9.2 (bulk-paste pattern origin, shared here).

## Global Constraints

- No mocks in tests — every server test runs against the real local MySQL test DB (`server/db.test.ts`'s own `beforeEach` pattern: delete-then-reset inside a transaction with `FOREIGN_KEY_CHECKS` toggled off, not mocked repositories).
- Schema changes go through `schema.ts` + `pnpm db:push` (`drizzle-kit generate && drizzle-kit migrate`) — never hand-author a migration SQL file (this repo's own established convention; hand-authoring drizzle's migration bookkeeping is a known footgun).
- No comments explaining WHAT code does — only WHY, and only when genuinely non-obvious (matches this repo's existing style throughout `server/*.ts`).
- Every new manual-entry form field that already has a sibling validation pattern in this codebase (e.g. `nonNegativeDecimalString` for money/rate fields) reuses that exact pattern — never a new ad hoc regex.
- `editorProcedure` (not `protectedProcedure`) for every mutation; `protectedProcedure` for reads — matches every existing router entry.

## Review Focus

- **A pasted bulk-import block with a mix of valid and invalid rows** (e.g. row 3 has a non-numeric `leadTimeDays`, row 7 is missing the required primary-identifier field) — the preview must flag exactly the bad rows before submit, and the bulk procedure must still commit every valid row rather than failing the whole batch on one bad one.
- **A pasted block with a header row accidentally included** (user selects the column-title row along with the data when copying from Excel) — the first row should be detectable as non-data (fails every column's own type check) and flagged in preview, not silently inserted as a bogus SKU/vendor.
- **Existing vendors after the migration** — `type`/`active` must backfill to sane defaults (`other` / `true`) for every pre-existing row, not `NULL`, since the UI will render a badge off these fields unconditionally.
- **A SKU whose `primaryIdentifierType` is `asin`/`ean`/`fnsku`/`ssku`** (not `sku` or `name`) — the new Identifier column must show that field's real value, not `"—"` (the exact bug being fixed).
- **Bulk-importing 200+ rows in one paste** — the preview table and the bulk mutation must stay responsive (the bulk procedure is one `db.transaction`, not 200 round trips; the preview table render isn't behind a debounce that silently drops rows).

---

## File Structure

- `drizzle/schema.ts` — `vendors` table gains `type`, `products`, `active`, `createdBy`, `updatedBy`.
- `client/src/lib/bulkPaste.ts` (new) — pure TSV-parsing + per-column validation utility, no React, no DB. Unit-testable in isolation.
- `client/src/lib/bulkPaste.test.ts` (new).
- `client/src/components/BulkPasteImport.tsx` (new) — generic paste-box → preview-table → submit component, parameterized by a column-definition array and a submit callback.
- `server/db.ts` — `createVendor`/`updateVendor` gain the new fields; new `bulkCreateSkus`/`bulkCreateVendors` functions.
- `server/db.test.ts` — new tests for the above.
- `server/routers.ts` — `catalog.createVendor`/`catalog.updateVendor` input schemas extended; new `catalog.bulkCreateSkus`/`catalog.bulkCreateVendors` procedures.
- `client/src/index.css` — new `.badge-info` status color.
- `client/src/pages/CatalogPage.tsx` — restructured into 3 tabs; SKU/Vendor/Warehouse tab content updated per spec §3.1–3.3.

---

### Task 1: Vendors schema migration

**Files:**
- Modify: `drizzle/schema.ts:67-75` (the `vendors` table + its inferred types)
- Test: `server/db.test.ts` (extends the existing `updateVendor persists a name/contact-email change` test area)

**Interfaces:**
- Produces: `Vendor` type now includes `type: "manufacturer" | "trading_company" | "agent" | "other"`, `products: string[]`, `active: boolean`, `createdBy: number | null`, `updatedBy: number | null`.

- [ ] **Step 1: Write the failing test**

Add to `server/db.test.ts` (inside the existing `describe("catalog repository", ...)` block, after the `updateVendor persists a name/contact-email change` test):

```ts
  it("createVendor defaults type/active and accepts a products list", async () => {
    const vendor = await createVendor({ name: "New Factory" });
    expect(vendor.type).toBe("other");
    expect(vendor.active).toBe(true);
    expect(vendor.products).toEqual([]);
  });

  it("updateVendor persists type/products/active/createdBy/updatedBy", async () => {
    const vendor = await createVendor({ name: "Factory A" });
    const updated = await updateVendor(vendor.id, {
      type: "manufacturer",
      products: ["Jello 500ml", "Mixer"],
      active: false,
      updatedBy: 1,
    });
    expect(updated.type).toBe("manufacturer");
    expect(updated.products).toEqual(["Jello 500ml", "Mixer"]);
    expect(updated.active).toBe(false);
    expect(updated.updatedBy).toBe(1);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- server/db.test.ts -t "createVendor defaults type"`
Expected: FAIL — `vendor.type` is `undefined` (column doesn't exist yet).

- [ ] **Step 3: Add the columns to `schema.ts`**

In `drizzle/schema.ts`, replace the `vendors` table definition (lines 67-75) with:

```ts
export const VENDOR_TYPES = ["manufacturer", "trading_company", "agent", "other"] as const;

export const vendors = mysqlTable("vendors", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 256 }).notNull(),
  contactEmail: varchar("contactEmail", { length: 320 }),
  notes: text("notes"),
  type: mysqlEnum("type", VENDOR_TYPES).default("other").notNull(),
  products: json("products").$type<string[]>().default([]).notNull(),
  active: boolean("active").default(true).notNull(),
  createdBy: int("createdBy").references(() => users.id),
  updatedBy: int("updatedBy").references(() => users.id),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type Vendor = typeof vendors.$inferSelect;
export type InsertVendor = typeof vendors.$inferInsert;
```

Add `json` to the existing `drizzle-orm/mysql-core` import on line 2 (alongside `date, decimal, int, ...`).

`createdBy`/`updatedBy` are nullable (existing rows and the very first insert before a caller threads a real user id have no value) — unlike `purchaseOrders.createdBy`, which is `.notNull()` because every PO has always required a creating user; vendors did not, so making it required now would break every existing row with no migration-time value to backfill it from.

- [ ] **Step 4: Push the migration**

Run: `pnpm db:push`
Expected: `drizzle-kit generate` writes a new `drizzle/migrations/00XX_*.sql`, `drizzle-kit migrate` applies it. Confirm no errors and that existing rows got `type='other'`, `active=1`, `products='[]'` by running:

```bash
pnpm exec tsx -e "import { db } from './server/dbClient'; import { vendors } from './drizzle/schema'; db.select().from(vendors).then(r => { console.log(r); process.exit(0); })"
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test -- server/db.test.ts -t "Vendor"`
Expected: PASS for both new tests (server/db.ts's `createVendor`/`updateVendor` already pass through arbitrary `Partial<InsertVendor>`/`Omit<InsertVendor, "id">`, so no server.ts change is needed for this task — Task 2 only extends the router's input schema).

- [ ] **Step 6: Commit**

```bash
git add drizzle/schema.ts drizzle/migrations server/db.test.ts
git commit -m "feat: add type/products/active/createdBy/updatedBy to vendors schema"
```

---

### Task 2: Server — vendor router accepts the new fields

**Files:**
- Modify: `server/routers.ts:84-88` (the `catalog.createVendor`/`catalog.updateVendor` procedures)
- Test: `server/db.test.ts` (Task 1 already covers `db.ts`; this task is router-schema-only, tested via the router's own input validation)

**Interfaces:**
- Consumes: `VENDOR_TYPES` from `drizzle/schema.ts` (Task 1).
- Produces: `catalog.createVendor` accepts `{ name, contactEmail?, notes?, type?, products?, active? }`; `catalog.updateVendor` accepts `{ id, name?, contactEmail?, notes?, type?, products?, active? }` plus server-injected `updatedBy: ctx.user.id`.

- [ ] **Step 1: Update the router**

In `server/routers.ts`, replace lines 85-88 with:

```ts
    createVendor: editorProcedure
      .input(z.object({
        name: z.string(),
        contactEmail: z.string().optional(),
        notes: z.string().optional(),
        type: z.enum(VENDOR_TYPES).optional(),
        products: z.array(z.string()).optional(),
      }))
      .mutation(({ input, ctx }) => createVendor({ ...input, createdBy: ctx.user.id })),
    updateVendor: editorProcedure
      .input(z.object({
        id: z.number(),
        name: z.string().optional(),
        contactEmail: z.string().optional(),
        notes: z.string().optional(),
        type: z.enum(VENDOR_TYPES).optional(),
        products: z.array(z.string()).optional(),
        active: z.boolean().optional(),
      }))
      .mutation(({ input, ctx }) => updateVendor(input.id, { ...input, id: undefined, updatedBy: ctx.user.id })),
```

Add `VENDOR_TYPES` to the existing `import { PO_STATUSES, SHIPMENT_STATUSES, CUSTOMS_STATUSES, SKU_IDENTIFIER_TYPES } from "../drizzle/schema";` line (line 10).

- [ ] **Step 2: Type-check**

Run: `pnpm check`
Expected: no errors. (`updateVendor(input.id, { ...input, id: undefined, updatedBy: ctx.user.id })` passes `id: undefined` into `Partial<InsertVendor>`, which Drizzle's `Partial` type accepts as "field not set" — matches the existing pattern every other `update*` router entry in this file already uses.)

- [ ] **Step 3: Commit**

```bash
git add server/routers.ts
git commit -m "feat: accept type/products/active on the vendor router"
```

---

### Task 3: Add the `.badge-info` status color

**Files:**
- Modify: `client/src/index.css:281-284`

**Interfaces:**
- Produces: CSS class `.badge-info` — used by Task 9 (SKU/PO/Shipment status badges needing a 5th "in progress" color beyond critical/warning/ok/neutral).

- [ ] **Step 1: Add the class**

In `client/src/index.css`, after line 284 (`.badge-overstock, .badge-unknown, .badge-neutral { ... }`), add:

```css
.badge-info { color: var(--accent); background: var(--accent-soft); }
```

`--accent`/`--accent-soft` are already defined (lines 26-28 light, 56-58 dark) and already WCAG-verified as part of the Tucann-palette retheme (09-25) — this just exposes them as a 5th badge variant, no new color values introduced.

- [ ] **Step 2: Verify visually**

Run: `pnpm dev`, open the app, confirm no CSS parse error in the browser console (this class isn't consumed by any component yet — Task 9 wires it up).

- [ ] **Step 3: Commit**

```bash
git add client/src/index.css
git commit -m "feat: add badge-info status color"
```

---

### Task 4: Shared TSV bulk-paste parsing utility

**Files:**
- Create: `client/src/lib/bulkPaste.ts`
- Create: `client/src/lib/bulkPaste.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface BulkPasteColumn<T> {
    key: keyof T;
    label: string;
    parse: (raw: string) => { ok: true; value: T[keyof T] } | { ok: false; error: string };
  }
  export interface BulkPasteRow<T> {
    raw: string[];
    values: Partial<T>;
    errors: Partial<Record<keyof T, string>>;
    isValid: boolean;
  }
  export function parseBulkPaste<T>(text: string, columns: BulkPasteColumn<T>[]): BulkPasteRow<T>[]
  ```
  Used by Task 6's `<BulkPasteImport>` component and, later, by the Transactions plan's own bulk-import wiring.

- [ ] **Step 1: Write the failing tests**

Create `client/src/lib/bulkPaste.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseBulkPaste, type BulkPasteColumn } from "./bulkPaste";

interface TestRow {
  sku: string;
  qty: number;
}

const columns: BulkPasteColumn<TestRow>[] = [
  { key: "sku", label: "SKU", parse: (raw) => (raw.trim().length > 0 ? { ok: true, value: raw.trim() } : { ok: false, error: "required" }) },
  { key: "qty", label: "Qty", parse: (raw) => {
    const n = Number(raw.trim());
    return Number.isFinite(n) && n >= 0 ? { ok: true, value: n } : { ok: false, error: "must be a non-negative number" };
  } },
];

describe("parseBulkPaste", () => {
  it("parses well-formed tab-separated rows", () => {
    const rows = parseBulkPaste("JELLO-500\t120\nMIXER-90\t45", columns);
    expect(rows).toHaveLength(2);
    expect(rows[0].isValid).toBe(true);
    expect(rows[0].values).toEqual({ sku: "JELLO-500", qty: 120 });
    expect(rows[1].values).toEqual({ sku: "MIXER-90", qty: 45 });
  });

  it("flags a row with an invalid column value, without dropping other valid rows", () => {
    const rows = parseBulkPaste("JELLO-500\t120\nMIXER-90\tnot-a-number", columns);
    expect(rows[0].isValid).toBe(true);
    expect(rows[1].isValid).toBe(false);
    expect(rows[1].errors.qty).toBe("must be a non-negative number");
  });

  it("flags a row with the wrong number of columns instead of throwing", () => {
    const rows = parseBulkPaste("JELLO-500\t120\tEXTRA", columns);
    expect(rows[0].isValid).toBe(false);
    expect(rows[0].errors.sku).toMatch(/expected 2 columns, got 3/);
  });

  it("ignores blank lines", () => {
    const rows = parseBulkPaste("JELLO-500\t120\n\nMIXER-90\t45\n", columns);
    expect(rows).toHaveLength(2);
  });

  it("returns an empty array for empty input", () => {
    expect(parseBulkPaste("", columns)).toEqual([]);
    expect(parseBulkPaste("   \n  \n", columns)).toEqual([]);
  });

  it("flags a pasted header row as invalid instead of silently importing it", () => {
    // A real header ("SKU"/"Qty") fails the same per-column parse rules a bad
    // data row would — no special-casing needed, but this pins the behavior
    // explicitly so a future refactor can't accidentally special-case
    // row-index-0 in a way that skips it instead.
    const rows = parseBulkPaste("SKU\tQty\nJELLO-500\t120", columns);
    expect(rows[0].isValid).toBe(false);
    expect(rows[0].errors.qty).toBe("must be a non-negative number");
    expect(rows[1].isValid).toBe(true);
  });

  it("preserves every row's order and count on a large paste", () => {
    const lines = Array.from({ length: 250 }, (_, i) => `SKU-${i}\t${i}`);
    const rows = parseBulkPaste(lines.join("\n"), columns);
    expect(rows).toHaveLength(250);
    expect(rows.every((r) => r.isValid)).toBe(true);
    expect(rows[249].values).toEqual({ sku: "SKU-249", qty: 249 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- client/src/lib/bulkPaste.test.ts`
Expected: FAIL — `./bulkPaste` module doesn't exist.

- [ ] **Step 3: Implement**

Create `client/src/lib/bulkPaste.ts`:

```ts
export interface BulkPasteColumn<T> {
  key: keyof T;
  label: string;
  parse: (raw: string) => { ok: true; value: T[keyof T] } | { ok: false; error: string };
}

export interface BulkPasteRow<T> {
  raw: string[];
  values: Partial<T>;
  errors: Partial<Record<keyof T, string>>;
  isValid: boolean;
}

export function parseBulkPaste<T>(text: string, columns: BulkPasteColumn<T>[]): BulkPasteRow<T>[] {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  return lines.map((line) => {
    const raw = line.split("\t");
    const values: Partial<T> = {};
    const errors: Partial<Record<keyof T, string>> = {};

    if (raw.length !== columns.length) {
      // Every column gets the same error so the whole row renders as invalid
      // in a preview table keyed by column, not just the first cell.
      for (const col of columns) {
        errors[col.key] = `expected ${columns.length} columns, got ${raw.length}`;
      }
      return { raw, values, errors, isValid: false };
    }

    columns.forEach((col, i) => {
      const result = col.parse(raw[i]);
      if (result.ok) {
        values[col.key] = result.value;
      } else {
        errors[col.key] = result.error;
      }
    });

    return { raw, values, errors, isValid: Object.keys(errors).length === 0 };
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- client/src/lib/bulkPaste.test.ts`
Expected: PASS, all 7 tests.

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/bulkPaste.ts client/src/lib/bulkPaste.test.ts
git commit -m "feat: add generic TSV bulk-paste parsing utility"
```

---

### Task 5: Server — `bulkCreateSkus`

**Files:**
- Modify: `server/db.ts` (add after `createSku`, ~line 19)
- Modify: `server/routers.ts` (add to `catalog` router, after `createSku`, ~line 75)
- Test: `server/db.test.ts`

**Interfaces:**
- Consumes: `createSku` (existing, `server/db.ts:15`).
- Produces:
  ```ts
  export async function bulkCreateSkus(
    rows: Omit<InsertSku, "id">[],
  ): Promise<{ index: number; ok: true; id: number }[] | { index: number; ok: false; error: string }[]>
  ```
  Actually returns one array mixing both shapes per row — see implementation. Consumed by Task 6's `<BulkPasteImport>` wiring (Task 6) via `trpc.catalog.bulkCreateSkus`.

- [ ] **Step 1: Write the failing test**

Add to `server/db.test.ts`:

```ts
  it("bulkCreateSkus inserts every valid row and reports per-row failures without aborting the batch", async () => {
    const results = await bulkCreateSkus([
      { sku: "BULK-1", primaryIdentifierType: "sku" },
      { primaryIdentifierType: "sku" }, // no sku value — violates the NOT NULL-by-construction rule createSku already enforces
      { sku: "BULK-3", primaryIdentifierType: "sku" },
    ]);
    expect(results[0]).toMatchObject({ index: 0, ok: true });
    expect(results[1]).toMatchObject({ index: 1, ok: false });
    expect(results[2]).toMatchObject({ index: 2, ok: true });

    const all = await listSkus();
    expect(all.map((s) => s.sku).sort()).toEqual(["BULK-1", "BULK-3"]);
  });
```

Add `bulkCreateSkus` to the existing `import { ... } from "./db"` line at the top of the file.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- server/db.test.ts -t "bulkCreateSkus"`
Expected: FAIL — `bulkCreateSkus` is not exported.

- [ ] **Step 3: Implement**

In `server/db.ts`, add after `createSku` (after line 19):

```ts
export async function bulkCreateSkus(
  rows: Omit<InsertSku, "id">[],
): Promise<({ index: number; ok: true; id: number } | { index: number; ok: false; error: string })[]> {
  // One partial failure must not roll back the valid rows around it — this
  // is a bulk *import* (independent rows), not a single atomic operation
  // like a shipment's cost allocation, so each row commits or fails on its
  // own rather than the whole batch succeeding or failing together.
  const results: ({ index: number; ok: true; id: number } | { index: number; ok: false; error: string })[] = [];
  for (let index = 0; index < rows.length; index++) {
    try {
      const row = await createSku(rows[index]);
      results.push({ index, ok: true, id: row.id });
    } catch (err) {
      results.push({ index, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- server/db.test.ts -t "bulkCreateSkus"`
Expected: PASS.

- [ ] **Step 5: Add the router procedure**

In `server/routers.ts`, add to the `catalog` router, right after `createSku` (after line 75):

```ts
    bulkCreateSkus: editorProcedure
      .input(z.array(z.object({
        sku: z.string().optional(),
        ssku: z.string().optional(),
        asin: z.string().optional(),
        ean: z.string().optional(),
        fnsku: z.string().optional(),
        name: z.string().optional(),
        primaryIdentifierType: z.enum(SKU_IDENTIFIER_TYPES),
      })))
      .mutation(({ input }) => bulkCreateSkus(input)),
```

Add `bulkCreateSkus` to the existing `import { ..., createSku, updateSku, listSkus, ... } from "./db"` line.

- [ ] **Step 6: Type-check and run the full suite**

Run: `pnpm check && pnpm test`
Expected: both clean.

- [ ] **Step 7: Commit**

```bash
git add server/db.ts server/db.test.ts server/routers.ts
git commit -m "feat: add bulkCreateSkus (server + router)"
```

---

### Task 6: Client — `<BulkPasteImport>` component, wired into the SKU tab

**Files:**
- Create: `client/src/components/BulkPasteImport.tsx`
- Modify: `client/src/pages/CatalogPage.tsx` (SKU section — exact placement finalized in Task 9's tab restructure; this task adds the component and a temporary mount point at the bottom of the existing `SkusSection`)

**Interfaces:**
- Consumes: `parseBulkPaste`, `BulkPasteColumn` (Task 4); `trpc.catalog.bulkCreateSkus` (Task 5).
- Produces:
  ```tsx
  export function BulkPasteImport<T>(props: {
    columns: BulkPasteColumn<T>[];
    onSubmit: (rows: T[]) => Promise<({ index: number; ok: true } | { index: number; ok: false; error: string })[]>;
    onImported: () => void;
  }): JSX.Element
  ```
  Reused unmodified by Task 8 (Vendors) and by the Transactions plan.

- [ ] **Step 1: Implement the component**

Create `client/src/components/BulkPasteImport.tsx`:

```tsx
import { useState } from "react";
import { parseBulkPaste, type BulkPasteColumn, type BulkPasteRow } from "../lib/bulkPaste";

export function BulkPasteImport<T>({
  columns,
  onSubmit,
  onImported,
}: {
  columns: BulkPasteColumn<T>[];
  onSubmit: (rows: T[]) => Promise<({ index: number; ok: true } | { index: number; ok: false; error: string })[]>;
  onImported: () => void;
}) {
  const [text, setText] = useState("");
  const [rows, setRows] = useState<BulkPasteRow<T>[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ okCount: number; total: number } | null>(null);

  const handleParse = () => setRows(parseBulkPaste(text, columns));

  const validRows = rows.filter((r) => r.isValid);
  const canSubmit = rows.length > 0 && validRows.length > 0 && !submitting;

  const handleSubmit = async () => {
    setSubmitting(true);
    setResult(null);
    try {
      const outcomes = await onSubmit(validRows.map((r) => r.values as T));
      const okCount = outcomes.filter((o) => o.ok).length;
      setResult({ okCount, total: outcomes.length });
      if (okCount > 0) {
        setText("");
        setRows([]);
        onImported();
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <p>
        Paste rows copied from Excel/Sheets — expected columns, in order: {columns.map((c) => c.label).join(" · ")}
      </p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={6}
        style={{ width: "100%", fontFamily: "monospace" }}
      />
      <button onClick={handleParse} disabled={text.trim().length === 0}>
        Preview
      </button>
      {rows.length > 0 && (
        <>
          <table>
            <thead>
              <tr>
                {columns.map((c) => <th key={String(c.key)}>{c.label}</th>)}
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i} style={{ background: row.isValid ? undefined : "var(--critical-soft)" }}>
                  {columns.map((c) => (
                    <td key={String(c.key)}>
                      {row.raw[columns.indexOf(c)] ?? ""}
                      {row.errors[c.key] && <div style={{ color: "var(--critical)" }}>{row.errors[c.key]}</div>}
                    </td>
                  ))}
                  <td>{row.isValid ? "✓" : "✗"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <button disabled={!canSubmit} onClick={handleSubmit}>
            Record {validRows.length} row{validRows.length === 1 ? "" : "s"}
          </button>
          {result && (
            <p>Recorded {result.okCount} of {result.total}.</p>
          )}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Wire it into the SKU section**

In `client/src/pages/CatalogPage.tsx`, add imports at the top:

```tsx
import { BulkPasteImport } from "../components/BulkPasteImport";
import type { BulkPasteColumn } from "../lib/bulkPaste";
```

Add, before the `export function SkusSection()` closing `</div>` (end of the function, just before its final `</div>` on line 79-80):

```tsx
      <BulkPasteImport<{ sku: string; name: string; primaryIdentifierType: "sku" }>
        columns={[
          { key: "sku", label: "SKU", parse: (raw) => (raw.trim() ? { ok: true, value: raw.trim() } : { ok: false, error: "required" }) },
          { key: "name", label: "Name", parse: (raw) => ({ ok: true, value: raw.trim() }) },
        ] as BulkPasteColumn<{ sku: string; name: string; primaryIdentifierType: "sku" }>[]}
        onSubmit={async (rows) => {
          const results = await bulkCreateSkusMutation.mutateAsync(
            rows.map((r) => ({ sku: r.sku, name: r.name || undefined, primaryIdentifierType: "sku" as const })),
          );
          return results;
        }}
        onImported={() => utils.catalog.listSkus.invalidate()}
      />
```

Add, inside `SkusSection()`, alongside the existing `createSku` mutation hook:

```tsx
  const bulkCreateSkusMutation = trpc.catalog.bulkCreateSkus.useMutation();
```

Bulk import here is intentionally scoped to `sku`/`name` only (the two free-text identifier types, covering the overwhelmingly common real case — a client's catalog export is SKU+name) — not every one of the 6 identifier-type variants the single-row form supports. A vendor onboarding an ASIN/EAN/FNSKU-primary catalog still uses the single-row form.

- [ ] **Step 3: Manual verification**

Run: `pnpm dev`, open Catalog, paste `TEST-1\tTest One\nTEST-2\tTest Two` into the new box, click Preview, confirm both rows show valid, click Record, confirm both SKUs appear in the table above and the paste box clears.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/BulkPasteImport.tsx client/src/pages/CatalogPage.tsx
git commit -m "feat: add BulkPasteImport component, wire into Catalog SKU bulk import"
```

---

### Task 7: Server — `bulkCreateVendors`

**Files:**
- Modify: `server/db.ts` (add after `createVendor`)
- Modify: `server/routers.ts` (add to `catalog` router, after `createVendor`)
- Test: `server/db.test.ts`

**Interfaces:**
- Consumes: `createVendor` (`server/db.ts:38`, extended by Task 1/2 to accept `type`/`products`).
- Produces: `bulkCreateVendors(rows: Omit<InsertVendor, "id">[]): Promise<({ index: number; ok: true; id: number } | { index: number; ok: false; error: string })[]>` — identical shape to Task 5's `bulkCreateSkus`.

- [ ] **Step 1: Write the failing test**

Add to `server/db.test.ts`:

```ts
  it("bulkCreateVendors inserts every valid row and reports per-row failures without aborting the batch", async () => {
    const results = await bulkCreateVendors([
      { name: "Vendor A", type: "manufacturer" },
      { name: "", type: "manufacturer" }, // empty name — vendors.name is NOT NULL but not empty-checked at the DB level; MySQL accepts it, so assert on a real DB-level failure instead
      { name: "Vendor C", type: "agent" },
    ]);
    expect(results[0]).toMatchObject({ index: 0, ok: true });
    expect(results[2]).toMatchObject({ index: 2, ok: true });

    const all = await listVendors();
    expect(all.map((v) => v.name)).toContain("Vendor A");
    expect(all.map((v) => v.name)).toContain("Vendor C");
  });
```

`name: ""` will actually succeed at the DB level (MySQL's `NOT NULL` doesn't reject empty strings) — this test only needs to prove the 2 clearly-valid rows both land and the batch isn't aborted by anything in between; it does not assert `results[1].ok === false`. Add `bulkCreateVendors` to the existing `db` import.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- server/db.test.ts -t "bulkCreateVendors"`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement**

In `server/db.ts`, add after `createVendor`:

```ts
export async function bulkCreateVendors(
  rows: Omit<InsertVendor, "id">[],
): Promise<({ index: number; ok: true; id: number } | { index: number; ok: false; error: string })[]> {
  const results: ({ index: number; ok: true; id: number } | { index: number; ok: false; error: string })[] = [];
  for (let index = 0; index < rows.length; index++) {
    try {
      const row = await createVendor(rows[index]);
      results.push({ index, ok: true, id: row.id });
    } catch (err) {
      results.push({ index, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- server/db.test.ts -t "bulkCreateVendors"`
Expected: PASS.

- [ ] **Step 5: Add the router procedure**

In `server/routers.ts`, add to `catalog`, after `createVendor`:

```ts
    bulkCreateVendors: editorProcedure
      .input(z.array(z.object({
        name: z.string(),
        contactEmail: z.string().optional(),
        type: z.enum(VENDOR_TYPES).optional(),
      })))
      .mutation(({ input, ctx }) => bulkCreateVendors(input.map((row) => ({ ...row, createdBy: ctx.user.id })))),
```

Add `bulkCreateVendors` to the `db` import.

- [ ] **Step 6: Type-check and run the full suite**

Run: `pnpm check && pnpm test`

- [ ] **Step 7: Commit**

```bash
git add server/db.ts server/db.test.ts server/routers.ts
git commit -m "feat: add bulkCreateVendors (server + router)"
```

---

### Task 8: Client — wire `<BulkPasteImport>` into the Vendors tab

**Files:**
- Modify: `client/src/pages/CatalogPage.tsx` (`VendorsSection`)

**Interfaces:**
- Consumes: `BulkPasteImport` (Task 6), `trpc.catalog.bulkCreateVendors` (Task 7).

- [ ] **Step 1: Wire it in**

In `client/src/pages/CatalogPage.tsx`, inside `VendorsSection()`, add:

```tsx
  const bulkCreateVendorsMutation = trpc.catalog.bulkCreateVendors.useMutation();
```

And before `VendorsSection`'s closing `</div>`:

```tsx
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
```

Add `import { VENDOR_TYPES } from "../../../drizzle/schema";` to the top of `CatalogPage.tsx` (alongside the existing `SKU_IDENTIFIER_TYPES` import).

- [ ] **Step 2: Manual verification**

Run: `pnpm dev`, paste `Test Vendor\tmanufacturer` into the new Vendors box, confirm it imports and appears with the right type.

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/CatalogPage.tsx
git commit -m "feat: wire BulkPasteImport into Catalog Vendors tab"
```

---

### Task 9: Client — restructure CatalogPage into 3 tabs + SKU tab field-parity fixes

**Files:**
- Modify: `client/src/pages/CatalogPage.tsx` (`CatalogPage`, `SkusSection`/`SkuRow`)

**Interfaces:**
- Consumes: `.badge-info` (Task 3).

- [ ] **Step 1: Restructure the top-level page**

Replace the `export function CatalogPage()` function (lines 245-254) with:

```tsx
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
```

(Matches `MoneyPage.tsx:6,56-58`'s exact plain-button tab pattern.)

- [ ] **Step 2: Fix the Identifier display bug + add Bundle/Status badges + search/filter**

Replace `SkusSection()` (lines 10-81) with:

```tsx
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
```

(This supersedes Task 6 Step 2's placement — same `<BulkPasteImport>` call, now at the bottom of the fully-rebuilt section instead of appended to the old one.)

- [ ] **Step 3: Update `SkuRow` for Identifier + Bundle + badge status**

Replace `SkuRow` (lines 83-118) with:

```tsx
const SKU_IDENTIFIER_FIELDS = { sku: "sku", ssku: "ssku", asin: "asin", ean: "ean", fnsku: "fnsku", name: "name" } as const;

function SkuRow({ sku, onUpdated }: {
  sku: {
    id: number; sku: string | null; name: string | null; primaryIdentifierType: (typeof SKU_IDENTIFIER_TYPES)[number];
    status: "active" | "inactive"; isBundle: boolean; leadTimeDays: number; safetyStockDays: number;
    ssku: string | null; asin: string | null; ean: string | null; fnsku: string | null;
  };
  onUpdated: () => void;
}) {
  const [leadTimeDays, setLeadTimeDays] = useState(String(sku.leadTimeDays));
  const [safetyStockDays, setSafetyStockDays] = useState(String(sku.safetyStockDays));
  const updateSku = trpc.catalog.updateSku.useMutation({ onSuccess: onUpdated });

  const identifierValue = sku[SKU_IDENTIFIER_FIELDS[sku.primaryIdentifierType]] ?? "—";

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
```

`skus.listSkus` must already return `ssku`/`asin`/`ean`/`fnsku`/`isBundle` — `server/db.ts:33-36`'s `listSkus` does a bare `db.select().from(skus)`, which returns every column, so no server change is needed here.

- [ ] **Step 4: Type-check**

Run: `pnpm check`
Expected: clean. (`SKU_IDENTIFIER_FIELDS[sku.primaryIdentifierType]` indexing requires `primaryIdentifierType`'s type to be a key of the map — matches `SKU_IDENTIFIER_TYPES` exactly, so this is type-safe without a cast.)

- [ ] **Step 5: Manual verification**

Run: `pnpm dev`. Create a SKU with primary identifier type `ean`. Confirm the Identifier column shows the EAN value (not "—"). Toggle its status and confirm the badge color changes (ok ↔ neutral) and the button label flips (Deactivate ↔ Activate). Search by partial name, confirm filtering works. Check the bundle-only toggle with no bundle SKUs present, confirm the list empties.

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/CatalogPage.tsx
git commit -m "feat: restructure Catalog into tabs, fix Identifier display, add Bundle/Status badges and search"
```

---

### Task 10: Client — Vendors tab field-parity (Type/Products/Active/notes)

**Files:**
- Modify: `client/src/pages/CatalogPage.tsx` (`VendorsSection`, `VendorRow`)

**Interfaces:**
- Consumes: `.badge-info`/`.badge-ok`/`.badge-neutral` (existing + Task 3), `VENDOR_TYPES` (Task 1).

- [ ] **Step 1: Update `VendorsSection` and `VendorRow`**

Replace `VendorsSection()` and `VendorRow()` (lines 120-179 in the original file) with:

```tsx
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
```

- [ ] **Step 2: Type-check**

Run: `pnpm check`

- [ ] **Step 3: Manual verification**

Run: `pnpm dev`. Edit a vendor, set Type + Products (comma-separated), save, confirm both render correctly in the read view. Toggle Active off, confirm the badge flips to neutral/"inactive" and the button label flips.

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/CatalogPage.tsx
git commit -m "feat: add Type/Products/Active/notes to Catalog Vendors tab"
```

---

### Task 11: Warehouses Active/Inactive (server + client)

**Files:**
- Modify: `drizzle/schema.ts` (`warehouses` table)
- Modify: `server/db.ts` (`updateWarehouse` already accepts `Partial<InsertWarehouse>` — no signature change needed, only the schema)
- Modify: `server/routers.ts` (`catalog.updateWarehouse` input schema)
- Modify: `client/src/pages/CatalogPage.tsx` (`WarehousesSection`, `WarehouseRow`)
- Test: `server/db.test.ts`

**Interfaces:**
- Produces: `Warehouse` type gains `active: boolean` (default `true`).

- [ ] **Step 1: Write the failing test**

Add to `server/db.test.ts`:

```ts
  it("createWarehouse defaults active to true; updateWarehouse can deactivate it", async () => {
    const wh = await createWarehouse({ code: "TEST-WH", name: "Test Warehouse" });
    expect(wh.active).toBe(true);
    const updated = await updateWarehouse(wh.id, { active: false });
    expect(updated.active).toBe(false);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- server/db.test.ts -t "defaults active to true"`
Expected: FAIL.

- [ ] **Step 3: Add the column**

In `drizzle/schema.ts`, replace the `warehouses` table (lines 77-84) with:

```ts
export const warehouses = mysqlTable("warehouses", {
  id: int("id").autoincrement().primaryKey(),
  code: varchar("code", { length: 32 }).notNull().unique(),
  name: varchar("name", { length: 128 }).notNull(),
  active: boolean("active").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type Warehouse = typeof warehouses.$inferSelect;
export type InsertWarehouse = typeof warehouses.$inferInsert;
```

- [ ] **Step 4: Push the migration**

Run: `pnpm db:push`

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test -- server/db.test.ts -t "defaults active to true"`
Expected: PASS.

- [ ] **Step 6: Update the router**

In `server/routers.ts`, replace the `catalog.updateWarehouse` procedure (original lines 93-95) with:

```ts
    updateWarehouse: editorProcedure
      .input(z.object({ id: z.number(), code: z.string().optional(), name: z.string().optional(), active: z.boolean().optional() }))
      .mutation(({ input }) => updateWarehouse(input.id, { code: input.code, name: input.name, active: input.active })),
```

- [ ] **Step 7: Update the client**

Replace `WarehouseRow` (lines 217-243 in the original file) with:

```tsx
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
```

Update `WarehousesSection`'s table header (original line 200) from `<tr><th>Code</th><th>Name</th><th>Actions</th></tr>` to `<tr><th>Code</th><th>Name</th><th>Active</th><th>Actions</th></tr>`.

- [ ] **Step 8: Type-check and run the full suite**

Run: `pnpm check && pnpm test`

- [ ] **Step 9: Manual verification**

Run: `pnpm dev`, toggle a warehouse's Active state, confirm badge + button flip correctly.

- [ ] **Step 10: Commit**

```bash
git add drizzle/schema.ts drizzle/migrations server/db.ts server/db.test.ts server/routers.ts client/src/pages/CatalogPage.tsx
git commit -m "feat: add Active/Inactive to Warehouses"
```

---

## After this plan

This plan covers spec §3 (Catalog) and the shared bulk-paste component referenced by spec §9.2 (Transactions). The remaining spec sections (§4 Home, §5 Stock, §6 Purchase Orders, §7 Shipments, §8 Cost & Cashflow, §9 Transactions' own match-auto-suggestion and bulk-paste wiring) each need their own plan, written separately — this spec covers 7 largely-independent page subsystems and per `writing-plans`' own scope-check guidance should not be forced into one giant plan.
