# Deploying accommerce-inventory (Accommerce's own instance)

This app is deployed on **Accommerce's own infrastructure** — SCAIT builds and
maintains the code, Accommerce owns the account and the data (per the platform
design spec's single-tenant-per-client model).

## Required Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `DATABASE_URL` | MySQL/TiDB connection string | `mysql://user:pass@host:4000/accommerce?ssl={"rejectUnauthorized":true}` |
| `SESSION_SECRET` | Secret key for signing session cookies (min 32 chars) | output of `openssl rand -hex 32` |
| `PORT` | Server port (Railway sets this automatically) | `3000` |

## One-time setup (done in Accommerce's own accounts)

1. Accommerce creates a Railway project (or grants SCAIT a collaborator seat on
   one they create) at railway.app, under their own billing.
2. Provision a TiDB Cloud cluster (Serverless tier is enough at V1 scale) under
   Accommerce's own TiDB Cloud account. Copy the connection string as `DATABASE_URL`.
3. In TiDB Cloud's console: Settings → Backup → enable automated daily backups
   with point-in-time recovery. This is a managed feature — enable it, don't build it.
4. In Railway: set environment variables `DATABASE_URL`, `SESSION_SECRET`
   (`openssl rand -hex 32`), `PORT=3000`.
5. Connect the Railway service to the `accommerce-inventory` GitHub repo for
   auto-deploy on push to `main`. Build command: `pnpm build`. Start command: `pnpm start`.
   `pnpm build` emits the server bundle to `dist/index.js` and the Vite-built
   client to `dist/client/`; under `NODE_ENV=production` the server serves that
   client directory as static files with an SPA fallback, so one Railway service
   serves both the API and the frontend. There is no separate static host and no
   Vite process in production.
6. Run `pnpm db:migrate` once against the production `DATABASE_URL` to create the schema — **not** `pnpm db:push`. `db:push` runs `drizzle-kit generate` first, which *authors* a migration from whatever `schema.ts` looks like at that moment; if a schema change ever reaches production without its migration having been committed first (a mistake, not something this deploy process should silently paper over), `generate` would create a brand-new migration file at deploy time instead of failing loudly. `db:migrate` only ever *applies* the migration chain already committed to the repo — the correct, non-authoring operation for any environment that isn't a developer's own machine. Every schema change from here on ships as a migration file committed alongside the `schema.ts` change (already this repo's convention — see any prior Backlog Stream's build history) and is applied to production with this same command on every deploy that adds one, not run ad hoc.
7. **Required one-time bootstrap — create the first user.** Nothing in the
   app creates a `users` row on its own, so until this runs the login screen
   has no account to authenticate against. Run once against the production
   `DATABASE_URL`:

   ```bash
   SEED_USER_EMAIL=ops@accommerce.example SEED_USER_ROLE=editor \
     SEED_USER_PASSWORD=a-real-password \
     pnpm exec tsx scripts/seed-first-user.ts
   ```

   `SEED_USER_ROLE` is `editor` or `viewer` (defaults to `editor`). The
   script prints the created user's id/email/role, and refuses to run twice
   for the same email. Add further users the same way, with a different
   `SEED_USER_EMAIL`.

   To reset a user's password later (e.g. a suspected leak, or someone
   forgetting theirs), run:

   ```bash
   RESET_USER_EMAIL=julian@accommerce.example RESET_USER_PASSWORD=a-new-password \
     pnpm exec tsx scripts/reset-password.ts
   ```

   This also immediately invalidates every session that user currently has
   — see `docs/2026-09-20-security-hardening-design.md` Section 4.

   **Redeploying the security-hardening release logs out every existing
   session at once.** Old session tokens carry no `tokenVersion` claim,
   which never matches a real user row's value (`tokenVersion` always
   starts at 0), so every signed-in user is treated as unauthenticated the
   next time they load the app after this deploy — everyone (editor and
   viewers alike) needs to sign in again with their real password. Expected
   and one-time, not a bug, but worth telling whoever's on the other end of
   that deploy in advance.
8. Add a Railway Cron Job (Railway → New → Cron Job) running nightly, command:
   `pnpm exec tsx scripts/run-nightly-export.ts` (a thin wrapper around
   `runNightlyExport` — see `server/nightlyExport.ts`), writing to a Railway
   persistent volume mounted at `/data/exports`. Use `tsx`, not plain `node`
   — this repo's extensionless relative imports (`./dbClient`,
   `../drizzle/schema`, etc.) don't resolve under Node's native ESM loader,
   even with `--experimental-strip-types`.

**Pre-flight check before applying migrations to a populated database.** The
`0007_volatile_meggan.sql` (FKs/indexes) and `0008_young_klaw.sql` (varchar→decimal
money/share columns) migrations both assume clean data: an orphaned foreign-key
value (e.g. a `change_log.changedBy` or `sales_actuals.skuId` pointing at a row
that no longer exists) makes the FK migration fail outright, and a non-numeric
value in a money/share column (`freightCost`, `dutyCost`, `weightShare`,
`valueShare`, `fxRate`, `paidAmount`, etc.) gets silently coerced or rounded by
the decimal migration instead of erroring. Both happened against this repo's
own dev DB during development. Every instance today is freshly provisioned per
client, so this hasn't mattered yet — but before ever running `pnpm db:migrate`
against a database that already has real data in it, check for orphaned FK
values and non-numeric money/share values first.

## One-time migration (when a real Control Tower export is ready)

```bash
pnpm exec tsx scripts/run-migration.ts <path-to-exported-sheet-data.json>
```

Reads a JSON export file (with `ledgerRows`, `poRows`, `shipmentRows`, `paymentRows`, `transactionRows`, `sheetTotals`, and optional `landedCostTotals`) and runs the migration inside a single transaction. Exits 0 with a quarantine summary on success. Exits 1 and rolls back entirely if the reconciliation gate fails (no partial data left behind). Never run against production without first running the parallel-run check below for the agreed comparison period.

**`landedCostTotals` is accepted by the type but not yet functionally wired.** Real Control Tower Sheet landed-cost column names are still unknown (an open question — see the migration-cutover-readiness design doc), so there is no real `getMigratedLandedCost` implementation to compare against yet. Passing a non-empty `landedCostTotals` array makes `runMigration` throw immediately rather than silently completing with zero landed-cost comparisons run. **Omit this field or pass `[]`** until real Sheet column names are known and the comparison is implemented.

JSON shape:
```json
{
  "ledgerRows": [],
  "poRows": [],
  "shipmentRows": [],
  "paymentRows": [],
  "transactionRows": [],
  "sheetTotals": [
    { "sku": "...", "warehouseCode": "...", "sohFromSheet": 100 }
  ],
  "landedCostTotals": []
}
```

## Daily parallel-run check (during the comparison period, before cutover)

```bash
pnpm exec tsx scripts/run-parallel-check.ts <path-to-todays-sheet-snapshot.json>
```

Reads today's sheet snapshot (array of `{ sku, warehouseCode, sohFromSheet }`) and verifies that Control Tower's current balances match exactly for every SKU/warehouse pair. Exits 0 (safeToCutOver: true) only when all balances match. Exits 1 if any mismatch is found, printing the detailed report. Control Tower stays the live source of truth until this has passed for the agreed comparison period.

## Daily Shopify sales import

```bash
pnpm exec tsx scripts/run-daily-shopify-pull.ts <path-to-shopify-export.json>
```

Idempotent — re-running for a day/SKU/warehouse combination already imported reports it as skipped (duplicate) rather than double-counting SOH depletion or COGS. Exits 0 even when rows are skipped (skipping is expected, not a failure); exits 1 only on a hard failure (missing file, malformed input, or an unexpected error).

## Ongoing

- Deploys happen automatically on push to `main` — this is Accommerce's own
  instance, not shared with any other client.
- A future second client instance (e.g. Tucann) repeats steps 1–8 on *their*
  own infrastructure, from the same repo template — never on this instance.

## Local Development

```bash
# Install dependencies
pnpm install

# Set environment variables (create .env file)
cp .env.example .env
# Edit .env with your values

# Run database migrations
pnpm db:push

# Start dev server (hot reload)
pnpm dev

# Run tests
pnpm test
```

## Project Structure

```
server/_core/       — Framework plumbing (auth, context, tRPC, static client serving)
server/             — Business logic (SKUs, POs, shipments, payments, ledger, nightly export)
client/src/         — React frontend (pages, components, lib)
drizzle/            — Database schema and migrations
```
