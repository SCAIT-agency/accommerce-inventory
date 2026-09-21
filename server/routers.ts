import { z } from "zod";
import { router, protectedProcedure, editorProcedure } from "./_core/trpc";
import { getHomeSummary, getStockDashboard, getMoneyDashboard } from "./dashboards";
import { getRemainingBatches } from "./inventoryLedger";
import { listSkus, createSku, updateSku, listVendors, createVendor, updateVendor, listWarehouses, createWarehouse, updateWarehouse } from "./db";
import { createPurchaseOrder, updatePurchaseOrderStatus, updatePurchaseOrderPlannedReadyDate, getPurchaseOrderWithLineItems, listPurchaseOrders } from "./purchaseOrders";
import { createShipment, updateShipmentPlannedDepartDate, markShipmentDeparted, updateShipmentStatus, setShipmentCustomsStatus, markShipmentArrived, correctShipmentActualDepartDate, correctShipmentReceiptQty, correctShipmentLandedCost, getShipmentWithLineItems, listShipments, listShipmentsForPo, recordShipmentCosts } from "./shipments";
import { createExpectedPayment, markPaymentPaid, correctPaymentAmount, recordTransaction, matchTransactionToPayment, listUnmatchedTransactions, listPaymentsForPo, listUnpaidPayments, listTransactions } from "./payments";
import { createSalesPlanEntry, getSalesVolatility, getPlanActualDeviation, upsertWeeklyInput, listWeeklyInputs } from "./salesPlan";
import { PO_STATUSES, SHIPMENT_STATUSES, CUSTOMS_STATUSES, SKU_IDENTIFIER_TYPES } from "../drizzle/schema";
import { MANUAL_REASON_CATEGORIES } from "../shared/constants";
import { listChangeLog } from "./changeLog";

// "data_correction" is reserved for the 3 correction procedures below
// (correctReceiptQty/correctLandedCost/correctAmount), which hardcode it
// server-side and don't accept a reasonCategory field at all — every OTHER
// procedure that takes a reasonCategory is an ordinary, first-time write and
// must use this narrower schema so an operator can't hand-pick
// "data_correction" there, which would make it indistinguishable from a real
// correction in change_log (see server/payments.ts's doc comment on
// correctPaymentAmount).
const manualReasonCategorySchema = z.enum(MANUAL_REASON_CATEGORIES);

// Non-negative, plain-decimal string (no exponent/scientific notation, no
// sign) — same shape as scripts/migrate-from-sheet.ts's DECIMAL_PATTERN with
// the leading `-?` dropped, since every field this guards (money/FX amounts)
// is non-negative by definition. Scoped to the three new correction
// procedures below, matching correctLedgerReceipt's own validation
// precedent (server/inventoryLedger.ts) at the router's input layer instead
// of leaving a malformed string to reach a `decimal` column as `"NaN"`.
const nonNegativeDecimalString = z.string().regex(/^\d+(\.\d+)?$/, "must be a non-negative number in plain decimal notation");

export const appRouter = router({
  dashboards: router({
    home: protectedProcedure.query(() => getHomeSummary()),
    stock: protectedProcedure.query(() => getStockDashboard()),
    money: protectedProcedure
      .input(z.object({
        from: z.date(),
        to: z.date(),
        skuId: z.number().optional(),
        warehouseId: z.number().optional(),
        shipmentId: z.number().optional(),
      }))
      .query(({ input }) => getMoneyDashboard(input.from, input.to, input)),
  }),
  inventoryLedger: router({
    remainingBatches: protectedProcedure
      .input(z.object({ skuId: z.number(), warehouseId: z.number() }))
      .query(({ input }) => getRemainingBatches(input.skuId, input.warehouseId)),
  }),
  catalog: router({
    listSkus: protectedProcedure.query(() => listSkus()),
    createSku: editorProcedure
      .input(z.object({
        sku: z.string().optional(),
        ssku: z.string().optional(),
        asin: z.string().optional(),
        ean: z.string().optional(),
        fnsku: z.string().optional(),
        name: z.string().optional(),
        primaryIdentifierType: z.enum(SKU_IDENTIFIER_TYPES),
      }).refine((input) => {
        const value = input[input.primaryIdentifierType];
        return typeof value === "string" && value.trim().length > 0;
      }, { message: "the field matching primaryIdentifierType must be provided and non-empty" }))
      .mutation(({ input }) => createSku(input)),
    updateSku: editorProcedure
      .input(z.object({
        id: z.number(),
        status: z.enum(["active", "inactive"]).optional(),
        leadTimeDays: z.number().int().positive().optional(),
        safetyStockDays: z.number().int().min(0).optional(),
      }))
      .mutation(({ input }) => updateSku(input.id, { status: input.status, leadTimeDays: input.leadTimeDays, safetyStockDays: input.safetyStockDays })),
    listVendors: protectedProcedure.query(() => listVendors()),
    createVendor: editorProcedure.input(z.object({ name: z.string() })).mutation(({ input }) => createVendor(input)),
    updateVendor: editorProcedure
      .input(z.object({ id: z.number(), name: z.string().optional(), contactEmail: z.string().optional(), notes: z.string().optional() }))
      .mutation(({ input }) => updateVendor(input.id, { name: input.name, contactEmail: input.contactEmail, notes: input.notes })),
    listWarehouses: protectedProcedure.query(() => listWarehouses()),
    createWarehouse: editorProcedure
      .input(z.object({ code: z.string(), name: z.string() }))
      .mutation(({ input }) => createWarehouse(input)),
    updateWarehouse: editorProcedure
      .input(z.object({ id: z.number(), code: z.string().optional(), name: z.string().optional() }))
      .mutation(({ input }) => updateWarehouse(input.id, { code: input.code, name: input.name })),
  }),
  purchaseOrders: router({
    list: protectedProcedure.query(() => listPurchaseOrders()),
    getWithLineItems: protectedProcedure.input(z.number()).query(({ input }) => getPurchaseOrderWithLineItems(input)),
    create: editorProcedure
      .input(z.object({
        poNumber: z.string(),
        vendorId: z.number(),
        lineItems: z.array(z.object({ skuId: z.number(), qty: z.number(), unitPrice: z.string(), currency: z.string() })),
      }))
      .mutation(({ input, ctx }) => createPurchaseOrder({ ...input, createdBy: ctx.user.id })),
    updateStatus: editorProcedure
      .input(z.object({ id: z.number(), newStatus: z.enum(PO_STATUSES), reasonCategory: manualReasonCategorySchema.optional(), reasonNote: z.string().optional() }))
      .mutation(({ input, ctx }) => updatePurchaseOrderStatus(input.id, input.newStatus, { ...input, changedBy: ctx.user.id })),
    updatePlannedReadyDate: editorProcedure
      .input(z.object({ id: z.number(), newDate: z.date(), reasonCategory: manualReasonCategorySchema, reasonNote: z.string().optional() }))
      .mutation(({ input, ctx }) =>
        updatePurchaseOrderPlannedReadyDate(input.id, input.newDate.toISOString().slice(0, 10), { ...input, changedBy: ctx.user.id }),
      ),
    history: protectedProcedure.input(z.number()).query(({ input }) => listChangeLog("purchase_order", input)),
  }),
  shipments: router({
    list: protectedProcedure.query(() => listShipments()),
    listForPo: protectedProcedure.input(z.number()).query(async ({ input }) => {
      const po = await getPurchaseOrderWithLineItems(input);
      return listShipmentsForPo(po.lineItems.map((li) => li.id));
    }),
    getWithLineItems: protectedProcedure.input(z.number()).query(({ input }) => getShipmentWithLineItems(input)),
    create: editorProcedure
      .input(z.object({
        shipmentRef: z.string(),
        warehouseId: z.number(),
        lineItems: z.array(z.object({ poLineItemId: z.number(), skuId: z.number(), qty: z.number(), weightShare: z.string(), valueShare: z.string() })),
      }))
      .mutation(({ input, ctx }) => createShipment({ ...input, createdBy: ctx.user.id })),
    updatePlannedDepartDate: editorProcedure
      .input(z.object({ id: z.number(), newDate: z.date(), reasonCategory: manualReasonCategorySchema, reasonNote: z.string().optional() }))
      .mutation(({ input, ctx }) => updateShipmentPlannedDepartDate(input.id, input.newDate, { ...input, changedBy: ctx.user.id })),
    markDeparted: editorProcedure
      .input(z.object({ id: z.number(), actualDate: z.date() }))
      .mutation(({ input, ctx }) => markShipmentDeparted(input.id, input.actualDate, { changedBy: ctx.user.id })),
    updateStatus: editorProcedure
      .input(z.object({
        id: z.number(),
        newStatus: z.enum(SHIPMENT_STATUSES),
        reasonCategory: manualReasonCategorySchema.optional(),
        reasonNote: z.string().optional(),
      }))
      .mutation(({ input, ctx }) =>
        updateShipmentStatus(input.id, input.newStatus, {
          changedBy: ctx.user.id,
          reasonCategory: input.reasonCategory,
          reasonNote: input.reasonNote,
        }),
      ),
    recordCosts: editorProcedure
      .input(z.object({
        id: z.number(),
        freightCost: z.string(),
        dutyCost: z.string(),
        costCurrency: z.string(),
        reasonCategory: manualReasonCategorySchema,
        reasonNote: z.string().optional(),
      }))
      .mutation(({ input, ctx }) =>
        recordShipmentCosts(
          input.id,
          { freightCost: input.freightCost, dutyCost: input.dutyCost, costCurrency: input.costCurrency },
          { reasonCategory: input.reasonCategory, reasonNote: input.reasonNote, changedBy: ctx.user.id },
        ),
      ),
    setCustomsStatus: editorProcedure
      .input(z.object({
        id: z.number(),
        newStatus: z.enum(CUSTOMS_STATUSES),
        reasonCategory: manualReasonCategorySchema,
        reasonNote: z.string().optional(),
      }))
      .mutation(({ input, ctx }) =>
        setShipmentCustomsStatus(input.id, input.newStatus, {
          changedBy: ctx.user.id,
          reasonCategory: input.reasonCategory,
          reasonNote: input.reasonNote,
        }),
      ),
    markArrived: editorProcedure
      .input(z.object({
        id: z.number(),
        actualArrivalDate: z.date(),
        reasonCategory: manualReasonCategorySchema,
        reasonNote: z.string().optional(),
      }))
      .mutation(({ input, ctx }) =>
        markShipmentArrived(input.id, input.actualArrivalDate, {
          changedBy: ctx.user.id,
          reasonCategory: input.reasonCategory,
          reasonNote: input.reasonNote,
        }),
      ),
    correctActualDepartDate: editorProcedure
      .input(z.object({
        id: z.number(),
        newDate: z.date(),
        reasonCategory: manualReasonCategorySchema,
        reasonNote: z.string().optional(),
      }))
      .mutation(({ input, ctx }) =>
        correctShipmentActualDepartDate(input.id, input.newDate, {
          changedBy: ctx.user.id,
          reasonCategory: input.reasonCategory,
          reasonNote: input.reasonNote,
        }),
      ),
    correctReceiptQty: editorProcedure
      .input(z.object({
        shipmentId: z.number(),
        lineItemId: z.number(),
        // nonnegative, not positive: correctLedgerReceipt documents qty: 0 as
        // a legitimate correction ("this shipment never actually arrived") —
        // positive() would silently make that unreachable through the only
        // API/UI path that exists for it.
        newQty: z.number().int().nonnegative(),
        reasonNote: z.string().min(1),
        allowNegativeSoh: z.boolean().optional(),
      }))
      .mutation(({ input, ctx }) =>
        correctShipmentReceiptQty(input.shipmentId, input.lineItemId, input.newQty, {
          changedBy: ctx.user.id,
          reasonNote: input.reasonNote,
          allowNegativeSoh: input.allowNegativeSoh,
        }),
      ),
    correctLandedCost: editorProcedure
      .input(z.object({
        shipmentId: z.number(),
        freightCost: nonNegativeDecimalString.optional(),
        dutyCost: nonNegativeDecimalString.optional(),
        reasonNote: z.string().min(1),
        allowNegativeSoh: z.boolean().optional(),
      }))
      .mutation(({ input, ctx }) =>
        correctShipmentLandedCost(
          input.shipmentId,
          { freightCost: input.freightCost, dutyCost: input.dutyCost },
          { changedBy: ctx.user.id, reasonNote: input.reasonNote, allowNegativeSoh: input.allowNegativeSoh },
        ),
      ),
    history: protectedProcedure.input(z.number()).query(({ input }) => listChangeLog("shipment", input)),
  }),
  payments: router({
    listForPo: protectedProcedure.input(z.number()).query(({ input }) => listPaymentsForPo(input)),
    listUnmatchedTransactions: protectedProcedure.query(() => listUnmatchedTransactions()),
    listTransactions: protectedProcedure.query(() => listTransactions()),
    listUnpaid: protectedProcedure.query(() => listUnpaidPayments()),
    createExpectedPayment: editorProcedure
      .input(z.object({
        poId: z.number().optional(),
        shipmentId: z.number().optional(),
        sequenceNo: z.number(),
        expectedAmount: z.string(),
        expectedDate: z.date(),
        currency: z.string(),
      }))
      .mutation(({ input }) => createExpectedPayment(input)),
    markPaid: editorProcedure
      .input(z.object({
        id: z.number(),
        amount: z.string(),
        fxRate: z.string(),
        paidDate: z.date(),
        reasonCategory: manualReasonCategorySchema,
        reasonNote: z.string().optional(),
      }))
      .mutation(({ input, ctx }) =>
        markPaymentPaid(input.id, {
          amount: input.amount,
          fxRate: input.fxRate,
          paidDate: input.paidDate,
          reasonCategory: input.reasonCategory,
          reasonNote: input.reasonNote,
          changedBy: ctx.user.id,
        }),
      ),
    correctAmount: editorProcedure
      .input(z.object({
        id: z.number(),
        amount: nonNegativeDecimalString,
        fxRate: nonNegativeDecimalString,
        paidDate: z.date(),
        reasonNote: z.string().min(1),
      }))
      .mutation(({ input, ctx }) =>
        correctPaymentAmount(input.id, {
          amount: input.amount,
          fxRate: input.fxRate,
          paidDate: input.paidDate,
          changedBy: ctx.user.id,
          reasonNote: input.reasonNote,
        }),
      ),
    recordTransaction: editorProcedure
      .input(z.object({
        date: z.date(),
        amount: z.string(),
        currency: z.string(),
        fxRate: z.string(),
        counterparty: z.string().optional(),
        description: z.string().optional(),
      }))
      .mutation(({ input }) => recordTransaction(input)),
    matchTransaction: editorProcedure
      .input(z.object({
        transactionId: z.number(),
        paymentId: z.number(),
        reasonCategory: manualReasonCategorySchema,
        reasonNote: z.string().optional(),
      }))
      .mutation(({ input, ctx }) =>
        matchTransactionToPayment(input.transactionId, input.paymentId, {
          reasonCategory: input.reasonCategory,
          reasonNote: input.reasonNote,
          changedBy: ctx.user.id,
        }),
      ),
    history: protectedProcedure.input(z.number()).query(({ input }) => listChangeLog("payment", input)),
  }),
  salesPlan: router({
    create: editorProcedure
      .input(z.object({ skuId: z.number(), warehouseId: z.number(), periodDate: z.date(), plannedQty: z.number() }))
      .mutation(({ input }) => createSalesPlanEntry({ ...input, periodDate: input.periodDate.toISOString().slice(0, 10) })),
    volatility: protectedProcedure
      .input(z.object({ skuId: z.number(), warehouseId: z.number(), weeks: z.number() }))
      .query(({ input }) => getSalesVolatility(input.skuId, input.warehouseId, input.weeks)),
    planActualDeviation: protectedProcedure
      .input(z.object({ skuId: z.number(), warehouseId: z.number(), from: z.date(), to: z.date() }))
      .query(({ input }) => getPlanActualDeviation(input.skuId, input.warehouseId, input.from.toISOString().slice(0, 10), input.to.toISOString().slice(0, 10))),
    listWeeklyInputs: protectedProcedure
      .input(z.object({ from: z.date(), to: z.date() }))
      .query(({ input }) => listWeeklyInputs(input.from.toISOString().slice(0, 10), input.to.toISOString().slice(0, 10))),
    upsertWeeklyInput: editorProcedure
      .input(z.object({
        weekStartDate: z.date(),
        plannedRevenue: z.string(),
        primaryWarehouseId: z.number(),
        primaryPercent: z.string(),
        secondaryWarehouseId: z.number(),
        recipeLines: z.array(z.object({ skuId: z.number(), unitsPer1000: z.string() })),
      }).refine((input) => input.primaryWarehouseId !== input.secondaryWarehouseId, {
        message: "primaryWarehouseId and secondaryWarehouseId must be different",
      }).refine((input) => new Set(input.recipeLines.map((l) => l.skuId)).size === input.recipeLines.length, {
        message: "recipeLines must not repeat the same SKU",
      }))
      .mutation(({ input }) => upsertWeeklyInput({ ...input, weekStartDate: input.weekStartDate.toISOString().slice(0, 10) })),
  }),
});

export type AppRouter = typeof appRouter;
