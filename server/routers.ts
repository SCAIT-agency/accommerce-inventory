import { z } from "zod";
import { router, protectedProcedure, editorProcedure } from "./_core/trpc";
import { getHomeSummary, getStockDashboard, getMoneyDashboard } from "./dashboards";
import { listSkus, createSku, listVendors, createVendor, listWarehouses, createWarehouse } from "./db";
import { createPurchaseOrder, updatePurchaseOrderStatus, updatePurchaseOrderPlannedReadyDate, getPurchaseOrderWithLineItems, listPurchaseOrders } from "./purchaseOrders";
import { createShipment, updateShipmentPlannedDepartDate, markShipmentDeparted, updateShipmentStatus, setShipmentCustomsStatus, markShipmentArrived, correctShipmentActualDepartDate, getShipmentWithLineItems, listShipments, listShipmentsForPo, recordShipmentCosts } from "./shipments";
import { createExpectedPayment, markPaymentPaid, recordTransaction, matchTransactionToPayment, listUnmatchedTransactions, listPaymentsForPo, listUnpaidPayments } from "./payments";
import { createSalesPlanEntry, getSalesVolatility, getPlanActualDeviation } from "./salesPlan";
import { REASON_CATEGORIES, PO_STATUSES, SHIPMENT_STATUSES, CUSTOMS_STATUSES } from "../drizzle/schema";
import { listChangeLog } from "./changeLog";

const reasonCategorySchema = z.enum(REASON_CATEGORIES);

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
  catalog: router({
    listSkus: protectedProcedure.query(() => listSkus()),
    createSku: editorProcedure
      .input(z.object({ sku: z.string().optional(), name: z.string().optional(), primaryIdentifierType: z.string() }))
      .mutation(({ input }) => createSku(input as any)),
    listVendors: protectedProcedure.query(() => listVendors()),
    createVendor: editorProcedure.input(z.object({ name: z.string() })).mutation(({ input }) => createVendor(input)),
    listWarehouses: protectedProcedure.query(() => listWarehouses()),
    createWarehouse: editorProcedure
      .input(z.object({ code: z.string(), name: z.string() }))
      .mutation(({ input }) => createWarehouse(input)),
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
      .input(z.object({ id: z.number(), newStatus: z.enum(PO_STATUSES), reasonCategory: reasonCategorySchema.optional(), reasonNote: z.string().optional() }))
      .mutation(({ input, ctx }) => updatePurchaseOrderStatus(input.id, input.newStatus, { ...input, changedBy: ctx.user.id })),
    updatePlannedReadyDate: editorProcedure
      .input(z.object({ id: z.number(), newDate: z.date(), reasonCategory: reasonCategorySchema, reasonNote: z.string().optional() }))
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
      .input(z.object({ id: z.number(), newDate: z.date(), reasonCategory: reasonCategorySchema, reasonNote: z.string().optional() }))
      .mutation(({ input, ctx }) => updateShipmentPlannedDepartDate(input.id, input.newDate, { ...input, changedBy: ctx.user.id })),
    markDeparted: editorProcedure
      .input(z.object({ id: z.number(), actualDate: z.date() }))
      .mutation(({ input, ctx }) => markShipmentDeparted(input.id, input.actualDate, { changedBy: ctx.user.id })),
    updateStatus: editorProcedure
      .input(z.object({
        id: z.number(),
        newStatus: z.enum(SHIPMENT_STATUSES),
        reasonCategory: reasonCategorySchema.optional(),
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
        reasonCategory: reasonCategorySchema,
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
        reasonCategory: reasonCategorySchema,
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
        reasonCategory: reasonCategorySchema,
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
        reasonCategory: reasonCategorySchema,
        reasonNote: z.string().optional(),
      }))
      .mutation(({ input, ctx }) =>
        correctShipmentActualDepartDate(input.id, input.newDate, {
          changedBy: ctx.user.id,
          reasonCategory: input.reasonCategory,
          reasonNote: input.reasonNote,
        }),
      ),
    history: protectedProcedure.input(z.number()).query(({ input }) => listChangeLog("shipment", input)),
  }),
  payments: router({
    listForPo: protectedProcedure.input(z.number()).query(({ input }) => listPaymentsForPo(input)),
    listUnmatchedTransactions: protectedProcedure.query(() => listUnmatchedTransactions()),
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
        reasonCategory: reasonCategorySchema,
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
      .input(z.object({ transactionId: z.number(), paymentId: z.number() }))
      .mutation(({ input }) => matchTransactionToPayment(input.transactionId, input.paymentId)),
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
  }),
});

export type AppRouter = typeof appRouter;
