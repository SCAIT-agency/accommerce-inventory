// Loads .env into process.env before any test file runs, so `pnpm test`
// works as a bare command instead of requiring `set -a && source .env &&
// set +a` first (see docs/BACKLOG.md section F). Uses Node's own built-in
// env-file loader (stable since Node 20.12/21.7 — no `dotenv` dependency
// needed). Silently does nothing if .env is missing (e.g. CI, where the
// real env vars are injected another way).
import { existsSync } from "node:fs";
import path from "node:path";

const envPath = path.resolve(process.cwd(), ".env");
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}
