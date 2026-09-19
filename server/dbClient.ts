import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { ENV } from "./_core/env";
import * as schema from "../drizzle/schema";

const pool = mysql.createPool(ENV.databaseUrl);

// Pin every connection's session timezone to UTC.
//
// MySQL stores TIMESTAMP columns as UTC internally, but converts them to the
// session's configured timezone when reading back — if the server's session
// timezone is not UTC, the raw string MySQL returns is already shifted, and
// Drizzle's `new Date(value + "+0000")` then misinterprets it as a different
// absolute time. This event handler issues `SET time_zone = '+00:00'` on every
// new physical connection (before the pool hands it to any consumer), ensuring
// TIMESTAMP reads are always interpreted as UTC, regardless of the server's
// default configuration.
pool.pool.on("connection", (connection) => {
  connection.query("SET time_zone = '+00:00'", (err) => {
    if (err) console.error("Failed to set session timezone to UTC on a new pool connection:", err);
  });
});

export const db = drizzle(pool, { schema, mode: "default" });

// Lets functions accept either the pool-backed `db` or a `db.transaction(...)`
// callback's scoped client, so callers can enroll their writes in a caller's
// transaction instead of always running on a separate pool connection. Typed
// as a union (not `typeof db`) because the transaction-scoped client lacks
// `db`'s `$client: Pool` property while still supporting the same queries.
export type DbClient = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
