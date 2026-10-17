import { context, route } from "../../_shared";
import { connection, encrypt, hash, oauthCookie, randomToken, requireConfig } from "../_core";

export async function GET(request: Request) {
  return route(async () => {
    const { db, ownerId } = await context(request, true);
    const config = requireConfig(request);
    const state = randomToken();
    const verifier = randomToken();
    const challenge = await hash(verifier);
    const generation = (await connection(db, ownerId))?.revision ?? 0;
    await db.batch([
      db.prepare("DELETE FROM onedrive_oauth_states WHERE owner_id=$1 OR expires_at<$2").bind(ownerId, Date.now()),
      db.prepare("INSERT INTO onedrive_oauth_states (id,owner_id,verifier_cipher,expires_at) VALUES ($1,$2,$3,$4)").bind(await hash(state), ownerId, await encrypt(JSON.stringify({ verifier, generation }), config.tokenKey, ownerId), Date.now() + 10 * 60_000),
    ]);
    const authorize = new URL("https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize");
    authorize.search = new URLSearchParams({ client_id: config.clientId, response_type: "code", redirect_uri: config.redirectUri, response_mode: "query", scope: "https://graph.microsoft.com/Files.Read offline_access", state, code_challenge: challenge, code_challenge_method: "S256", prompt: "select_account" }).toString();
    return new Response(null, { status: 302, headers: { Location: authorize.href, "Set-Cookie": oauthCookie(state), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  });
}
