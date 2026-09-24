import { Link } from "react-router-dom";
import { trpc } from "../lib/trpc";

interface StatCardProps {
  to: string;
  label: string;
  value: string;
  tone?: "critical" | "warning";
}

// The rest of this app already has a real design system (client/src/index.css,
// Stream K) — this is an extension of it (same CSS custom properties), not a
// competing one. Home was the one page that never got any layout treatment
// beyond bare <dl> markup, which is why it looked unfinished next to
// Stock/Shipments/Purchase Orders.
function StatCard({ to, label, value, tone }: StatCardProps) {
  return (
    <Link
      to={to}
      style={{
        display: "block",
        padding: "16px 18px",
        background: "var(--surface-raised)",
        border: "1px solid var(--border)",
        borderRadius: "8px",
        textDecoration: "none",
        color: "inherit",
      }}
    >
      <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
        {label}
      </div>
      <div
        style={{
          fontSize: "28px",
          fontWeight: 600,
          fontFamily: "var(--font-data)",
          marginTop: "6px",
          color: tone === "critical" ? "var(--critical)" : tone === "warning" ? "var(--warning)" : "var(--ink)",
        }}
      >
        {value}
      </div>
    </Link>
  );
}

export function HomePage() {
  const { data, isLoading, error } = trpc.dashboards.home.useQuery();
  if (error) return <div>Failed to load: {error.message}</div>;
  if (isLoading || !data) return <div>Loading…</div>;
  return (
    <div>
      <h1>Home</h1>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          gap: "12px",
        }}
      >
        <StatCard to="/catalog" label="Active SKUs" value={String(data.activeSkuCount)} />
        <StatCard
          to="/stock"
          label="Stockout-risk SKUs"
          value={String(data.stockoutRiskSkuCount)}
          tone={data.stockoutRiskSkuCount > 0 ? "critical" : undefined}
        />
        <StatCard to="/money" label="Near-term cash needs (14d)" value={data.nearTermCashNeeds.toFixed(2)} />
        <StatCard
          to="/money"
          label="Overdue payables"
          value={`${data.overduePayablesIsEstimated ? "≈ " : ""}${data.overduePayablesAmount.toFixed(2)}`}
          tone={data.overduePayablesAmount > 0 ? "warning" : undefined}
        />
        <StatCard to="/transactions" label="Unmatched transactions" value={String(data.unmatchedTransactionCount)} />
      </div>
    </div>
  );
}
