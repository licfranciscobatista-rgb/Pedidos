import { ValidationError } from "@/lib/validation";
import { context, route } from "../../_shared";
import { connection, downloadFile, metadata, requireConfig } from "../_core";

export async function GET(request: Request) {
  return route(async () => {
    const { db, ownerId } = await context(request);
    const config = requireConfig(request);
    const stored = await connection(db, ownerId);
    if (!stored?.file_id || !stored.refresh_cipher) throw new ValidationError("Conecta Microsoft y selecciona tu Excel antes de sincronizar.", 409);
    const file = await metadata(db, ownerId, config, stored.file_id);
    const responseHeaders = { "X-OneDrive-Etag": file.eTag!, "X-OneDrive-File-Id": file.id, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
    if (request.headers.get("if-none-match") === file.eTag && stored.synced_etag === file.eTag) return new Response(null, { status: 304, headers: responseHeaders });
    const bytes = await downloadFile(db, ownerId, config, file.id);
    const confirmed = await metadata(db, ownerId, config, file.id);
    if (confirmed.eTag !== file.eTag) throw new ValidationError("El Excel cambió durante la descarga. Inténtalo nuevamente para leer su última versión.", 409);
    const updated = await db.prepare("UPDATE onedrive_connections SET downloaded_etag=$1,etag=$2,last_modified_at=$3 WHERE owner_id=$4 AND file_id=$5 AND revision=$6 AND refresh_cipher<>'' RETURNING owner_id").bind(file.eTag!, file.eTag!, file.lastModifiedDateTime ?? "", ownerId, file.id, stored.revision).first();
    if (!updated) throw new ValidationError("La conexión o el archivo seleccionado cambió. Actualiza la conexión antes de continuar.", 409);
    return new Response(bytes, { headers: { ...responseHeaders, "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": "attachment; filename=onedrive.xlsx" } });
  });
}
