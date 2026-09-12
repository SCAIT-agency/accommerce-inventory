import path from "node:path";
import { fileURLToPath } from "node:url";
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

// In production the Vite dev proxy doesn't exist, so this server is the only
// thing serving the frontend. `pnpm build` emits the server bundle to
// dist/index.js and the client to dist/client/, so the client sits in
// ./client next to the running bundle. Mounted AFTER the API routes above so
// /api/* always wins; the fallback regex excludes /api/ so an unmatched API
// path still 404s as JSON-ish rather than silently returning the SPA shell.
if (process.env.NODE_ENV === "production") {
  const clientDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "client");
  app.use(express.static(clientDir));
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(path.join(clientDir, "index.html"));
  });
}

app.listen(ENV.port, () => {
  console.log(`accommerce-inventory listening on :${ENV.port}`);
});
