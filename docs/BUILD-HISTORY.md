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

## Final State (V1)

- 20 tasks complete (19 from the original plan + Task 16b), each individually reviewed.
- Test suite: 65 tests, 16 files, passing on the plain documented `pnpm test` command (this was itself one of the fixes — the suite silently required a `--no-file-parallelism` flag for the entire build before that was fixed).
- Repository: [github.com/Artem-SCM-AI/accommerce-inventory](https://github.com/Artem-SCM-AI/accommerce-inventory) (private).
- No known open Critical or Important defect in what shipped. A substantial, explicitly-scoped backlog remains for making V1 production-ready against real client data — see `BACKLOG.md`.

---

# Build History — Backlog Stream B: Migration & Cutover Readiness

Built 2026-09-12 to 2026-09-14, directly on `main` (this repo has no branch/worktree workflow — same convention as V1). Design spec: [`2026-09-12-migration-cutover-readiness-design.md`](./2026-09-12-migration-cutover-readiness-design.md). Plan: [`superpowers/plans/2026-09-12-migration-cutover-readiness.md`](./superpowers/plans/2026-09-12-migration-cutover-readiness.md). This is preparatory hardening — **not** a real migration against real Jello/Accommerce data, which remains a separate, later, explicitly-gated decision.

## Method

Same subagent-driven-development process as V1: a fresh implementer subagent per task, a dedicated reviewer subagent after each task, a fix-and-re-review loop for any Important/Critical finding, then one whole-branch review at the end. Baseline before Task 1: 65/65 tests green.

## Task-by-Task

**Task 1 — SKU identifier uniqueness.** Composite unique constraint on `skus(primaryIdentifierType, identifierValue)` via a generated column. Fix round: the migration files `db:push` generated weren't committed (a repo convention this task's own review had to catch); the constraint as first written was bypassable by two rows with the same `primaryIdentifierType` and no value in the corresponding column (both generate `identifierValue = NULL`, and MySQL treats NULLs in a unique index as distinct) — closed by marking the generated column `NOT NULL`.

**Task 2 — Vendor reference + migration-only initial status.** Nullable `vendorReference` on Purchase Orders/Shipments, plus an `initialStatus` escape hatch (used only by migration, never exposed via any router) letting the eventual migration set a real historical status directly instead of always starting at `draft`/`planned`. **Real bug found mid-task, not by trusting the implementer's own report:** the implementer's `db:push` run silently dropped Task 1's composite unique constraint down to a broken single-column one — a MySQL/drizzle-kit quirk where regenerating a STORED generated column drops a dependent constraint without drizzle-kit re-emitting it. The implementer's own report mischaracterized the resulting test failures as "2 pre-existing unrelated" — caught by independently running `SHOW CREATE TABLE` rather than trusting that claim, fixed with a corrective migration.

**Task 3 — Negative-stock validation.** `recordLedgerEvent` throws before writing an event that would drive SOH negative. Implementer hit a session rate limit mid-task; resumed the same agent from its real partial work (correct failing tests already written) once the window passed, rather than restarting. Review: Approved, one Important plan-mandated finding (the date-scoped check only correctly handles chronologically-ordered inserts) carried forward as a binding requirement for the later migration tasks.

**Task 4 — Referential integrity (real foreign keys).** 10 FKs on core ownership edges (PO/shipment line items, payments, transactions, inventory ledger) — previously zero existed anywhere. Required a clean local dev DB reset first. **A second real bug found during this task**, again by not trusting an implementer's "pre-existing, unrelated flake" characterization: `inventory_ledger.date` was a MySQL `TIMESTAMP(0)` (second-precision) column that *rounds* a fractional-second value on insert, compared via `lte()` against a raw, unrounded query parameter — so a receipt and a same-second sale could land on opposite sides of a rounding boundary, silently excluding the receipt from its own SOH-as-of check and (combined with Task 3's new guard) rejecting a legitimate write. Root-caused via a live DB inspection and a standalone reproduction script, confirmed present at the pre-Task-4 commit too (via a temporary git worktree) — fixed with `timestamp(3)` (millisecond precision). One further fix round: the FK-safe test cleanup pattern (`SET FOREIGN_KEY_CHECKS = 0/1` across 10 test files) had no `try/finally`, so one failing delete would leave FK enforcement silently disabled for the rest of that connection's life.

**Task 5 — Shipment status state machine.** `VALID_SHIPMENT_TRANSITIONS`, mirroring the existing PO pattern; `markShipmentDeparted` now validated through it instead of hard-setting status. Not exposed via any router in this task. Fix round: a real test-coverage gap (no test exercised the new transition-table branch specifically, both existing tests hit an older guard first). One finding ruled out of scope rather than fixed: the new transition table permanently closes the "call `markShipmentDeparted` twice to fix a wrong date" path with no replacement built — a deliberate scope boundary for hardening-only work, flagged forward to Backlog Stream A.

**Task 6 — Already-matched-transaction guard.** App-level check in `matchTransactionToPayment` (the FK from Task 4 only catches a reference to a payment that doesn't exist at all, not "already matched to a different payment"). Fix round: a nonexistent transaction ID crashed with an opaque `TypeError` instead of a clear error — closed with an explicit existence check.

**Task 7 — Migration transform functions.** Pure transforms (`transformPurchaseOrders`/`transformShipments`/`transformPayments`/`transformTransactions`) converting raw Sheet-row shapes into typed objects Task 8 consumes by exact field name — reviewed with extra scrutiny on field-name fidelity since Task 8 was already written against these exact names. Two fix rounds: `parseFloat`/`parseInt` accepted leading-numeric garbage (`"123abc"` → `123`) instead of quarantining across all four transforms (plus a second round after the fix initially missed `transformTransactions`, caught by the implementer itself flagging the scope gap rather than silently leaving it).

**Task 8 — Widen `runMigration`.** The biggest task: full PO/Shipment/Payment/Transaction scope, wrapped in one atomic DB transaction. Resolved a placeholder the plan had deliberately left open (how to migrate a shipment's historical freight/duty costs without `recordShipmentCosts`'s audit-trail requirement) before dispatch, rather than leaving it for the implementer to invent. Implementer self-reported and the reviewer independently verified a genuinely necessary architectural finding: Drizzle's `db.transaction()` provides a scoped client, and any write going through the outer pool-backed client instead doesn't participate in the transaction at all — required threading an optional `dbClient` parameter through 9 functions across 5 files to make the atomicity guarantee real rather than illusory. Approved clean, no fix round.

**Task 9 — Landed-cost tolerance reconciliation.** Tolerance-based check (greater of $0.01 or 0.1%) alongside the existing exact-match SOH check. Deliberately built the machinery without wiring it to real data (real Sheet landed-cost columns are unknown) — approved clean.

**Task 10 — CLI entrypoints (final planned task).** `scripts/run-migration.mjs`/`run-parallel-check.mjs`. Implementer caught that the plan's own sample code for the parallel-check script was stale (assumed `deps`, a function-containing object, could be read from JSON) and correctly built it from live DB queries instead — verified by the reviewer against the actual pre-existing code, not taken on faith.

## Final Whole-Branch Review

One broad review pass, dispatched on the most capable available model, looked across all 10 tasks' combined diff for cross-cutting issues no single task's reviewer could see. Result: **2 Critical, 6 Important findings** — every one a genuine interaction between tasks built independently:

- Landed-cost reconciliation (Task 9) was built and tested but never actually reachable from `runMigration` (Task 8) — only 3 of the function's 4 arguments were passed, so the check silently ran zero comparisons while reporting success.
- The committed migration history contained an unconditional `DELETE FROM skus` (the fossil record of Task 2's mid-build fix), harmless on the empty database every real deployment starts from but a landmine for any future non-empty one.
- Task 8's transaction-atomicity fix didn't reach `recordSalesActual` (untouched V1 code) — Task 3's new guard could now throw there too, leaving an orphaned `sales_actuals` row with no matching ledger event.
- `runMigration` didn't sort ledger events by date before replay, exposing exactly the ordering sensitivity Task 3's own review had flagged and deferred.
- Dangling cross-entity references (a shipment pointing at a quarantined PO's line item, a payment pointing at a quarantined PO) were handled two different wrong ways — one crashed the whole migration, one silently orphaned data.
- A PO line-item lookup relied on unordered `SELECT` row order plus a key that collides on duplicate SKUs within one PO.
- The FK-safe test cleanup pattern (Task 4) was connection-pool-based, not connection-pinned — worked only by the accident of sequential test execution.
- The original V1 ledger transform was never given the same quarantine treatment Task 7 gave its four newer siblings — the direct cause of `quarantined.ledger` being permanently empty.

## Fix Wave + Residual

One fix wave addressed all 8 findings — dispatched as a single subagent with every resolution pre-decided by the controller (not left for the implementer to improvise architecture under time pressure), given the scope and design judgment several of them required (especially the migration-history squash and the atomicity/ordering/quarantine fixes). First dispatch attempt hit a model rate limit before any work began; redispatched cleanly with no lost work. Result: 4 focused commits, 111/111 tests, clean typecheck.

Independently verified by the controller before the scoped re-review — not just the test suite, but the actual squashed migration SQL (confirmed zero destructive statements) and live `SHOW CREATE TABLE` output for the affected tables — a direct application of the lesson learned during Task 2's own incident earlier in this same build. Scoped re-review confirmed all 8 findings addressed with no new breakage; two of them (an `ORDER BY` fix and a connection-pinning fix) were accepted without dedicated new regression tests, on the reasoning that a meaningful isolated test for either would require inducing undefined database row-ordering or mocking connection-pool internals — disproportionate to fixes that size, and both are exercised indirectly by the full suite on every run.

## Final State (Stream B)

- 10 tasks complete, each individually reviewed; one whole-branch review found and fixed 2 Critical + 6 Important cross-task issues.
- Test suite: 111 tests, 17 files, passing on the plain documented `pnpm test` command.
- No known open Critical or Important defect. Five smaller items surfaced by this stream's own build are tracked, not silently dropped — see `BACKLOG.md` section B.
- Landed-cost reconciliation machinery exists and is tested but is deliberately not wired to a real data source (unknown real Sheet columns) — it fails loudly rather than silently if asked to run, per the spec's "fail loudly, never silently" principle.
- Migration history was squashed to one clean, non-destructive migration before this repo was ever deployed anywhere — the right and only safe moment to do it.
