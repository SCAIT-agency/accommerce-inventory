// scripts/run-nightly-export.mjs
//
// Entrypoint for the Railway Cron Job (see RAILWAY.md step 7). Run with tsx,
// not plain `node` — this repo uses extensionless relative imports
// throughout (e.g. "./dbClient", "../drizzle/schema"), which Node's native
// ESM resolver cannot resolve even with --experimental-strip-types. tsx is
// already a project devDependency (used by the `dev` script).
import { runNightlyExport } from "../server/nightlyExport.ts";

const paths = await runNightlyExport("/data/exports");
console.log(`Nightly export wrote ${paths.length} files:`);
for (const path of paths) console.log(`  ${path}`);

// The mysql2 pool underlying `db` keeps its sockets open, which would
// otherwise keep the event loop alive forever — a cron job must actually
// exit once its work is done.
process.exit(0);
