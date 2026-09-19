import { eq, isNull } from "drizzle-orm";
import { db, type DbClient } from "./dbClient";
import { payments, transactions, type Payment, type Transaction } from "../drizzle/schema";
import { logChange, type ReasonCategory } from "./changeLog";

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

export async function markPaymentPaid(
  id: number,
  opts: {
    amount: string;
    fxRate: string;
    paidDate: Date;
    reasonCategory: ReasonCategory;
    reasonNote?: string;
    changedBy: number;
  },
): Promise<Payment> {
  const [before] = await db.select().from(payments).where(eq(payments.id, id));
  const baseCurrencyAmount = (parseFloat(opts.amount) * parseFloat(opts.fxRate)).toFixed(2);

  await db
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
  });
  await logChange({
    entityType: "payment",
    entityId: id,
    field: "fxRate",
    oldValue: before.fxRate,
    newValue: opts.fxRate,
    reasonCategory: opts.reasonCategory,
    reasonNote: opts.reasonNote,
    changedBy: opts.changedBy,
  });
  await logChange({
    entityType: "payment",
    entityId: id,
    field: "paidAmount",
    oldValue: before.paidAmount,
    newValue: opts.amount,
    reasonCategory: opts.reasonCategory,
    reasonNote: opts.reasonNote,
    changedBy: opts.changedBy,
  });

  const [row] = await db.select().from(payments).where(eq(payments.id, id));
  return row;
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

export async function matchTransactionToPayment(transactionId: number, paymentId: number): Promise<void> {
  const [tx] = await db.select().from(transactions).where(eq(transactions.id, transactionId));
  if (!tx) {
    throw new Error(`matchTransactionToPayment: no transaction found with id ${transactionId}`);
  }
  if (tx.matchedPaymentId !== null && tx.matchedPaymentId !== paymentId) {
    throw new Error(
      `transaction ${transactionId} is already matched to payment ${tx.matchedPaymentId} — cannot re-match to payment ${paymentId}`,
    );
  }
  await db.update(transactions).set({ matchedPaymentId: paymentId }).where(eq(transactions.id, transactionId));
}

export async function listUnmatchedTransactions(): Promise<Transaction[]> {
  return db.select().from(transactions).where(isNull(transactions.matchedPaymentId));
}

export async function listPaymentsForPo(poId: number, dbClient: DbClient = db): Promise<Payment[]> {
  return dbClient.select().from(payments).where(eq(payments.poId, poId));
}

export async function listUnpaidPayments(dbClient: DbClient = db): Promise<Payment[]> {
  return dbClient.select().from(payments).where(eq(payments.paid, false));
}
