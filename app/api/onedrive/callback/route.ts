import { context, route } from "../../_shared";
import { decrypt, encrypt, hash, redirectBack, requestTokens, requireConfig } from "../_core";

export async function GET(request: Request) {
  return route(async () => {
    const { db, ownerId } = await context(request);
    const config = requireConfig(request);
    const url = new URL(request.url);
    const state = url.searchParams.get("state") ?? "";
    const cookie = request.headers.get("cookie")?.split(";").map(item => item.trim()).find(item => item.startsWith("onedrive_oauth_state="))?.slice("onedrive_oauth_state=".length);
    if (!/^[A-Za-z0-9_-]{43}$/.test(state) || cookie !== state || url.searchParams.has("error")) return redirectBack(request, "error");
    const saved = await db.prepare("DELETE FROM onedrive_oauth_states WHERE id=$1 AND owner_id=$2 AND expires_at>$3 RETURNING verifier_cipher").bind(await hash(state), ownerId, Date.now()).first<{ verifier_cipher: string }>();
    const code = url.searchParams.get("code");
    if (!saved || !code || code.length > 8192) return redirectBack(request, "error");
    try {
      const session = JSON.parse(await decrypt(saved.verifier_cipher, config.tokenKey, ownerId)) as { verifier: string; generation: number };
      if (!session.verifier || !Number.isSafeInteger(session.generation) || session.generation < 0) return redirectBack(request, "error");
      const verifier = session.verifier;
      const tokens = await requestTokens(config, { grant_type: "authorization_code", code, redirect_uri: config.redirectUri, code_verifier: verifier, scope: "https://graph.microsoft.com/Files.Read offline_access" });
      if (!tokens.refreshToken) return redirectBack(request, "error");
      const response = await fetch("https://graph.microsoft.com/v1.0/me/drive?$select=id,owner,driveType", { headers: { Authorization: `Bearer ${tokens.accessToken}` }, signal: AbortSignal.timeout(20_000) });
      if (!response.ok) return redirectBack(request, "error");
      const drive = await response.json() as { id?: string; driveType?: string; owner?: { user?: { displayName?: string; email?: string } } };
      if (!drive.id || drive.driveType !== "personal") return redirectBack(request, "error");
      const persisted = await db.prepare(`INSERT INTO onedrive_connections (owner_id,refresh_cipher,access_cipher,access_expires_at,account,drive_id,revision) SELECT $1,$2,$3,$4,$5,$6,1 WHERE COALESCE((SELECT revision FROM onedrive_connections WHERE owner_id=$7),0)=$8 ON CONFLICT(owner_id) DO UPDATE SET refresh_cipher=excluded.refresh_cipher,access_cipher=excluded.access_cipher,access_expires_at=excluded.access_expires_at,account=excluded.account,file_id=CASE WHEN onedrive_connections.drive_id=excluded.drive_id THEN onedrive_connections.file_id ELSE '' END,file_name=CASE WHEN onedrive_connections.drive_id=excluded.drive_id THEN onedrive_connections.file_name ELSE '' END,web_url=CASE WHEN onedrive_connections.drive_id=excluded.drive_id THEN onedrive_connections.web_url ELSE '' END,etag='',synced_etag='',downloaded_etag='',last_sync_error='',drive_id=excluded.drive_id,revision=onedrive_connections.revision+1 WHERE onedrive_connections.revision=$9 RETURNING owner_id`)
        .bind(ownerId, await encrypt(tokens.refreshToken, config.tokenKey, ownerId), await encrypt(tokens.accessToken, config.tokenKey, ownerId), tokens.expiresAt, drive.owner?.user?.email ?? drive.owner?.user?.displayName ?? "Cuenta Microsoft conectada", drive.id, ownerId, session.generation, session.generation).first();
      if (!persisted) return redirectBack(request, "error");
      return redirectBack(request, "connected");
    } catch {
      return redirectBack(request, "error");
    }
  });
}
