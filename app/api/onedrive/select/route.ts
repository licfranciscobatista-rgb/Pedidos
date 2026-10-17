import { record, ValidationError } from "@/lib/validation";
import { body, context, json, route } from "../../_shared";
import { connection, fileId, metadata, requireConfig, selectedFile } from "../_core";

export async function POST(request: Request) {
  return route(async () => {
    const { db, ownerId } = await context(request, true);
    const config = requireConfig(request);
    const id = fileId(record(await body(request)).fileId);
    const before = await connection(db, ownerId);
    if (!before?.refresh_cipher) throw new ValidationError("Conecta tu cuenta de Microsoft.", 401);
    const file = await metadata(db, ownerId, config, id);
    const result = await db.prepare("UPDATE onedrive_connections SET file_id=$1,file_name=$2,web_url=$3,last_modified_at=$4,etag=$5,synced_etag='',downloaded_etag='',last_sync_at='',last_sync_error='',revision=revision+1 WHERE owner_id=$6 AND revision=$7 AND refresh_cipher<>'' RETURNING owner_id").bind(file.id, file.name, file.webUrl ?? "", file.lastModifiedDateTime ?? "", file.eTag!, ownerId, before.revision).first();
    if (!result) throw new ValidationError("La cuenta se desconectó. Vuelve a conectar Microsoft.", 409);
    const stored = await connection(db, ownerId);
    return json({ selectedFile: stored ? selectedFile(stored) : null });
  });
}
