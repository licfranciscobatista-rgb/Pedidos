import { context, json, route } from "../../_shared";

export async function POST(request: Request) {
  return route(async () => {
    const { db, ownerId } = await context(request, true);
    await db.batch([
      db.prepare("DELETE FROM onedrive_oauth_states WHERE owner_id=$1").bind(ownerId),
      db.prepare("INSERT INTO onedrive_connections (owner_id,revision) VALUES ($1,1) ON CONFLICT(owner_id) DO UPDATE SET refresh_cipher='',access_cipher='',access_expires_at=0,downloaded_etag='',last_sync_error='',revision=onedrive_connections.revision+1").bind(ownerId),
    ]);
    return json({ disconnected: true });
  });
}
