import { context, json, route } from "../../_shared";
import { configuration, connection, selectedFile } from "../_core";

export async function GET(request: Request) {
  return route(async () => {
    const { db, ownerId } = await context(request);
    const config = configuration(request);
    const stored = await connection(db, ownerId);
    return json({ configured: config.configured, configurationRequired: !config.configured, missing: config.missing, connected: Boolean(config.configured && stored?.refresh_cipher), account: stored?.account ?? "", selectedFile: stored ? selectedFile(stored) : null, lastSyncAt: stored?.last_sync_at ?? "", lastSyncError: stored?.last_sync_error ?? "" });
  });
}
