import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Pool } from "pg";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stub = new URL("./auth-postgres-stubs.mjs", import.meta.url).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (["@/lib/db", "next/headers"].includes(specifier)) return { url: stub, shortCircuit: true };
  if (specifier.startsWith("@/")) return { url: pathToFileURL(resolve(root, specifier.slice(2)) + ".ts").href, shortCircuit: true };
  if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
    const candidate = fileURLToPath(new URL(specifier, context.parentURL));
    if (existsSync(candidate + ".ts")) return { url: pathToFileURL(candidate + ".ts").href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
} });
// Use the real application's safe bigint parser for epoch timestamps.
await import("../lib/db.ts");
const { authConfiguration, sessionCookieName } = await import("../lib/auth/config.ts");
const { readSession, setupState, takeAttempt, tokenHash } = await import("../lib/auth/session.ts");
const { getAppUser } = await import("../app/auth.ts");
const access = await import("../app/api/access/route.ts");
const setup = await import("../app/api/auth/setup/route.ts");
const login = await import("../app/api/auth/login/route.ts");
const logout = await import("../app/api/auth/logout/route.ts");
const connectionString = process.env.TEST_DATABASE_URL;

test("PostgreSQL real: bootstrap cerrado, sesiones, logout, falsificación y límites persistentes", { skip: !connectionString }, async t => {
  const schema = `mi_encargo_auth_test_${randomBytes(12).toString("hex")}`;
  if (!/^mi_encargo_auth_test_[a-f0-9]{24}$/.test(schema)) throw new Error("invalid test schema");
  const admin = new Pool({ connectionString, max: 1 });
  const pool = new Pool({ connectionString, max: 8, options: `-c search_path=${schema}` });
  const environment = { APP_OWNER_USERNAME: "ADMINISTRADOR", APP_DATA_OWNER_ID: "40000000-0000-4000-8000-000000000001", APP_ORIGIN: "https://orders.example.test", NODE_ENV: "production", APP_SETUP_TOKEN: randomBytes(32).toString("base64url") };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  const previousPool = globalThis.__authTestPool;
  const previousCookies = globalThis.__authTestCookies;
  let created = false;
  const password = "Clave de prueba privada 9182";
  const config = authConfiguration(environment);
  const cookieName = sessionCookieName(true);
  const request = (path, body, origin = environment.APP_ORIGIN) => new Request(`http://render-internal${path}`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body) });
  const input = { username: "ADMINISTRADOR", password, confirmPassword: password, setupToken: environment.APP_SETUP_TOKEN };
  const tokenFrom = response => response.headers.get("set-cookie").split(";", 1)[0].split("=")[1];
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`); created = true;
    await pool.query(readFileSync(resolve(root, "db/migrations/0001_auth.sql"), "utf8"));
    globalThis.__authTestPool = pool;
    globalThis.__authTestCookies = new Map();
    Object.assign(process.env, environment);

    await t.test("no se puede tomar la cuenta sin secreto ni con otro nombre", async () => {
      assert.equal(await setupState(config, pool), "ready");
      assert.equal((await setup.POST(request("/api/auth/setup", { ...input, setupToken: "wrong" }))).status, 403);
      assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM auth_rate_limits WHERE action='setup'")).rows[0].n, 0, "un visitante sin secreto no consume el cupo de instalación");
      assert.equal((await setup.POST(request("/api/auth/setup", { ...input, username: "attacker" }))).status, 403);
      assert.equal((await setup.POST(request("/api/auth/setup", { ...input, password: "short", confirmPassword: "short" }))).status, 400);
      assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM auth_owner")).rows[0].n, 0);
    });

    let firstToken;
    await t.test("setup concurrente solo crea un propietario y consume el secreto", async () => {
      const responses = await Promise.all([setup.POST(request("/api/auth/setup", input)), setup.POST(request("/api/auth/setup", input))]);
      assert.deepEqual(responses.map(response => response.status).sort(), [201, 409]);
      firstToken = tokenFrom(responses.find(response => response.status === 201));
      assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM auth_owner")).rows[0].n, 1);
      const owner = (await pool.query("SELECT * FROM auth_owner")).rows[0];
      assert.equal(owner.username, "administrador");
      assert.equal(owner.data_owner_id, config.dataOwnerId);
      assert.match(owner.password_hash, /^scrypt\$v1\$131072\$8\$1\$/);
      assert.ok(!JSON.stringify(owner).includes(password));
      assert.ok(!JSON.stringify(owner).includes(environment.APP_SETUP_TOKEN));
      assert.equal(await setupState(config, pool), "complete");
      assert.equal((await setup.POST(request("/api/auth/setup", input))).status, 409);
    });

    await t.test("cabeceras falsas, cookie inventada o namespace cambiado no dan acceso", async () => {
      const fake = new Request(`${environment.APP_ORIGIN}/api/access`, { headers: { "oai-authenticated-user-id": config.dataOwnerId, "oai-authenticated-user-email": "owner@example.test" } });
      assert.equal((await access.GET(fake)).status, 401);
      globalThis.__authTestCookies.set(cookieName, "x".repeat(43));
      assert.equal(await getAppUser(), null);
      globalThis.__authTestCookies.set(cookieName, firstToken);
      assert.equal((await access.GET()).status, 200);
      assert.equal((await getAppUser()).userId, config.dataOwnerId);
      assert.equal(await readSession(firstToken, { ...config, normalizedUsername: "other" }, pool), null);
      assert.equal(await readSession(firstToken, { ...config, dataOwnerId: "40000000-0000-4000-8000-000000000002" }, pool), null);
      delete process.env.APP_OWNER_USERNAME;
      assert.equal(await getAppUser(), null);
      process.env.APP_OWNER_USERNAME = environment.APP_OWNER_USERNAME;
    });

    await t.test("login valida contraseña y logout revoca la sesión en PostgreSQL", async () => {
      assert.equal((await login.POST(request("/api/auth/login", { username: "ADMINISTRADOR", password: "Incorrecta de prueba" }))).status, 401);
      assert.equal((await login.POST(request("/api/auth/login", { username: "attacker", password }))).status, 401);
      assert.equal((await login.POST(request("/api/auth/login", { username: "administrador", password }, "https://attacker.invalid"))).status, 403);
      const response = await login.POST(request("/api/auth/login", { username: " administrador ", password }));
      assert.equal(response.status, 200);
      assert.match(response.headers.get("set-cookie"), /HttpOnly; SameSite=Lax; Max-Age=604800; Secure/);
      const token = tokenFrom(response);
      assert.notEqual(token, firstToken);
      const stored = await pool.query("SELECT token_hash FROM auth_sessions WHERE token_hash=$1", [tokenHash(token)]);
      assert.equal(stored.rowCount, 1);
      assert.ok(!stored.rows[0].token_hash.includes(token));
      globalThis.__authTestCookies.set(cookieName, token);
      assert.equal((await access.GET()).status, 200);
      const signedOut = await logout.POST(request("/api/auth/logout", {}));
      assert.equal(signedOut.status, 200);
      assert.match(signedOut.headers.get("set-cookie"), /Max-Age=0/);
      assert.equal(await readSession(token, config, pool), null);
      globalThis.__authTestCookies.set(cookieName, firstToken);
      await pool.query("UPDATE auth_sessions SET created_at=$1,expires_at=$2 WHERE token_hash=$3", [Date.now() - 2000, Date.now() - 1000, tokenHash(firstToken)]);
      assert.equal(await getAppUser(), null);
    });

    await t.test("la limitación concurrente es persistente y no depende de IP falsificable", async () => {
      const attempts = await Promise.allSettled(Array.from({ length: 14 }, () => takeAttempt("login", pool)));
      assert.equal(attempts.filter(value => value.status === "fulfilled").length, 12);
      assert.equal(attempts.filter(value => value.status === "rejected" && value.reason.status === 429).length, 2);
      const saved = (await pool.query("SELECT attempts FROM auth_rate_limits WHERE action='login'")).rows[0];
      assert.equal(saved.attempts, 12);
      const limited = await login.POST(request("/api/auth/login", { username: "ADMINISTRADOR", password }));
      assert.equal(limited.status, 429);
      assert.ok(Number(limited.headers.get("retry-after")) > 0);
    });
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    globalThis.__authTestPool = previousPool;
    globalThis.__authTestCookies = previousCookies;
    await pool.end();
    try { if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); }
    finally { await admin.end(); }
  }
});
