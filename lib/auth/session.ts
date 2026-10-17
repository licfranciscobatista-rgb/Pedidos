import { createHash, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { getPool } from "@/lib/db";
import { constantTimeEqual, hashPassword, validNewPassword, verifyPassword } from "./password";
import { normalizeUsername, sessionCookieName, type AppUser, type AuthConfiguration } from "./config";

export const SESSION_AGE_SECONDS = 7 * 24 * 60 * 60;
const OWNER_LOCK = "mi-encargo:auth:owner";
type OwnerRow = { username: string; data_owner_id: string; password_hash: string };
export class AuthError extends Error {
  constructor(message: string, readonly status = 400, readonly retryAfter = 0) { super(message); }
}

export function tokenHash(token: string): string { return createHash("sha256").update(token).digest("hex"); }
export function validSessionToken(token: string): boolean { return /^[A-Za-z0-9_-]{43}$/.test(token); }
function newSessionToken(): string { return randomBytes(32).toString("base64url"); }
function ownerMatches(owner: Pick<OwnerRow, "username" | "data_owner_id">, config: AuthConfiguration): boolean {
  return owner.username === config.normalizedUsername && owner.data_owner_id === config.dataOwnerId;
}
function appUser(config: AuthConfiguration): AppUser { return { userId: config.dataOwnerId, username: config.ownerUsername, displayName: config.ownerUsername }; }

export async function readSession(token: string | undefined, config: AuthConfiguration | null, connectionPool?: Pool): Promise<AppUser | null> {
  if (!config || !token || !validSessionToken(token)) return null;
  const pool = connectionPool ?? getPool();
  const result = await pool.query<OwnerRow>("SELECT o.username,o.data_owner_id FROM auth_sessions s JOIN auth_owner o ON o.id=s.owner_id WHERE s.token_hash=$1 AND s.expires_at>$2", [tokenHash(token), Date.now()]);
  const owner = result.rows[0];
  return owner && ownerMatches(owner, config) ? appUser(config) : null;
}

export async function setupState(config: AuthConfiguration | null, connectionPool?: Pool): Promise<"unavailable" | "ready" | "complete"> {
  if (!config) return "unavailable";
  try {
    const pool = connectionPool ?? getPool();
    const result = await pool.query("SELECT id FROM auth_owner WHERE id=1");
    if (result.rowCount) return "complete";
    return config.setupToken.length >= 32 ? "ready" : "unavailable";
  } catch { return "unavailable"; }
}

async function transaction<T>(pool: Pool, action: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout='10s'");
    await client.query("SET LOCAL statement_timeout='15s'");
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
  finally { client.release(); }
}

export async function takeAttempt(action: "login" | "setup", pool: Pool = getPool()): Promise<void> {
  const maximum = action === "login" ? 5 : 10;
  const windowMs = action === "login" ? 15 * 60_000 : 60 * 60_000;
  const now = Date.now();
  const retry = await transaction(pool, async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))", [`mi-encargo:auth:rate:${action}`]);
    const result = await client.query<{ window_started_at: number; attempts: number }>("SELECT window_started_at,attempts FROM auth_rate_limits WHERE action=$1 FOR UPDATE", [action]);
    const saved = result.rows[0];
    if (saved && saved.window_started_at + windowMs > now && saved.attempts >= maximum) return Math.max(1, Math.ceil((saved.window_started_at + windowMs - now) / 1000));
    const windowStart = saved && saved.window_started_at + windowMs > now ? saved.window_started_at : now;
    const attempts = saved && windowStart === saved.window_started_at ? saved.attempts + 1 : 1;
    await client.query("INSERT INTO auth_rate_limits(action,window_started_at,attempts) VALUES($1,$2,$3) ON CONFLICT(action) DO UPDATE SET window_started_at=excluded.window_started_at,attempts=excluded.attempts", [action, windowStart, attempts]);
    return 0;
  });
  if (retry) throw new AuthError("Hubo demasiados intentos. Espera unos minutos antes de intentarlo nuevamente.", 429, retry);
}

async function insertSession(client: PoolClient, token: string, now: number) {
  await client.query("DELETE FROM auth_sessions WHERE expires_at<=$1", [now]);
  // Keep a bounded number of signed-in devices for this one-owner application.
  await client.query("DELETE FROM auth_sessions WHERE token_hash IN (SELECT token_hash FROM auth_sessions ORDER BY created_at DESC OFFSET 19)");
  await client.query("INSERT INTO auth_sessions(token_hash,owner_id,created_at,expires_at) VALUES($1,1,$2,$3)", [tokenHash(token), now, now + SESSION_AGE_SECONDS * 1000]);
}

export async function createOwner(input: { username?: unknown; password?: unknown; confirmPassword?: unknown; setupToken?: unknown }, config: AuthConfiguration, pool: Pool = getPool()): Promise<string> {
  if (config.setupToken.length < 32) throw new AuthError("La creación del acceso está pendiente de configuración.", 503);
  if (typeof input.setupToken !== "string" || !constantTimeEqual(input.setupToken, config.setupToken)) throw new AuthError("La clave de instalación no es válida.", 403);
  // Unknown visitors must not exhaust the owner's one-time setup quota.
  // Only a holder of the high-entropy installation key reaches costly work.
  await takeAttempt("setup", pool);
  if (typeof input.username !== "string" || normalizeUsername(input.username) !== config.normalizedUsername) throw new AuthError("Usa el nombre de usuario autorizado para esta aplicación.", 403);
  if (!validNewPassword(input.password)) throw new AuthError("Crea un PIN de exactamente 4 dígitos, del 0 al 9.");
  if (input.confirmPassword !== input.password) throw new AuthError("Los PIN no coinciden.");
  const passwordHash = await hashPassword(input.password);
  const token = newSessionToken();
  await transaction(pool, async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))", [OWNER_LOCK]);
    const saved = await client.query("SELECT id FROM auth_owner WHERE id=1");
    if (saved.rowCount) throw new AuthError("La cuenta ya está creada. Entra con tu usuario y contraseña.", 409);
    await client.query("INSERT INTO auth_owner(id,username,data_owner_id,password_hash,created_at,setup_consumed_at) VALUES(1,$1,$2,$3,$4,$4)", [config.normalizedUsername, config.dataOwnerId, passwordHash, Date.now()]);
    await insertSession(client, token, Date.now());
  });
  return token;
}

export async function signIn(input: { username?: unknown; password?: unknown }, config: AuthConfiguration, pool: Pool = getPool()): Promise<string> {
  await takeAttempt("login", pool);
  const username = typeof input.username === "string" ? normalizeUsername(input.username) : "";
  if (typeof input.password !== "string" || Buffer.byteLength(input.password, "utf8") > 256 || username.length > 100) throw new AuthError("El usuario o la contraseña no son correctos.", 401);
  const saved = await pool.query<OwnerRow>("SELECT username,data_owner_id,password_hash FROM auth_owner WHERE id=1");
  const owner = saved.rows[0];
  const validPassword = await verifyPassword(input.password, owner?.password_hash ?? null);
  const validUsername = constantTimeEqual(username, config.normalizedUsername);
  if (!owner || !ownerMatches(owner, config) || !validUsername || !validPassword) throw new AuthError("El usuario o la contraseña no son correctos.", 401);
  const token = newSessionToken();
  await transaction(pool, async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))", [OWNER_LOCK]);
    await insertSession(client, token, Date.now());
    await client.query("DELETE FROM auth_rate_limits WHERE action='login'");
  });
  return token;
}

export async function signOut(token: string | undefined, pool: Pool = getPool()): Promise<void> {
  if (token && validSessionToken(token)) await pool.query("DELETE FROM auth_sessions WHERE token_hash=$1", [tokenHash(token)]);
}
export function sessionCookie(token: string, config: AuthConfiguration, clear = false): string {
  return `${sessionCookieName(config.production)}=${clear ? "" : token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : SESSION_AGE_SECONDS}${config.production ? "; Secure" : ""}`;
}
