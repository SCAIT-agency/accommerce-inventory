import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { ENV } from "./_core/env";
import * as schema from "../drizzle/schema";

const pool = mysql.createPool(ENV.databaseUrl);
export const db = drizzle(pool, { schema, mode: "default" });
