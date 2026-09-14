# accommerce-inventory

A single-tenant Stock+Money platform for Accommerce (the Jello brand) — built to eventually replace their Google Sheets "Control Tower" as the operational source of truth for purchase orders, shipments, payments, and inventory. Node/Express + tRPC + React + TiDB (MySQL) via Drizzle ORM.

This started as a **V1 skeleton** and has since gone through one hardening pass (Backlog Stream B: migration & cutover readiness). The ledger-centric core, auth, and the Stock/Purchase Orders/Shipments/Money dashboards are built and tested, and the schema/migration tooling is now real (foreign keys, negative-stock validation, quarantine-not-abort migration handling) — but it has not yet run against real Control Tower data — see [Current Status](#current-status) below before assuming this is production-ready.

## Documentation

- [`docs/spec.md`](docs/spec.md) — the V1 design spec (architecture, data model, scope decisions, deferred modules).
- [`docs/plan-v1.md`](docs/plan-v1.md) — the task-by-task implementation plan V1 was built from.
- [`docs/2026-09-12-migration-cutover-readiness-design.md`](docs/2026-09-12-migration-cutover-readiness-design.md) — the design spec for Backlog Stream B (migration & cutover readiness hardening).
- [`docs/superpowers/plans/2026-09-12-migration-cutover-readiness.md`](docs/superpowers/plans/2026-09-12-migration-cutover-readiness.md) — the task-by-task implementation plan Stream B was built from.
- [`docs/BUILD-HISTORY.md`](docs/BUILD-HISTORY.md) — what was actually built, task by task, and every real bug found and fixed along the way (V1 and Stream B).
- [`docs/BACKLOG.md`](docs/BACKLOG.md) — the prioritized list of what's left before this is genuinely production-ready, sourced from full whole-branch reviews.
- [`RAILWAY.md`](RAILWAY.md) — deploy runbook for standing up an instance on a client's own infrastructure.

## Architecture in one paragraph

`inventory_ledger` is the single append-only source of truth for stock and landed cost — SOH, Daily COGS, and Cashflow are always computed live from it and from `payments`/`transactions`, never stored as separate fields. Every client gets their own physically isolated deployment from the same code/schema template (no shared multi-tenant database, no `tenant_id` column anywhere) — this instance is Accommerce's own. Every field-level change to a Purchase Order, Shipment, or Payment that affects delay or cost writes an audited `change_log` row with a required reason category.

## Local development

```bash
cp .env.example .env   # fill in DATABASE_URL / SESSION_SECRET / APP_PASSWORD
docker compose up -d   # local MySQL 8 for dev/test (see docker-compose.yml)
pnpm install
pnpm db:push
pnpm dev                # server on :3000, Vite client via the /api proxy
```

Run the test suite with `pnpm test` (single command — no extra flags needed).

## Current Status

- **V1** (20 build tasks): each individually reviewed; one whole-branch review found and fixed 3 Critical + 3 Important issues (login flow, production static serving, a currency-blending bug, a broken test command, a wrong stockout-risk calculation, a dashboard not rendering data it already had).
- **Backlog Stream B — migration & cutover readiness** (10 build tasks, done 2026-09-14): real foreign keys on every core ownership edge, negative-stock validation, a SKU-identifier uniqueness constraint, a shipment status state machine, migration scope widened to the full PO/Shipment/Payment/Transaction history with quarantine-not-abort handling for malformed rows, atomic single-transaction migration, tolerance-based landed-cost reconciliation (built and tested, not yet wired to a live data source), and real CLI entrypoints. One whole-branch review found and fixed 2 Critical + 6 Important cross-task issues.
- 111 tests passing on the documented `pnpm test` command.
- **Still not yet run against real Accommerce/Jello data** — that remains a separate, later, explicitly-gated decision, not something either build attempted. See `docs/BACKLOG.md` section B for what's still genuinely deferred (a small handful of items, mostly things that need the real Control Tower Sheet's actual column formats to resolve properly).
- A real security boundary between roles, and performance work for real data volume, are not yet in place — see `docs/BACKLOG.md` sections C and D. Treat this as a hardening-in-progress platform, not a finished product.
