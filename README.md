# accommerce-inventory

A single-tenant Stock+Money platform for Accommerce (the Jello brand) — built to eventually replace their Google Sheets "Control Tower" as the operational source of truth for purchase orders, shipments, payments, and inventory. Node/Express + tRPC + React + TiDB (MySQL) via Drizzle ORM.

This is a **V1 skeleton**: the ledger-centric core, auth, and the Stock/Purchase Orders/Shipments/Money dashboards are built and tested, but it has not yet run against real Control Tower data — see [Current Status](#current-status) below before assuming this is production-ready.

## Documentation

- [`docs/spec.md`](docs/spec.md) — the design spec (architecture, data model, scope decisions, deferred modules).
- [`docs/plan-v1.md`](docs/plan-v1.md) — the task-by-task implementation plan V1 was built from.
- [`docs/BUILD-HISTORY.md`](docs/BUILD-HISTORY.md) — what was actually built, task by task, and every real bug found and fixed along the way.
- [`docs/BACKLOG.md`](docs/BACKLOG.md) — the prioritized list of what's left before this is genuinely production-ready, sourced from a full whole-branch review.
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

- 20 build tasks complete, each individually reviewed; one whole-branch review found and fixed 3 Critical + 3 Important issues (login flow, production static serving, a currency-blending bug, a broken test command, a wrong stockout-risk calculation, a dashboard not rendering data it already had).
- 65 tests passing on the documented `pnpm test` command.
- **Not yet run against real Accommerce/Jello data.** The migration script only covers `inventory_ledger` today, not the full PO/Shipment/Payment/Transaction history the design spec calls for — see `docs/BACKLOG.md`, section B, before attempting a real migration or parallel run against Control Tower.
- Referential integrity, a real security boundary between roles, and negative-stock validation are not yet in place — also in `docs/BACKLOG.md`, sections B and C. Treat this as a skeleton to keep hardening, not a finished product.
