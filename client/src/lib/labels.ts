export function skuLabel(s: { id: number; sku?: string | null; name?: string | null }): string {
  return s.name || s.sku || `SKU #${s.id}`;
}

export function warehouseLabel(w: { id: number; code: string; name: string }): string {
  return `${w.code} — ${w.name}`;
}

const CURRENCY_SYMBOLS: Record<string, string> = { EUR: "€", USD: "$", CNY: "¥", GBP: "£" };

export function formatMoney(amount: string | number, currency: string): string {
  const symbol = CURRENCY_SYMBOLS[currency.toUpperCase()] ?? currency.toUpperCase() + " ";
  const value = typeof amount === "string" ? amount : amount.toFixed(2);
  return `${symbol}${value}`;
}
