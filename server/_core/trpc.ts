import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";

const t = initTRPC.context<TrpcContext>().create({ transformer: superjson });

export const router = t.router;
export const publicProcedure = t.procedure;
export { t };

export type AppRouter = ReturnType<typeof router>;

const requireUser = t.middleware(async ({ ctx, next }) => {
  if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED" });
  return next({ ctx: { ...ctx, user: ctx.user } });
});

export const protectedProcedure = t.procedure.use(requireUser);

export const editorProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  if (ctx.user.role !== "editor") throw new TRPCError({ code: "FORBIDDEN" });
  return next({ ctx });
});
