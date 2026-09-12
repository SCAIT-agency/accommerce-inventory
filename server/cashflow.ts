// server/cashflow.ts
import { and, between, eq, isNotNull } from "drizzle-orm";
import { db } from "./dbClient";
import { payments } from "../drizzle/schema";
import { listUnmatchedTransactions } from "./payments";

export interface CashflowDay {
  date: string;
  plannedOutflow: number;
  actualOutflow: number;
}

export async function getCashflowForecast(from: Date, to: Date): Promise<CashflowDay[]> {
  const byDate = new Map<string, CashflowDay>();

  // Planned: unpaid payments whose EXPECTED date falls in the window.
  // expectedAmount is denominated in the payment's own `currency`, and no
  // fx_rate exists yet (that is only captured at payment time), so summing
  // across currencies would produce a materially wrong headline figure.
  // The invariant this guards is range-wide, not per-day: any caller (e.g.
  // dashboards.getHomeSummary) may reduce plannedOutflow across every day in
  // the result, so a single currency must hold across the WHOLE [from, to]
  // range, not just within each date bucket — two single-currency days that
  // differ from each other are just as unsafe to blend as two currencies on
  // the same day. Multi-currency planned aggregation is an unresolved design
  // question — fail loudly rather than blend. (actualOutflow below is exempt:
  // it sums baseCurrencyAmount, single-currency by construction.)
  const fromKey = from.toISOString().slice(0, 10);
  const toKey = to.toISOString().slice(0, 10);
  const plannedCurrencies = new Set<string>();
  const plannedRows = await db
    .select()
    .from(payments)
    .where(and(eq(payments.paid, false), between(payments.expectedDate, from, to)));
  for (const row of plannedRows) {
    const dateKey = row.expectedDate.toISOString().slice(0, 10);
    plannedCurrencies.add(row.currency);
    if (plannedCurrencies.size > 1) {
      throw new Error(
        `getCashflowForecast: cannot aggregate mixed currencies (${[...plannedCurrencies].join(", ")}) across ${fromKey} to ${toKey} — multi-currency planned-cashflow aggregation is an unresolved design question, see spec Open Questions`,
      );
    }

    const entry = byDate.get(dateKey) ?? { date: dateKey, plannedOutflow: 0, actualOutflow: 0 };
    entry.plannedOutflow += parseFloat(row.expectedAmount);
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
    const entry = byDate.get(dateKey) ?? { date: dateKey, plannedOutflow: 0, actualOutflow: 0 };
    entry.actualOutflow += parseFloat(row.baseCurrencyAmount ?? "0");
    byDate.set(dateKey, entry);
  }

  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

export { listUnmatchedTransactions };
