import { registerHooks } from "node:module";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Pool } from "pg";
import { Database } from "../lib/db.ts";
import { testDatabaseUrl } from "./postgres-safety.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stub = new URL("./postgres-stubs.mjs", import.meta.url).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (["@/app/auth", "@/lib/photos", "@/lib/db"].includes(specifier)) return { url: stub, shortCircuit: true };
  if (specifier.startsWith("@/")) return { url: pathToFileURL(resolve(root, specifier.slice(2)) + ".ts").href, shortCircuit: true };
  if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
    const candidate = fileURLToPath(new URL(specifier, context.parentURL));
    if (existsSync(candidate + ".ts")) return { url: pathToFileURL(candidate + ".ts").href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}});

export const hasTestDatabase = Boolean(testDatabaseUrl());

export async function createTestDatabase({ origin = "https://site.example" } = {}) {
  const connectionString = testDatabaseUrl();
  if (!connectionString) throw new Error("TEST_DATABASE_URL is required for PostgreSQL integration tests");
  const schema = `mi_encargo_test_${randomBytes(12).toString("hex")}`;
  // No caller-supplied identifier is used in CREATE/DROP. Cleanup may remove
  // only the randomly generated schema that this invocation actually created.
  if (!/^mi_encargo_test_[a-f0-9]{24}$/.test(schema)) throw new Error("Invalid test schema");
  const admin = new Pool({ connectionString, max: 1, options: "-c search_path=public" });
  const pool = new Pool({ connectionString, max: 8, options: `-c search_path=${schema}` });
  let created = false;
  let cleaned = false;
  const previousDatabase = globalThis.__postgresTestDatabase;
  const previousUser = globalThis.__postgresTestUser;
  const previousUrl = process.env.DATABASE_URL;
  const previousOrigin = process.env.APP_ORIGIN;
  async function cleanup() {
    if (cleaned) return;
    cleaned = true;
    globalThis.__postgresTestDatabase = previousDatabase;
    globalThis.__postgresTestUser = previousUser;
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    if (previousOrigin === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = previousOrigin;
    await pool.end();
    try { if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); }
    finally { await admin.end(); }
  }
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    for (const file of readdirSync(resolve(root,"db/migrations")).filter(name=>/^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort()) {
      await pool.query(readFileSync(resolve(root,"db/migrations",file),"utf8"));
    }
    const database = ownerId => new Database(ownerId, pool);
    globalThis.__postgresTestDatabase = database;
    globalThis.__postgresTestUser = { userId: "owner-A" };
    // Production context checks that a database is configured; all actual
    // connections in this test use the isolated pool above through the stub.
    process.env.DATABASE_URL = connectionString;
    process.env.APP_ORIGIN = origin;
    return { database, pool, schema, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
