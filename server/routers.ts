import { z } from "zod";
import { router, protectedProcedure, editorProcedure } from "./_core/trpc";
import { getHomeSummary, getStockDashboard, getMoneyDashboard } from "./dashboards";
import { listSkus, createSku, listVendors, createVendor, listWarehouses, createWarehouse } from "./db";
import { createPurchaseOrder, updatePurchaseOrderStatus, updatePurchaseOrderPlannedReadyDate, getPurchaseOrderWithLineItems, listPurchaseOrders } from "./purchaseOrders";
import { createShipment, updateShipmentPlannedDepartDate, markShipmentDeparted, getShipmentWithLineItems, listShipments } from "./shipments";
import { REASON_CATEGORIES, PO_STATUSES } from "../drizzle/schema";
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
      .mutation(({ input, ctx }) => updatePurchaseOrderPlannedReadyDate(input.id, input.newDate, { ...input, changedBy: ctx.user.id })),
    history: protectedProcedure.input(z.number()).query(({ input }) => listChangeLog("purchase_order", input)),
  }),
  shipments: router({
    list: protectedProcedure.query(() => listShipments()),
    getWithLineItems: protectedProcedure.input(z.number()).query(({ input }) => getShipmentWithLineItems(input)),
    create: editorProcedure
      .input(z.object({
        shipmentRef: z.string(),
        lineItems: z.array(z.object({ poLineItemId: z.number(), skuId: z.number(), qty: z.number(), weightShare: z.string(), valueShare: z.string() })),
      }))
      .mutation(({ input, ctx }) => createShipment({ ...input, createdBy: ctx.user.id })),
    updatePlannedDepartDate: editorProcedure
      .input(z.object({ id: z.number(), newDate: z.date(), reasonCategory: reasonCategorySchema, reasonNote: z.string().optional() }))
      .mutation(({ input, ctx }) => updateShipmentPlannedDepartDate(input.id, input.newDate, { ...input, changedBy: ctx.user.id })),
    markDeparted: editorProcedure
      .input(z.object({ id: z.number(), actualDate: z.date() }))
      .mutation(({ input, ctx }) => markShipmentDeparted(input.id, input.actualDate, { changedBy: ctx.user.id })),
    history: protectedProcedure.input(z.number()).query(({ input }) => listChangeLog("shipment", input)),
  }),
});

export type AppRouter = typeof appRouter;
