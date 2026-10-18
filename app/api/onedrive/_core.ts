import type { Database } from "@/lib/db";
import { parseText, ValidationError } from "@/lib/validation";
import { boundedBody } from "../_shared";

export type Connection = {
  owner_id: string; refresh_cipher: string; access_cipher: string; access_expires_at: number;
  account: string; drive_id: string; file_id: string; file_name: string; web_url: string;
  last_modified_at: string; etag: string; synced_etag: string; downloaded_etag: string;
  last_sync_at: string; last_sync_error: string; revision: number;
  granted_scope: string; last_write_at: string;
};
type Config = { clientId: string; clientSecret: string; redirectUri: string; tokenKey: string };
export type DriveFile = { id: string; name: string; size?: number; lastModifiedDateTime?: string; eTag?: string; webUrl?: string; file?: unknown; remoteItem?: unknown; parentReference?: { path?: string; driveId?: string } };
const TOKEN_ENDPOINT = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
const GRAPH = "https://graph.microsoft.com/v1.0";
export const READ_SCOPE = "https://graph.microsoft.com/Files.Read offline_access";
export const WRITE_SCOPE = "https://graph.microsoft.com/Files.ReadWrite offline_access";
export function canWrite(scope?: string): boolean { return Boolean(scope?.split(/\s+/).some(value => value === "Files.ReadWrite" || value === "https://graph.microsoft.com/Files.ReadWrite")); }

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  try { return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), char => char.charCodeAt(0)); }
  catch { return new Uint8Array(); }
}
export function base64Url(value: Uint8Array): string { return btoa(String.fromCharCode(...value)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_"); }
export async function hash(value: string): Promise<string> { return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))); }
export function randomToken(): string { return base64Url(crypto.getRandomValues(new Uint8Array(32))); }

export function configuration(_request: Request): { configured: boolean; missing: string[]; config?: Config } {
  void _request;
  const values = { APP_ORIGIN: process.env.APP_ORIGIN, MICROSOFT_CLIENT_ID: process.env.MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET: process.env.MICROSOFT_CLIENT_SECRET, MICROSOFT_REDIRECT_URI: process.env.MICROSOFT_REDIRECT_URI, ONEDRIVE_TOKEN_KEY: process.env.ONEDRIVE_TOKEN_KEY };
  const missing = Object.entries(values).filter(([, value]) => !value?.trim()).map(([name]) => name);
  let publicOrigin = "";
  if (process.env.APP_ORIGIN) {
    try {
      const url = new URL(process.env.APP_ORIGIN);
      if (url.protocol !== "https:" || process.env.APP_ORIGIN !== url.origin) missing.push("APP_ORIGIN debe ser el origen HTTPS público de esta web");
      else publicOrigin = url.origin;
    } catch { missing.push("APP_ORIGIN válida"); }
  }
  if (process.env.ONEDRIVE_TOKEN_KEY && decodeBase64(process.env.ONEDRIVE_TOKEN_KEY).byteLength !== 32) missing.push("ONEDRIVE_TOKEN_KEY válida de 32 bytes");
  if (process.env.MICROSOFT_REDIRECT_URI) {
    try {
      const uri = new URL(process.env.MICROSOFT_REDIRECT_URI);
      if (uri.protocol !== "https:" || uri.origin !== publicOrigin || uri.pathname !== "/api/onedrive/callback" || uri.search || uri.hash || uri.username || uri.password) missing.push("MICROSOFT_REDIRECT_URI debe ser el callback HTTPS de esta web");
    } catch { missing.push("MICROSOFT_REDIRECT_URI válida"); }
  }
  if (missing.length) return { configured: false, missing };
  return { configured: true, missing: [], config: { clientId: process.env.MICROSOFT_CLIENT_ID!, clientSecret: process.env.MICROSOFT_CLIENT_SECRET!, redirectUri: process.env.MICROSOFT_REDIRECT_URI!, tokenKey: process.env.ONEDRIVE_TOKEN_KEY! } };
}
export function requireConfig(request: Request): Config {
  const result = configuration(request);
  if (!result.config) throw new ValidationError("La conexión con Microsoft está pendiente de configuración. Todavía no se ha registrado y autorizado la aplicación.", 503);
  return result.config;
}
async function encryptionKey(secret: string) { return crypto.subtle.importKey("raw", decodeBase64(secret), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]); }
export async function encrypt(value: string, secret: string, ownerId: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(ownerId) }, await encryptionKey(secret), new TextEncoder().encode(value));
  return `v1.${base64Url(iv)}.${base64Url(new Uint8Array(ciphertext))}`;
}
export async function decrypt(value: string, secret: string, ownerId: string): Promise<string> {
  const [version, iv, ciphertext] = value.split(".");
  if (version !== "v1" || !iv || !ciphertext) throw new ValidationError("Vuelve a conectar tu cuenta de Microsoft.", 401);
  try { return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: decodeBase64(iv), additionalData: new TextEncoder().encode(ownerId) }, await encryptionKey(secret), decodeBase64(ciphertext))); }
  catch { throw new ValidationError("No se pudo abrir la conexión guardada. Vuelve a conectar Microsoft.", 401); }
}

export function connection(db: Database, ownerId: string): Promise<Connection | null> {
  return db.prepare("SELECT * FROM onedrive_connections WHERE owner_id=$1").bind(ownerId).first<Connection>();
}
export function selectedFile(value: Connection) {
  return value.file_id ? { id: value.file_id, name: value.file_name, webUrl: value.web_url, lastModifiedAt: value.last_modified_at, etag: value.etag, syncedEtag: value.synced_etag } : null;
}
export function fileId(value: unknown): string {
  const id = parseText(value, "Archivo de OneDrive", 300, true);
  if (/[\s/?#\\]/.test(id)) throw new ValidationError("Selecciona un archivo válido de tu OneDrive.");
  return id;
}

export async function requestTokens(config: Config, parameters: Record<string, string>) {
  let response: Response;
  try { response = await fetch(TOKEN_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...parameters }), signal: AbortSignal.timeout(20_000) }); }
  catch { throw new ValidationError("Microsoft no respondió. Vuelve a intentarlo.", 502); }
  const data = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string };
  if (!response.ok || !data.access_token) throw new ValidationError(data.error === "invalid_grant" ? "La autorización de Microsoft venció o fue revocada. Vuelve a conectar tu cuenta." : "Microsoft no autorizó la conexión. Revisa la configuración y vuelve a intentarlo.", data.error === "invalid_grant" ? 401 : 502);
  return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: Date.now() + Math.max(60, Number(data.expires_in ?? 3600)) * 1000, grantedScope: data.scope || "" };
}

export async function accessToken(db: Database, ownerId: string, config: Config): Promise<string> {
  const stored = await connection(db, ownerId);
  if (!stored?.refresh_cipher) throw new ValidationError("Conecta tu cuenta de Microsoft para leer el Excel.", 401);
  if (stored.access_cipher && stored.access_expires_at > Date.now() + 60_000) return decrypt(stored.access_cipher, config.tokenKey, ownerId);
  try {
    const refreshToken = await decrypt(stored.refresh_cipher, config.tokenKey, ownerId);
    const tokens = await requestTokens(config, { grant_type: "refresh_token", refresh_token: refreshToken, scope: canWrite(stored.granted_scope) ? WRITE_SCOPE : READ_SCOPE });
    await db.prepare("UPDATE onedrive_connections SET refresh_cipher=$1,access_cipher=$2,access_expires_at=$3,granted_scope=$6 WHERE owner_id=$4 AND refresh_cipher=$5")
      .bind(await encrypt(tokens.refreshToken ?? refreshToken, config.tokenKey, ownerId), await encrypt(tokens.accessToken, config.tokenKey, ownerId), tokens.expiresAt, ownerId, stored.refresh_cipher, tokens.grantedScope || stored.granted_scope || "").run();
    return tokens.accessToken;
  } catch (error) {
    if (error instanceof ValidationError && error.status === 401) await db.prepare("UPDATE onedrive_connections SET refresh_cipher='',access_cipher='',access_expires_at=0,last_sync_error=$1 WHERE owner_id=$2 AND refresh_cipher=$3").bind(error.message, ownerId, stored.refresh_cipher).run();
    throw error;
  }
}

export async function graph(db: Database, ownerId: string, config: Config, path: string, headers: Record<string, string> = {}): Promise<Response> {
  const token = await accessToken(db, ownerId, config);
  let response: Response;
  try { response = await fetch(`${GRAPH}${path}`, { headers: { Authorization: `Bearer ${token}`, ...headers }, redirect: "manual", signal: AbortSignal.timeout(20_000) }); }
  catch { throw new ValidationError("No se pudo consultar OneDrive. Revisa tu conexión e inténtalo nuevamente.", 502); }
  if (response.status === 401) throw new ValidationError("Microsoft solicita renovar la conexión. Desconecta y vuelve a conectar tu cuenta.", 401);
  if (response.status === 404) throw new ValidationError("El archivo ya no está disponible en tu OneDrive.", 404);
  if (response.status === 429) throw new ValidationError("OneDrive está recibiendo demasiadas solicitudes. Espera un momento y vuelve a intentarlo.", 429);
  if (!response.ok && response.status !== 304 && response.status !== 302) throw new ValidationError("OneDrive no permitió consultar el archivo. Comprueba que sigue en tu cuenta.", 502);
  return response;
}
export async function metadata(db: Database, ownerId: string, config: Config, id: string): Promise<DriveFile> {
  const response = await graph(db, ownerId, config, `/me/drive/items/${encodeURIComponent(id)}?$select=id,name,size,eTag,lastModifiedDateTime,webUrl,file,remoteItem,parentReference`);
  const data = await response.json() as DriveFile;
  if (!data.id || !data.file || data.remoteItem || !data.name?.toLowerCase().endsWith(".xlsx")) throw new ValidationError("Selecciona un libro .xlsx guardado en tu propio OneDrive.");
  if (!Number.isSafeInteger(data.size) || Number(data.size) <= 0 || Number(data.size) > 5 * 1024 * 1024) throw new ValidationError("El Excel debe pesar como máximo 5 MB.", 413);
  if (!data.eTag) throw new ValidationError("Microsoft no devolvió una versión verificable del archivo.", 502);
  return data;
}

export async function downloadFile(db: Database, ownerId: string, config: Config, id: string): Promise<Uint8Array<ArrayBuffer>> {
  let response = await graph(db, ownerId, config, `/me/drive/items/${encodeURIComponent(id)}/content`);
  for (let redirects = 0; response.status === 302 || response.status === 301 || response.status === 307; redirects++) {
    if (redirects >= 4) throw new ValidationError("OneDrive no pudo preparar la descarga.", 502);
    const target = new URL(response.headers.get("location") ?? "");
    const host = target.hostname.toLowerCase();
    if (target.protocol !== "https:" || target.username || target.password || !(host.endsWith(".1drv.com") || host.endsWith(".onedrive.com") || host === "onedrive.live.com" || host.endsWith(".microsoft.com") || host.endsWith(".sharepoint.com") || host.endsWith(".microsoftpersonalcontent.com"))) throw new ValidationError("Microsoft devolvió una dirección de descarga no admitida.", 502);
    // Preauthenticated download locations never receive the Microsoft token.
    try { response = await fetch(target.href, { redirect: "manual", signal: AbortSignal.timeout(20_000) }); }
    catch { throw new ValidationError("No se pudo descargar el Excel desde Microsoft.", 502); }
  }
  if (!response.ok) throw new ValidationError("No se pudo descargar la versión actual del Excel.", 502);
  const data = await boundedBody(new Request("https://download.local/", { method: "POST", body: response.body, headers: { "Content-Length": response.headers.get("content-length") ?? "0" }, duplex: "half" } as RequestInit), 5 * 1024 * 1024, "El Excel supera el límite de 5 MB.");
  if (data.length < 4 || data[0] !== 0x50 || data[1] !== 0x4b || data[2] !== 3 || data[3] !== 4) throw new ValidationError("Microsoft devolvió una página o un archivo que no es un Excel .xlsx.", 502);
  return data;
}

export function oauthCookie(value: string, maxAge = 600): string { return `onedrive_oauth_state=${value}; Path=/api/onedrive/callback; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`; }
export function redirectBack(_request: Request, result: "connected" | "error") {
  // requireConfig has validated this fixed public origin before a callback can
  // redirect. Render's internal request host and forwarded headers are ignored.
  return new Response(null, { status: 303, headers: { Location: `${process.env.APP_ORIGIN}/?onedrive=${result}`, "Set-Cookie": oauthCookie("", 0), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}
