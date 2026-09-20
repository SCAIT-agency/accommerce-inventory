import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import { BrowserRouter, Routes, Route, useParams, Navigate, Outlet } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import { trpc } from "./lib/trpc";
import { AppNav } from "./components/nav/AppNav";
import { HomePage } from "./pages/HomePage";
import { StockPage } from "./pages/StockPage";
import { PurchaseOrdersPage } from "./pages/PurchaseOrdersPage";
import { ShipmentsPage } from "./pages/ShipmentsPage";
import { MoneyPage } from "./pages/MoneyPage";
import { TransactionsPage } from "./pages/TransactionsPage";
import { ChangeLogPage } from "./pages/ChangeLogPage";
import { InventoryLedgerPage } from "./pages/InventoryLedgerPage";
import { LoginPage } from "./pages/LoginPage";

// Without this guard every protected page just renders "Failed to load:
// UNAUTHORIZED" forever, with no way for the user to discover they need to
// sign in. Checked once when the guarded layout mounts; it stays mounted
// across navigations between guarded routes, so this is not per-page.
function RequireAuth() {
  const [status, setStatus] = useState<"checking" | "authenticated" | "anonymous" | "unavailable">("checking");

  useEffect(() => {
    let cancelled = false;

    function checkStatus() {
      fetch("/api/auth/status", { credentials: "include" })
        .then(async (res) => {
          if (cancelled) return;
          if (res.status === 503) {
            // A transient failure on the very first check blocks entry with
            // a clear message; the same failure on a later periodic
            // re-check must not kick an already-authenticated user out —
            // leave their current status alone and try again next tick.
            setStatus((prev) => (prev === "checking" ? "unavailable" : prev));
            return;
          }
          const data = await res.json();
          setStatus(data.authenticated ? "authenticated" : "anonymous");
        })
        .catch(() => {
          setStatus((prev) => (prev === "checking" ? "anonymous" : prev));
        });
    }

    checkStatus();
    // Mid-session revocation (sign-out elsewhere, a password reset) is a
    // real, expected event now that sessions carry a tokenVersion — without
    // a periodic re-check, a revoked session renders "Failed to load:
    // UNAUTHORIZED" on every guarded page instead of redirecting to /login,
    // until the user happens to navigate in a way that remounts this guard.
    const intervalId = setInterval(checkStatus, 5 * 60 * 1000);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, []);

  if (status === "checking") return <div>Checking sign-in…</div>;
  if (status === "unavailable") return <div>Temporarily unavailable — please try again shortly.</div>;
  if (status === "anonymous") return <Navigate to="/login" replace />;
  return (
    <>
      <AppNav />
      <Outlet />
    </>
  );
}

function ChangeLogRoute() {
  const { entityType, entityId } = useParams<{ entityType: "purchase_order" | "shipment"; entityId: string }>();
  if (entityType !== "purchase_order" && entityType !== "shipment") return <div>Unknown entity type</div>;
  const id = Number(entityId);
  if (!entityId || Number.isNaN(id)) return <div>Invalid entity id</div>;
  return <ChangeLogPage entityType={entityType} entityId={id} />;
}

function InventoryLedgerRoute() {
  const { skuId, warehouseId } = useParams<{ skuId: string; warehouseId: string }>();
  const parsedSkuId = Number(skuId);
  const parsedWarehouseId = Number(warehouseId);
  if (!skuId || !warehouseId || Number.isNaN(parsedSkuId) || Number.isNaN(parsedWarehouseId)) {
    return <div>Invalid SKU or warehouse id</div>;
  }
  return <InventoryLedgerPage skuId={parsedSkuId} warehouseId={parsedWarehouseId} />;
}

const queryClient = new QueryClient();
const trpcClient = trpc.createClient({
  links: [httpBatchLink({ url: "/api/trpc", transformer: superjson })],
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route element={<RequireAuth />}>
              <Route path="/" element={<HomePage />} />
              <Route path="/stock" element={<StockPage />} />
              <Route path="/purchase-orders" element={<PurchaseOrdersPage />} />
              <Route path="/shipments" element={<ShipmentsPage />} />
              <Route path="/money" element={<MoneyPage />} />
              <Route path="/transactions" element={<TransactionsPage />} />
              <Route path="/change-log/:entityType/:entityId" element={<ChangeLogRoute />} />
              <Route path="/inventory-ledger/:skuId/:warehouseId" element={<InventoryLedgerRoute />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </QueryClientProvider>
    </trpc.Provider>
  </React.StrictMode>,
);
