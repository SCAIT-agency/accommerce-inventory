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
  const plannedRows = await db
    .select()
    .from(payments)
    .where(and(eq(payments.paid, false), between(payments.expectedDate, from, to)));
  for (const row of plannedRows) {
    const dateKey = row.expectedDate.toISOString().slice(0, 10);
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
