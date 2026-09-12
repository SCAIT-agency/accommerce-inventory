import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { ENV } from "./_core/env";
import * as schema from "../drizzle/schema";

const pool = mysql.createPool(ENV.databaseUrl);
export const db = drizzle(pool, { schema, mode: "default" });

// Lets functions accept either the pool-backed `db` or a `db.transaction(...)`
// callback's scoped client, so callers can enroll their writes in a caller's
// transaction instead of always running on a separate pool connection. Typed
// as a union (not `typeof db`) because the transaction-scoped client lacks
// `db`'s `$client: Pool` property while still supporting the same queries.
export type DbClient = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
