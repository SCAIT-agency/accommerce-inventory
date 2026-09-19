import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { ENV } from "./_core/env";
import * as schema from "../drizzle/schema";

// Pinned to UTC regardless of the MySQL server's own configured session
// timezone: every consumer of a TIMESTAMP column in this codebase computes
// calendar-day boundaries via `.toISOString().slice(0, 10)`, which is only
// correct if the value MySQL hands back is already UTC — an unpinned
// connection inherits whatever timezone the server happens to be configured
// with, silently shifting day-boundary calculations on any non-UTC server.
const pool = mysql.createPool({ uri: ENV.databaseUrl, timezone: "Z" });
export const db = drizzle(pool, { schema, mode: "default" });

// Lets functions accept either the pool-backed `db` or a `db.transaction(...)`
// callback's scoped client, so callers can enroll their writes in a caller's
// transaction instead of always running on a separate pool connection. Typed
// as a union (not `typeof db`) because the transaction-scoped client lacks
// `db`'s `$client: Pool` property while still supporting the same queries.
export type DbClient = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
