# Deploying accommerce-inventory (Accommerce's own instance)

This app is deployed on **Accommerce's own infrastructure** — SCAIT builds and
maintains the code, Accommerce owns the account and the data (per the platform
design spec's single-tenant-per-client model).

## Required Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `DATABASE_URL` | MySQL/TiDB connection string | `mysql://user:pass@host:4000/accommerce?ssl={"rejectUnauthorized":true}` |
| `SESSION_SECRET` | Secret key for signing session cookies (min 32 chars) | output of `openssl rand -hex 32` |
| `APP_PASSWORD` | Password gate — all users must enter this to access the app | `your-secure-password` |
| `PORT` | Server port (Railway sets this automatically) | `3000` |

## One-time setup (done in Accommerce's own accounts)

1. Accommerce creates a Railway project (or grants SCAIT a collaborator seat on
   one they create) at railway.app, under their own billing.
2. Provision a TiDB Cloud cluster (Serverless tier is enough at V1 scale) under
   Accommerce's own TiDB Cloud account. Copy the connection string as `DATABASE_URL`.
3. In TiDB Cloud's console: Settings → Backup → enable automated daily backups
   with point-in-time recovery. This is a managed feature — enable it, don't build it.
4. In Railway: set environment variables `DATABASE_URL`, `SESSION_SECRET`
   (`openssl rand -hex 32`), `APP_PASSWORD`, `PORT=3000`.
5. Connect the Railway service to the `accommerce-inventory` GitHub repo for
   auto-deploy on push to `main`. Build command: `pnpm build`. Start command: `pnpm start`.
6. Run `pnpm db:push` once against the production `DATABASE_URL` to create the schema.
7. Add a Railway Cron Job (Railway → New → Cron Job) running nightly, command:
   `node --experimental-strip-types scripts/run-nightly-export.mjs` (a thin wrapper
   around `runNightlyExport` — see `server/nightlyExport.ts`), writing to a
   Railway persistent volume mounted at `/data/exports`.

## Ongoing

- Deploys happen automatically on push to `main` — this is Accommerce's own
  instance, not shared with any other client.
- A future second client instance (e.g. Tucann) repeats steps 1–7 on *their*
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
server/_core/       — Framework plumbing (auth, context, tRPC, Vite bridge)
server/             — Business logic (SKUs, POs, shipments, payments, ledger, nightly export)
client/src/         — React frontend (pages, components, lib)
drizzle/            — Database schema and migrations
```
