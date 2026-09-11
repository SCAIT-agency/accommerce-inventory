import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import { trpc } from "./lib/trpc";
import { AppNav } from "./components/nav/AppNav";
import { HomePage } from "./pages/HomePage";
import { StockPage } from "./pages/StockPage";
import { PurchaseOrdersPage } from "./pages/PurchaseOrdersPage";
import { ShipmentsPage } from "./pages/ShipmentsPage";

const queryClient = new QueryClient();
const trpcClient = trpc.createClient({
  links: [httpBatchLink({ url: "/api/trpc", transformer: superjson })],
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <AppNav />
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/stock" element={<StockPage />} />
            <Route path="/purchase-orders" element={<PurchaseOrdersPage />} />
            <Route path="/shipments" element={<ShipmentsPage />} />
          </Routes>
        </BrowserRouter>
      </QueryClientProvider>
    </trpc.Provider>
  </React.StrictMode>,
);
