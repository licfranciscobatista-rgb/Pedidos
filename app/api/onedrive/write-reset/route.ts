import { parseText, record, ValidationError } from "@/lib/validation";
import { assertSql, body, context, isTransactionConflict, json, route } from "../../_shared";
import type { WriteJob } from "../_writeback";

/** Explicit recovery action. This discards only the local confirmation job;
 * it never claims to undo a request that Microsoft may already have accepted. */
export async function POST(request: Request) {
  return route(async () => {
    const { db, ownerId } = await context(request, true);
    const source = record(await body(request));
    const expectedHash = parseText(source.expectedTargetHash, "Envío pendiente", 64, true);
    const preparedAt = parseText(source.preparedAt, "Fecha del envío pendiente", 40, true);
    if (!/^[a-f0-9]{64}$/.test(expectedHash) || !Number.isFinite(Date.parse(preparedAt))) throw new ValidationError("Actualiza el estado del envío antes de descartarlo.");
    if (source.reviewed !== true) throw new ValidationError("Confirma que revisaste el Excel original y los registros de la web antes de descartar la confirmación pendiente.");
    const job = await db.prepare("SELECT * FROM onedrive_write_jobs WHERE owner_id=$1").bind(ownerId).first<WriteJob>();
    if (!job || job.target_hash !== expectedHash || job.created_at !== preparedAt) throw new ValidationError("El envío pendiente cambió o ya se confirmó. Actualiza el estado antes de continuar.", 409);
    if (Date.now() - Date.parse(job.created_at) < 120000) throw new ValidationError("Espera dos minutos desde que se preparó el envío antes de descartar su confirmación. Microsoft todavía podría estar procesándolo; después revisa el Excel original.", 409);
    try {
      await db.batch([
        assertSql(db, "EXISTS(SELECT 1 FROM onedrive_write_jobs WHERE owner_id=$1 AND target_hash=$2 AND created_at=$3)", [ownerId, expectedHash, preparedAt]),
        db.prepare("DELETE FROM onedrive_write_jobs WHERE owner_id=$1 AND target_hash=$2 AND created_at=$3").bind(ownerId, expectedHash, preparedAt),
        db.prepare("UPDATE onedrive_connections SET etag='',synced_etag='',downloaded_etag='',last_sync_error='',revision=revision+1 WHERE owner_id=$1").bind(ownerId),
        db.prepare("INSERT INTO activities(owner_id,id,at,kind,summary,detail) VALUES($1,$2,$3,$4,$5,$6)").bind(ownerId, crypto.randomUUID(), new Date().toISOString(), "Sincronización revisada", "Se descartó la confirmación pendiente de un envío después de revisar el Excel.", JSON.stringify({ fileId: job.file_id, sourceEtag: job.source_etag, targetHash: job.target_hash, preparedAt: job.created_at, note: "Solo se eliminó el registro de confirmación. No se modificaron pedidos, pagos, documentos ni versiones de referencia. Se requiere volver a leer el Excel." })),
      ]);
    } catch (error) { if (isTransactionConflict(error)) throw new ValidationError("Otra operación cambió el envío. Actualiza su estado antes de continuar.", 409); throw error; }
    return json({ cleared: true, requiresPull: true, message: "Confirmación pendiente descartada. Los registros de la web se conservaron; vuelve a leer el Excel antes de enviar nuevos cambios. Esto no revierte un archivo que Microsoft ya haya recibido." });
  });
}
