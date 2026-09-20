export function skuLabel(s: { id: number; sku?: string | null; name?: string | null }): string {
  return s.name || s.sku || `SKU #${s.id}`;
}

export function warehouseLabel(w: { id: number; code: string; name: string }): string {
  return `${w.code} — ${w.name}`;
}
