import { Link } from "react-router-dom";
import { trpc } from "../lib/trpc";

export function HomePage() {
  const { data, isLoading, error } = trpc.dashboards.home.useQuery();
  if (error) return <div>Failed to load: {error.message}</div>;
  if (isLoading || !data) return <div>Loading…</div>;
  return (
    <div>
      <h1>Home</h1>
      <dl>
        <dt><Link to="/catalog">Active SKUs</Link></dt><dd>{data.activeSkuCount}</dd>
        <dt><Link to="/stock">Stockout-risk SKUs</Link></dt><dd>{data.stockoutRiskSkuCount}</dd>
        <dt><Link to="/money">Near-term cash needs (14d)</Link></dt><dd>{data.nearTermCashNeeds.toFixed(2)}</dd>
        <dt><Link to="/money">Overdue payables</Link></dt><dd>{data.overduePayablesIsEstimated ? "≈ " : ""}{data.overduePayablesAmount.toFixed(2)}</dd>
        <dt><Link to="/transactions">Unmatched transactions</Link></dt><dd>{data.unmatchedTransactionCount}</dd>
      </dl>
    </div>
  );
}
