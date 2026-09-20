// server/cashflow.ts
import { and, between, eq, isNotNull } from "drizzle-orm";
import { db } from "./dbClient";
import { payments } from "../drizzle/schema";
import { listUnmatchedTransactions } from "./payments";
import { getAppSetting } from "./db";

export interface CashflowDay {
  date: string;
  plannedOutflow: number;
  actualOutflow: number;
  /** True when plannedOutflow includes a non-BASE_CURRENCY amount converted
   * via a standard (not locked-in) FX rate — see getStandardFxRate below. */
  plannedOutflowIsEstimated: boolean;
}

// This Jello instance's own reporting currency for cross-currency planned
// estimates — matches what `baseCurrencyAmount` already converts real paid
// amounts into (server/payments.ts's markPaymentPaid). Not a generic
// multi-tenant concept; a future client instance may need its own value.
const BASE_CURRENCY = "EUR";

// Seed defaults for currencies with no app_settings override yet. Jello's
// own standing approximate rate (see acc/reference docs) — override without
// a redeploy via app_settings key `standard_fx_rate:<CCY>`.
const DEFAULT_STANDARD_FX_RATES: Record<string, string> = {
  USD: "0.86",
};

async function getStandardFxRate(currency: string): Promise<number> {
  if (currency === BASE_CURRENCY) return 1;
  const override = await getAppSetting(`standard_fx_rate:${currency}`);
  const rate = override ?? DEFAULT_STANDARD_FX_RATES[currency];
  if (rate === undefined) {
    throw new Error(
      `getCashflowForecast: no standard FX rate configured for "${currency}" — ` +
      `set app_settings key "standard_fx_rate:${currency}" or add a default in DEFAULT_STANDARD_FX_RATES`,
    );
  }
  return parseFloat(rate);
}

function defaultCashflowDay(dateKey: string): CashflowDay {
  return { date: dateKey, plannedOutflow: 0, actualOutflow: 0, plannedOutflowIsEstimated: false };
}

export async function getCashflowForecast(from: Date, to: Date): Promise<CashflowDay[]> {
  const byDate = new Map<string, CashflowDay>();

  // Planned: unpaid payments whose EXPECTED date falls in the window.
  // expectedAmount is denominated in the payment's own `currency`, and no
  // fx_rate exists yet (that is only captured at payment time). A window
  // where every planned payment shares one currency sums exactly, unchanged
  // from before — the common case stays byte-identical. Only when the
  // window genuinely spans more than one currency (checked range-wide, not
  // per-day, since any caller may reduce plannedOutflow across every day in
  // the result) do we convert each non-BASE_CURRENCY amount via a standard
  // (not locked-in) rate and flag the affected day as an estimate, rather
  // than throwing and breaking the whole dashboard. (actualOutflow below is
  // exempt: it sums baseCurrencyAmount, exact and single-currency by
  // construction — the real FX rate was already locked in at payment time.)
  const plannedRows = await db
    .select()
    .from(payments)
    .where(and(eq(payments.paid, false), between(payments.expectedDate, from, to)));

  const distinctCurrencies = new Set(plannedRows.map((row) => row.currency));
  const mixedCurrencies = distinctCurrencies.size > 1;
  let rateByCurrency: Map<string, number> | null = null;
  if (mixedCurrencies) {
    rateByCurrency = new Map();
    for (const currency of distinctCurrencies) {
      rateByCurrency.set(currency, await getStandardFxRate(currency));
    }
  }

  for (const row of plannedRows) {
    const dateKey = row.expectedDate.toISOString().slice(0, 10);
    const entry = byDate.get(dateKey) ?? defaultCashflowDay(dateKey);
    if (!mixedCurrencies) {
      entry.plannedOutflow += parseFloat(row.expectedAmount);
    } else {
      entry.plannedOutflow += parseFloat(row.expectedAmount) * rateByCurrency!.get(row.currency)!;
      if (row.currency !== BASE_CURRENCY) entry.plannedOutflowIsEstimated = true;
    }
    byDate.set(dateKey, entry);
  }

  // Actual: paid payments whose real PAID date falls in the window —
  // independent of whether their original expectedDate was inside or outside it.
  const paidRows = await db
    .select()
    .from(payments)
    .where(and(eq(payments.paid, true), isNotNull(payments.paidDate), between(payments.paidDate, from, to)));
  for (const row of paidRows) {
    if (!row.paidDate) continue;
    const dateKey = row.paidDate.toISOString().slice(0, 10);
    const entry = byDate.get(dateKey) ?? defaultCashflowDay(dateKey);
    entry.actualOutflow += parseFloat(row.baseCurrencyAmount ?? "0");
    byDate.set(dateKey, entry);
  }

  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

export { listUnmatchedTransactions };
