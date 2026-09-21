import { eq, isNull, and, ne, desc } from "drizzle-orm";
import { db, type DbClient } from "./dbClient";
import { payments, transactions, purchaseOrders, type Payment, type Transaction } from "../drizzle/schema";
import { logChange, normalizeDecimalForAudit, type ReasonCategory } from "./changeLog";

export interface CreateExpectedPaymentInput {
  poId?: number;
  shipmentId?: number;
  sequenceNo: number;
  expectedAmount: string;
  expectedDate: Date;
  currency: string;
}

export async function createExpectedPayment(input: CreateExpectedPaymentInput, dbClient: DbClient = db): Promise<Payment> {
  const [result] = await dbClient.insert(payments).values(input);
  const [row] = await dbClient.select().from(payments).where(eq(payments.id, result.insertId));
  return row;
}

export interface MarkPaymentPaidOpts {
  amount: string;
  fxRate: string;
  paidDate: Date;
  reasonCategory: ReasonCategory;
  reasonNote?: string;
  changedBy: number;
}

export async function markPaymentPaidCore(id: number, opts: MarkPaymentPaidOpts, dbClient: DbClient): Promise<Payment> {
  const [before] = await dbClient.select().from(payments).where(eq(payments.id, id));
  if (!before) {
    throw new Error(`markPaymentPaid: no payment found with id ${id}`);
  }
  const baseCurrencyAmount = (parseFloat(opts.amount) * parseFloat(opts.fxRate)).toFixed(2);

  await dbClient
    .update(payments)
    .set({
      paid: true,
      paidAmount: opts.amount,
      paidDate: opts.paidDate,
      fxRate: opts.fxRate,
      baseCurrencyAmount,
    })
    .where(eq(payments.id, id));

  await logChange({
    entityType: "payment",
    entityId: id,
    field: "paid",
    oldValue: String(before.paid),
    newValue: "true",
    reasonCategory: opts.reasonCategory,
    reasonNote: opts.reasonNote,
    changedBy: opts.changedBy,
  }, dbClient);
  await logChange({
    entityType: "payment",
    entityId: id,
    field: "fxRate",
    oldValue: normalizeDecimalForAudit(before.fxRate),
    newValue: normalizeDecimalForAudit(opts.fxRate),
    reasonCategory: opts.reasonCategory,
    reasonNote: opts.reasonNote,
    changedBy: opts.changedBy,
  }, dbClient);
  await logChange({
    entityType: "payment",
    entityId: id,
    field: "paidAmount",
    oldValue: normalizeDecimalForAudit(before.paidAmount),
    newValue: normalizeDecimalForAudit(opts.amount),
    reasonCategory: opts.reasonCategory,
    reasonNote: opts.reasonNote,
    changedBy: opts.changedBy,
  }, dbClient);

  const [row] = await dbClient.select().from(payments).where(eq(payments.id, id));
  return row;
}

export async function markPaymentPaid(id: number, opts: MarkPaymentPaidOpts): Promise<Payment> {
  return db.transaction((tx) => markPaymentPaidCore(id, opts, tx));
}

export interface RecordTransactionInput {
  date: Date;
  amount: string;
  currency: string;
  fxRate: string;
  counterparty?: string;
  description?: string;
}

export async function recordTransaction(input: RecordTransactionInput, dbClient: DbClient = db): Promise<Transaction> {
  const [result] = await dbClient.insert(transactions).values(input);
  const [row] = await dbClient.select().from(transactions).where(eq(transactions.id, result.insertId));
  return row;
}

export interface MatchTransactionOpts {
  reasonCategory: ReasonCategory;
  reasonNote?: string;
  changedBy: number;
}

export async function matchTransactionToPayment(
  transactionId: number,
  paymentId: number,
  opts: MatchTransactionOpts,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [txRow] = await tx.select().from(transactions).where(eq(transactions.id, transactionId));
    if (!txRow) {
      throw new Error(`matchTransactionToPayment: no transaction found with id ${transactionId}`);
    }
    const [existingMatch] = await tx
      .select()
      .from(transactions)
      .where(and(eq(transactions.matchedPaymentId, paymentId), ne(transactions.id, transactionId)));
    if (existingMatch) {
      throw new Error(
        `matchTransactionToPayment: payment ${paymentId} is already matched to a different transaction (id ${existingMatch.id}) — cannot match transaction ${transactionId} to it`,
      );
    }
    if (txRow.matchedPaymentId !== null && txRow.matchedPaymentId !== paymentId) {
      throw new Error(
        `transaction ${transactionId} is already matched to payment ${txRow.matchedPaymentId} — cannot re-match to payment ${paymentId}`,
      );
    }

    await tx.update(transactions).set({ matchedPaymentId: paymentId }).where(eq(transactions.id, transactionId));

    const [payment] = await tx.select().from(payments).where(eq(payments.id, paymentId));
    if (!payment) {
      throw new Error(`matchTransactionToPayment: no payment found with id ${paymentId}`);
    }
    if (!payment.paid) {
      await markPaymentPaidCore(
        paymentId,
        {
          amount: txRow.amount,
          fxRate: txRow.fxRate,
          paidDate: txRow.date,
          reasonCategory: opts.reasonCategory,
          reasonNote: opts.reasonNote,
          changedBy: opts.changedBy,
        },
        tx,
      );
    }
  });
}

export async function listUnmatchedTransactions(): Promise<Transaction[]> {
  return db.select().from(transactions).where(isNull(transactions.matchedPaymentId));
}

export async function listTransactions(): Promise<Transaction[]> {
  return db.select().from(transactions).orderBy(desc(transactions.date));
}

export async function listPaymentsForPo(poId: number, dbClient: DbClient = db): Promise<Payment[]> {
  return dbClient.select().from(payments).where(eq(payments.poId, poId));
}

export interface UnpaidPayment extends Payment {
  poNumber: string | null;
}

export async function listUnpaidPayments(dbClient: DbClient = db): Promise<UnpaidPayment[]> {
  const [unpaid, allTransactions, pos] = await Promise.all([
    dbClient.select().from(payments).where(eq(payments.paid, false)),
    dbClient.select().from(transactions),
    dbClient.select().from(purchaseOrders),
  ]);
  const matchedPaymentIds = new Set(
    allTransactions.filter((t) => t.matchedPaymentId !== null).map((t) => t.matchedPaymentId),
  );
  const poNumberById = new Map(pos.map((po) => [po.id, po.poNumber]));
  return unpaid
    .filter((p) => !matchedPaymentIds.has(p.id))
    .map((p) => ({ ...p, poNumber: p.poId !== null ? poNumberById.get(p.poId) ?? null : null }));
}
