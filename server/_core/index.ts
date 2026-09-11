import express from "express";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { ENV } from "./env";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { mountAuthRoutes } from "./authRoutes";

const app = express();
app.use(express.json());
mountAuthRoutes(app);
app.use(
  "/api/trpc",
  createExpressMiddleware({
    router: appRouter,
    createContext,
  }),
);

app.listen(ENV.port, () => {
  console.log(`accommerce-inventory listening on :${ENV.port}`);
});
