import { trpc } from "../lib/trpc";

export function HomePage() {
  const { data, isLoading, error } = trpc.dashboards.home.useQuery();
  if (error) return <div>Failed to load: {error.message}</div>;
  if (isLoading || !data) return <div>Loading…</div>;
  return (
    <div>
      <h1>Home</h1>
      <dl>
        <dt>Active SKUs</dt><dd>{data.activeSkuCount}</dd>
        <dt>Stockout-risk SKUs</dt><dd>{data.stockoutRiskSkuCount}</dd>
        <dt>Near-term cash needs (14d)</dt><dd>{data.nearTermCashNeeds.toFixed(2)}</dd>
        <dt>Overdue payables</dt><dd>{data.overduePayablesIsEstimated ? "≈ " : ""}{data.overduePayablesAmount.toFixed(2)}</dd>
        <dt>Unmatched transactions</dt><dd>{data.unmatchedTransactionCount}</dd>
      </dl>
    </div>
  );
}
