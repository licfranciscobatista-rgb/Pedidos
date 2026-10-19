import { parseText, record, ValidationError } from "@/lib/validation";
import { assertSql, body, context, isTransactionConflict, json, route } from "../../_shared";
import { accessToken, canWrite, connection, downloadFile, fileId, metadata, requireConfig } from "../_core";
import { acknowledgeWrite, bytesHash, prepareWriteback, type WriteJob } from "../_writeback";
import { graphWriteFailure } from "../_graph-error";

export async function POST(request: Request) {
  return route(async () => {
    const { db, ownerId } = await context(request, true);
    const config = requireConfig(request);
    const input = record(await body(request));
    const id = fileId(input.fileId), etag = parseText(input.etag, "Versión de OneDrive", 500, true);
    let stored = await connection(db, ownerId);
    if (!stored?.refresh_cipher || stored.file_id !== id) throw new ValidationError("La conexión o el libro cambió. Actualiza la conexión antes de enviar.", 409);
    const pending = await db.prepare("SELECT * FROM onedrive_write_jobs WHERE owner_id=$1").bind(ownerId).first<WriteJob>();
    if (!canWrite(stored.granted_scope) && !pending) return json({ error: "OneDrive está autorizado solo para lectura. Pulsa Activar envío web → Excel y acepta Files.ReadWrite para guardar los cambios de la web en el libro original.", readOnly: true }, 403);
    if (pending && pending.file_id !== id) return json({ error: "Hay un envío pendiente de otro libro. Selecciona el libro anterior y verifica ese envío antes de cambiar de archivo.", writePending: true }, 409);
    if (pending && pending.connection_revision !== stored.revision) return json({ error: "La cuenta o la conexión cambió durante un envío pendiente. No se confirmará ese envío en la conexión nueva. Revisa el libro original y el registro pendiente antes de continuar.", writePending: true }, 409);
    const current = await metadata(db, ownerId, config, id);
    const source = await downloadFile(db, ownerId, config, id);
    const confirmed = await metadata(db, ownerId, config, id);
    if (confirmed.eTag !== current.eTag) return json({ error: "El Excel cambió durante la descarga. Vuelve a sincronizar antes de enviar cambios.", writePending: Boolean(pending) }, 409);
    if (pending) {
      // A timeout or crash can happen after Microsoft accepted the PUT. Only
      // exact target bytes prove what was written; a newer eTag alone does not.
      if (bytesHash(source) === pending.target_hash) {
        try { return json({ ...await acknowledgeWrite(db, ownerId, pending, current.eTag!), recovered: true }); }
        catch (error) {
          if (isTransactionConflict(error)) {
            const latest = await connection(db, ownerId);
            const remaining = await db.prepare("SELECT owner_id FROM onedrive_write_jobs WHERE owner_id=$1").bind(ownerId).first();
            if (!remaining && latest && latest.synced_etag === current.eTag) return json({ written: 0, etag: current.eTag, lastWriteAt: latest.last_write_at, recovered: true, unchanged: true });
          }
          return json({ error: "Microsoft conserva el envío, pero falta confirmar su registro. Reintenta para verificarlo sin volver a escribir el libro.", writePending: true, retryable: true, retryAfterSeconds: 120 }, 502);
        }
      }
      if (current.eTag !== pending.source_etag) return json({ error: "El libro cambió mientras había un envío pendiente y sus bytes no coinciden con el envío preparado. No se sobrescribió. Revisa las dos versiones antes de resolver este conflicto.", writePending: true }, 409);
      const leaseRemaining = 120000 - (Date.now() - Date.parse(pending.created_at));
      if (leaseRemaining > 0) return json({ error: "Hay un envío en curso o pendiente de confirmar. Espera dos minutos y vuelve a comprobar; no se repetirá la escritura mientras tanto.", writePending: true, retryable: true, retryAfterSeconds: Math.max(60, Math.ceil(leaseRemaining / 1000)) }, 409);
      // The original source still exists after the lease expired: no completed
      // target is present, so the abandoned job can safely be prepared again.
      try {
        await db.batch([
          assertSql(db, "EXISTS(SELECT 1 FROM onedrive_write_jobs WHERE owner_id=$1 AND file_id=$2 AND target_hash=$3 AND created_at=$4 AND connection_revision=$5)", [ownerId, id, pending.target_hash, pending.created_at, pending.connection_revision]),
          db.prepare("DELETE FROM onedrive_write_jobs WHERE owner_id=$1 AND file_id=$2 AND target_hash=$3 AND created_at=$4 AND connection_revision=$5").bind(ownerId, id, pending.target_hash, pending.created_at, pending.connection_revision),
        ]);
      } catch (error) {
        if (isTransactionConflict(error)) return json({ error: "Otra solicitud ya está recuperando el envío pendiente. Actualiza su estado antes de volver a intentar.", writePending: true }, 409);
        throw error;
      }
      stored = await connection(db, ownerId);
      if (!stored?.refresh_cipher || stored.file_id !== id) throw new ValidationError("La conexión cambió durante la recuperación.", 409);
    }
    if (!canWrite(stored.granted_scope)) return json({ error: "Activa el permiso de escritura para enviar nuevos cambios. La lectura de Excel sigue disponible.", readOnly: true }, 403);
    if (stored.synced_etag !== etag || current.eTag !== etag) return json({ error: "Primero lee e importa la versión actual del Excel. No se enviarán cambios sobre una versión distinta.", requiresPull: true }, 409);
    const prepared = await prepareWriteback(db, ownerId, id, source);
    if (!prepared.count) return json({ written: 0, unchanged: true, etag, lastWriteAt: stored.last_write_at || "" });
    const job: WriteJob = { owner_id: ownerId, file_id: id, source_etag: etag, target_hash: bytesHash(prepared.bytes), snapshot_json: JSON.stringify(prepared.snapshot), connection_revision: stored.revision, created_at: new Date().toISOString() };
    try {
      await db.batch([
        assertSql(db, "EXISTS(SELECT 1 FROM onedrive_connections WHERE owner_id=$1 AND file_id=$2 AND revision=$3 AND synced_etag=$4 AND refresh_cipher<>'')", [ownerId, id, stored.revision, etag]),
        assertSql(db, "NOT EXISTS(SELECT 1 FROM onedrive_write_jobs WHERE owner_id=$1)", [ownerId]),
        db.prepare("INSERT INTO onedrive_write_jobs(owner_id,file_id,source_etag,target_hash,snapshot_json,connection_revision,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)").bind(ownerId, id, etag, job.target_hash, job.snapshot_json, job.connection_revision, job.created_at),
      ]);
    } catch (error) {
      if (isTransactionConflict(error)) return json({ error: "Otra sincronización cambió la conexión o inició un envío. Actualiza el estado y vuelve a intentar.", writePending: true }, 409);
      throw error;
    }
    const latest = await connection(db, ownerId);
    if (!latest?.refresh_cipher || latest.file_id !== id || latest.revision !== job.connection_revision || !canWrite(latest.granted_scope)) {
      await db.prepare("DELETE FROM onedrive_write_jobs WHERE owner_id=$1 AND target_hash=$2 AND created_at=$3 AND connection_revision=$4").bind(ownerId, job.target_hash, job.created_at, job.connection_revision).run();
      return json({ error: "La conexión cambió antes del envío. No se escribió en OneDrive." }, 409);
    }
    let response: Response;
    try {
      const token = await accessToken(db, ownerId, config);
      response = await fetch(`https://graph.microsoft.com/v1.0/me/drive/items/${encodeURIComponent(id)}/content`, {
        method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "If-Match": etag },
        body: prepared.bytes as BodyInit, redirect: "manual", signal: AbortSignal.timeout(60000),
      });
    } catch {
      return json({ error: "No se pudo confirmar la respuesta de Microsoft. El envío quedó pendiente: reintenta para verificar el archivo antes de repetirlo.", writePending: true, retryable: true, retryAfterSeconds: 120 }, 502);
    }
    if (!response.ok) {
      const failure = await graphWriteFailure(response);
      if (!failure.preserveJob) await db.prepare("DELETE FROM onedrive_write_jobs WHERE owner_id=$1 AND target_hash=$2 AND created_at=$3 AND connection_revision=$4").bind(ownerId, job.target_hash, job.created_at, job.connection_revision).run();
      const reply = json(failure.body, failure.status);
      if (failure.retryAfter) reply.headers.set("Retry-After", failure.retryAfter);
      return reply;
    }
    const written = await response.json().catch(() => ({})) as { id?: string; eTag?: string };
    if (written.id !== id || !written.eTag) return json({ error: "Microsoft recibió el archivo, pero no devolvió una versión verificable. Reintenta para comprobar sus bytes sin escribirlo otra vez.", writePending: true, retryable: true, retryAfterSeconds: 120 }, 502);
    try { return json(await acknowledgeWrite(db, ownerId, job, written.eTag)); }
    catch { return json({ error: "El Excel se guardó, pero falta confirmar el registro del envío. Reintenta para verificar la copia exacta sin repetirla.", writePending: true, retryable: true, retryAfterSeconds: 120 }, 502); }
  });
}
