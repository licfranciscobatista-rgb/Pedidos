import { context, json, route } from "../../_shared";
import { canWrite, configuration, connection, selectedFile } from "../_core";

export async function GET(request: Request) {
  return route(async () => {
    const { db, ownerId } = await context(request);
    const config = configuration(request);
    const stored = await connection(db, ownerId);
    const pendingWrite = await db.prepare("SELECT file_id,source_etag,target_hash,created_at FROM onedrive_write_jobs WHERE owner_id=$1").bind(ownerId).first<{ file_id: string; source_etag: string; target_hash: string; created_at: string }>();
    return json({ configured: config.configured, configurationRequired: !config.configured, missing: config.missing, connected: Boolean(config.configured && stored?.refresh_cipher), canWrite: canWrite(stored?.granted_scope), writePending: Boolean(pendingWrite), pendingWrite: pendingWrite ? { fileId: pendingWrite.file_id, sourceEtag: pendingWrite.source_etag, targetHash: pendingWrite.target_hash, preparedAt: pendingWrite.created_at } : null, lastWriteAt: stored?.last_write_at || "", account: stored?.account ?? "", selectedFile: stored ? selectedFile(stored) : null, lastSyncAt: stored?.last_sync_at ?? "", lastSyncError: stored?.last_sync_error ?? "" });
  });
}
