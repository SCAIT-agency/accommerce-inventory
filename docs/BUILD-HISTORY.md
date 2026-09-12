# Build History — V1 Skeleton

This is the reconstructed build log for `accommerce-inventory`'s V1 skeleton: what was built, in what order, and — more importantly — every real bug found along the way and how it was fixed. The original session ledger (a live working log kept during the build) was deleted once the branch was finished per process; this document exists so that history isn't lost, reconstructed from git commit messages (which were written to be self-contained) plus the review conversation.

Full detail for *why* each design choice was made lives in [`spec.md`](./spec.md) (the design spec) and [`plan-v1.md`](./plan-v1.md) (the task-by-task implementation plan this build followed). This document is the *what happened*, not the *what was intended*.

## Method

Built via Claude Code's subagent-driven-development process: a fresh implementer subagent per task, a dedicated reviewer subagent after each task (spec compliance + code quality), a fix-and-re-review loop for any Important/Critical finding, then one whole-branch review at the end covering things no single task's reviewer could see. Every task below either passed review clean or went through at least one fix round before being marked complete — nothing shipped with a known Important/Critical defect left open.

## Task-by-Task

**Task 1 — Repo bootstrap.** Express/tRPC/Vite/Vitest scaffold, env loading with fail-fast validation. Fix round: reverted an unnecessary try/catch around `ENV` that would have hidden config errors instead of throwing; fixed a `pnpm-workspace.yaml` placeholder that would have broken a clean install; root-caused a `vitest` cache-busting pattern that doesn't work reliably in this project's actual Vite/Vitest setup, replaced with `vi.resetModules()`.

**Task 2 — Auth primitives.** JWT session tokens, `protectedProcedure`/`editorProcedure` tRPC middleware, cookie-based context. The plan asked this task to also mount the real `/api/auth/*` HTTP routes, but those need the `users` table, which doesn't exist until Task 3 — deferred that piece to Task 3 rather than force a broken ordering.

**Task 3 — Core schema + auth routes.** `users`/`app_settings`/`skus`/`vendors`/`warehouses` tables, plus the `/api/auth/*` routes deferred from Task 2 (password check → list identities → select → session cookie → logout → status). Fix round: the auth routes' DB calls had no error handling — Express 4 doesn't auto-catch async route rejections, so a DB hiccup could hang a request or crash the whole process (taking `/api/trpc` down with it). Added try/catch, verified live by pointing `DATABASE_URL` at a nonexistent host and confirming a clean error instead of a hang.

**Task 4 — `change_log` + `logChange()`.** The generic audit-trail table and helper every later mutating entity uses, with the `reason_category` taxonomy (production delay, artwork delay, customs hold, logistics delay, payment timing, vendor price change, freight rate change, holiday/capacity, other — free-text note required only for "other").

**Task 5 — Purchase Orders.** Status pipeline (draft → confirmed → in production → shipped → customs → delivered → closed) as a lookup table, not branching logic. Planned-ready-date changes require a reason category and log the real prior value.

**Task 6 — Shipments.** Pooled-container SKU-share line items (one shipment can carry a partial, weight/value-allocated share of a PO line item — real Jello containers mix multiple orders). Fix round: `recordShipmentCosts` wrote freight/duty costs with **no audit trail at all** — a real gap against the binding rule that every cost-affecting field change on a Shipment must be logged with a reason; and `markShipmentDeparted` was logging a hardcoded `null` as the "old value" instead of the shipment's real prior departure date. Both fixed and covered by new tests.

**Task 7 — Payments + Transactions.** `fx_rate` captured only at the moment of actual payment (never a standing rate). Fix round: same class of bug as Task 6 — `markPaymentPaid` updated `fxRate`/`paidAmount`/`baseCurrencyAmount` in one write but only audited the `paid` boolean flip, and had no `reason_category` at all despite the schema having a `payment_timing` category built for exactly this case. Fixed to audit all three fields with real prior values.

**Task 8 — `inventory_ledger` + SOH.** The append-only table that is the single source of truth for stock — SOH is always computed live from this table, never stored. Composite index on `(sku_id, warehouse_id, date)` for scale. One real MySQL/Drizzle gotcha found and fixed: `SUM()` over an integer column returns as a JS *string* via the driver used here unless explicitly cast, which would have silently broken every numeric comparison downstream.

**Task 9 — FIFO landed-cost engine.** Pure-function FIFO consumption (oldest batch first) plus per-shipment-line landed unit cost allocation. Fix round: a shipment line item with `qty <= 0` (no positivity constraint existed upstream) would silently produce `Infinity` in a landed-cost figure headed straight for the Money dashboard — added a guard that throws instead.

**Task 10 — Sales plan/actuals, volatility, Daily COGS.** Daily COGS computed as *cumulative-cost-through-today minus cumulative-cost-through-yesterday* — deliberately not per-day-in-isolation, because that's the exact bug class the real Jello Control Tower shipped and had to fix in production. Fix round: `getSalesVolatility` was silently returning the *oldest* N weeks of history instead of the most recent N — a query missing a `desc()` — meaning volatility would freeze on stale data forever once real history exceeded the lookback window.

**Task 11 — Cashflow forecast.** Caught before implementation even started: the plan's own sample code filtered by `expectedDate` for both planned and actual figures, which would silently drop a real payment from `actualOutflow` if it was paid within the query window but originally expected outside it. Rewrote as two independent queries (planned by expected date, actual by paid date) before dispatching the task.

**Task 12 — Daily Shopify pull.** Parses and sums a raw export by SKU+warehouse+date, writes through the same validated `recordSalesActual` path as manual entry — no separate, less-trusted path for automated data.

**Task 13 — Dashboards + tRPC router.** Wired everything into `getHomeSummary`/`getStockDashboard`/`getMoneyDashboard` and the real `appRouter`. Caught before dispatch: the spec commits the V1 Stock dashboard to "SOH, days-of-cover, status thresholds," but the plan's sample code only returned raw SOH — added the days-of-cover calculation (trailing average daily sales → days remaining → critical/low/ok/overstock bucket) before the task even started, and fixed the Home dashboard's stockout-risk count to compare real days-of-cover instead of comparing raw stock units against a day-count threshold (a real unit-mismatch bug in the original sample).

**Task 14 — Frontend shell (Home + Stock).** First frontend task. Two real gaps found before dispatch: `react-router-dom` was never added as a dependency, and the client's tRPC link had no `transformer: superjson` to match the server (would have broken every `Date` field returned by any query). Found live during verification: `vite.config.ts` had no `root`, so the dev server 404'd on every single route — fixed. Fix round: neither page checked `useQuery`'s `error` field, so any real failure (auth expiry, a 500) left the UI stuck on "Loading…" forever with no signal — added error-before-loading to both.

**Task 15 — Purchase Orders + Shipments pages.** Applied the error-before-loading fix from Task 14 to every new query. Found and fixed live: the plan's sample code used one shared `useState` for the reason-category/date/note inputs across the *entire* PO table — meaning editing one row's dropdown visually changed every other row's dropdown too. Moved to per-row state.

**Task 16 — Money section + Change Log.** Found that the router never got a `shipments.list` procedure at all (Task 13 built `getWithLineItems`/`create`/etc. but nothing to enumerate shipments) — without it, the Money page's Landed Cost tab could never get a real shipment to show, and the Shipments page was stuck on a dead stub. Added it. Found live: `MoneyPage`'s inline `new Date(...)` was recomputed fresh on every render, which kept invalidating React Query's cache key and left the page stuck loading forever — fixed via `useMemo`.

**Task 16b — Payments/shipment-cost router (added mid-plan, not in the original 19-task document).** Two independent code reviews confirmed a real usability dead end: the `payments` domain (Task 7) and `recordShipmentCosts` (Task 6) had zero tRPC exposure — no real user could create a payment, mark one paid, or record a shipment's freight/duty cost through the app, only via direct SQL. Added the missing router procedures and a minimal UI (per-shipment cost form, per-PO payment creation/mark-paid). Fix round: the new payment-creation flow didn't invalidate the Money dashboard's cache, so a payment created while Money was already open wouldn't show up until an unrelated remount.

**Task 17 — Migration script.** `transformSheetExport`/`reconcileMigration` (pure, dependency-injected, reports *every* mismatch, never stops at the first) plus `runMigration` (the imperative driver). Sale quantities normalized to negative via `-Math.abs()` regardless of how the source Sheet encodes the sign, so the migration is robust either way.

**Task 18 — Parallel-run comparison report.** Delegates to Task 17's reconciliation logic; `safeToCutOver` is only ever `true` on zero mismatches. Fix round: an *empty* input snapshot also produced zero mismatches — meaning the gate would report "safe to cut over" on a comparison that validated nothing (e.g. if the real Sheet fetch silently failed). Now throws instead.

**Task 19 — Deploy runbook + nightly export (final planned task).** `generateCsvExport` (RFC 4180-style escaping) and `runNightlyExport`, writing one CSV per core table. Fix round: the escaping didn't cover embedded newlines — a real risk given several free-text columns (vendor notes, change-log reason notes) — fixed. `RAILWAY.md` referenced a cron wrapper script that didn't exist; created it, and in doing so found the documented `node --experimental-strip-types` command doesn't actually work against this repo's extensionless relative imports (switched to `pnpm exec tsx`), and that the script never exited on its own because the MySQL connection pool keeps the process alive (added `process.exit(0)`) — both would have made the documented nightly cron job hang or fail on Railway.

## Final Whole-Branch Review

After all 20 tasks, one broad review pass looked across task boundaries for things no single task's reviewer could see. Result: **3 Critical, 13 Important, ~15 Minor findings.**

The 3 Critical findings were genuinely severe — despite every individual piece being correctly built and tested in isolation, the assembled system had no way for an actual human to use it:
- **No login UI and no way to create the first user** — the backend auth flow worked, but nothing in the React app ever called it, and no code path could create a `users` row at all.
- **The production server never served the built frontend** — `pnpm start` ran an API with no UI behind it; the dev-only Vite proxy doesn't exist in production.
- **The Home dashboard's cash-risk figure silently summed payments in different currencies** into one wrong number, with no warning.

Of the 13 Important findings, the review explicitly separated them into "fix now" and "real, but a deliberate follow-up" — see [`BACKLOG.md`](./BACKLOG.md) for the full list and current status of each.

## Fix Wave + Residual

One fix wave addressed the 3 Critical findings plus 3 of the Important ones chosen as directly undermining the shipped product's own stated purpose (login/deploy/currency correctness, a documented-but-broken test command, a real wrong-number bug in the Stock dashboard's headline metric, and the Stock dashboard silently dropping data it already computed). Each fix was independently re-verified — live browser logins, a real `pnpm build` + production server boot, forced-parallel test runs to reproduce the original race, hand-computed regression math — not just re-reading the diff.

The scoped re-review of that fix wave found one residual: the per-bucket currency guard fixed the reported Cashflow bug, but the Home dashboard's *cross-day* sum of multiple currency-clean buckets could still silently blend currencies one level up. Rather than leave that open, the fix was extended once more (at the user's explicit request, not a second automated fix wave) to make the currency-consistency check apply across the *entire* queried range instead of per-day — closing the finding by construction rather than patching each caller separately.

All other Important and Minor findings were deliberately **not** fixed in this round — not silently dropped, tracked in [`BACKLOG.md`](./BACKLOG.md).

## Final State

- 20 tasks complete (19 from the original plan + Task 16b), each individually reviewed.
- Test suite: 65 tests, 16 files, passing on the plain documented `pnpm test` command (this was itself one of the fixes — the suite silently required a `--no-file-parallelism` flag for the entire build before that was fixed).
- Repository: [github.com/Artem-SCM-AI/accommerce-inventory](https://github.com/Artem-SCM-AI/accommerce-inventory) (private).
- No known open Critical or Important defect in what shipped. A substantial, explicitly-scoped backlog remains for making V1 production-ready against real client data — see `BACKLOG.md`.
