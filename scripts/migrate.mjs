import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Pool } from "pg";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query("SET LOCAL lock_timeout='30s'");
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('mi-encargo:migrations',0))");
  await client.query("CREATE TABLE IF NOT EXISTS app_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
  const files = (await readdir(new URL("../db/migrations/", import.meta.url))).filter(name => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort();
  for (const name of files) {
    const sql = await readFile(new URL(`../db/migrations/${name}`, import.meta.url), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const previous = await client.query("SELECT checksum FROM app_migrations WHERE name=$1", [name]);
    if (previous.rowCount) {
      if (previous.rows[0].checksum !== checksum) throw new Error(`Previously applied migration changed: ${name}`);
      continue;
    }
    await client.query(sql);
    await client.query("INSERT INTO app_migrations(name,checksum) VALUES($1,$2)", [name, checksum]);
    console.log(`Applied ${name}`);
  }
  await client.query("COMMIT");
  console.log("Database schema is ready.");
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  // Avoid logging connection strings or parameter values.
  console.error(error instanceof Error ? error.message : "Migration failed");
  process.exitCode = 1;
} finally { client.release(); await pool.end(); }
