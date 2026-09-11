import express from "express";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { loadEnv } from "./env";
import { router } from "./trpc";
import { createContext } from "./context";

// Load env vars
const env = loadEnv();

const app = express();
app.use(express.json());
app.use(
  "/api/trpc",
  createExpressMiddleware({
    router: router({}),
    createContext,
  }),
);

app.listen(env.port, () => {
  console.log(`accommerce-inventory listening on :${env.port}`);
});
