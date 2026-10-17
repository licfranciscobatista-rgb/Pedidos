import { parseImport, parseText, record, ValidationError } from "@/lib/validation";
import { buildImportStatements, importChanges } from "../../_import";
import { assertSql, body, context, isTransactionConflict, json, route } from "../../_shared";
import { connection, fileId, metadata, requireConfig } from "../_core";
import { planSync } from "../_sync";

export async function POST(request: Request) {
  return route(async () => {
    const { db, ownerId } = await context(request, true);
    const config = requireConfig(request);
    let requestedId = "";
    let requestedEtag = "";
    try {
      const source = record(await body(request));
      const id = fileId(source.fileId);
      const etag = parseText(source.etag, "Versión de OneDrive", 500, true);
      requestedId = id;
      requestedEtag = etag;
      if (source.generatedIds !== 0) throw new ValidationError("El Excel necesita ID Pedido e ID Pago permanentes. Completa los identificadores antes de activar la sincronización para evitar registros duplicados.");
      const stored = await connection(db, ownerId);
      if (!stored?.refresh_cipher || stored.file_id !== id) throw new ValidationError("La conexión o el Excel seleccionado cambió. Vuelve a seleccionar el archivo.", 409);
      if (stored.synced_etag === etag) return json({ unchanged: true, changes: { createdOrders: 0, updatedOrders: 0, createdPayments: 0, createdExchanges: 0 }, lastSyncAt: stored.last_sync_at });
      if (stored.downloaded_etag !== etag) throw new ValidationError("Descarga la versión actual del archivo desde la conexión antes de sincronizar.", 409);
      const currentFile = await metadata(db, ownerId, config, id);
      if (currentFile.eTag !== etag) throw new ValidationError("El Excel se modificó mientras se leía. Descarga su última versión y vuelve a intentarlo.", 409);
      const input = parseImport(source, true);
      const plan = await planSync(db, ownerId, id, input);
      if (plan.conflicts.length) {
        const message = "No se sincronizó ninguna fila: hay cambios en la web que requieren revisión. Se conservaron todos los datos existentes.";
        await db.prepare("UPDATE onedrive_connections SET last_sync_error=$1 WHERE owner_id=$2 AND file_id=$3").bind(message, ownerId, id).run();
        return json({ error: message, conflicts: plan.conflicts }, 409);
      }
      const expected = JSON.stringify(plan.expectations);
      const baselines = JSON.stringify(plan.nextBaselines);
      const ledgerExpectations = JSON.stringify(plan.ledgerExpectations);
      const ledgerBaselines = JSON.stringify(plan.nextLedgerBaselines);
      const prefix = [
        assertSql(db, "EXISTS (SELECT 1 FROM onedrive_connections WHERE owner_id=$1 AND file_id=$2 AND downloaded_etag=$3 AND revision=$4 AND refresh_cipher<>'')", [ownerId, id, etag, stored.revision]),
        assertSql(db, `NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements($2::jsonb) i
          LEFT JOIN orders o ON o.owner_id=$1 AND o.id=i.value->>'id'
          WHERE NOT (o.revision IS NOT DISTINCT FROM (i.value->>'revision')::integer)
        )`, [ownerId, expected]),
        assertSql(db, `NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements($3::jsonb) i
          LEFT JOIN onedrive_baselines b ON b.owner_id=$1 AND b.file_id=$2 AND b.order_id=i.value->>'id'
          WHERE NOT (b.remote_hash IS NOT DISTINCT FROM i.value->>'baselineHash'
            AND b.local_revision IS NOT DISTINCT FROM (i.value->>'baselineRevision')::integer)
        )`, [ownerId, id, expected]),
        assertSql(db, `NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements($2::jsonb) i
          WHERE (CASE WHEN i.value->>'kind'='payment'
            THEN EXISTS (SELECT 1 FROM payments p WHERE p.owner_id=$1 AND p.id=i.value->>'id')
            ELSE EXISTS (SELECT 1 FROM exchanges e WHERE e.owner_id=$1 AND e.id=i.value->>'id')
          END) IS DISTINCT FROM (i.value->>'present')::boolean
        )`, [ownerId, ledgerExpectations]),
      ];
      const statements = buildImportStatements(db, ownerId, plan.input);
      const lastSyncAt = new Date().toISOString();
      const result = await db.batch([
        ...prefix, ...statements,
        db.prepare(`INSERT INTO onedrive_baselines (owner_id,file_id,order_id,remote_hash,local_revision)
          SELECT $1,$2,value->>'orderId',value->>'remoteHash',(value->>'localRevision')::integer
          FROM jsonb_array_elements($3::jsonb)
          ON CONFLICT(owner_id,file_id,order_id) DO UPDATE
          SET remote_hash=excluded.remote_hash,local_revision=excluded.local_revision`).bind(ownerId, id, baselines),
        db.prepare(`INSERT INTO onedrive_ledger_baselines (owner_id,file_id,kind,id,fingerprint)
          SELECT $1,$2,value->>'kind',value->>'id',value->>'fingerprint'
          FROM jsonb_array_elements($3::jsonb)
          ON CONFLICT(owner_id,file_id,kind,id) DO NOTHING`).bind(ownerId, id, ledgerBaselines),
        db.prepare("UPDATE onedrive_connections SET synced_etag=$1,etag=$2,last_sync_at=$3,last_sync_error='',revision=revision+1 WHERE owner_id=$4 AND file_id=$5 AND revision=$6").bind(etag, etag, lastSyncAt, ownerId, id, stored.revision),
      ]);
      return json({ changes: importChanges(result.slice(prefix.length), plan.input), lastSyncAt });
    } catch (error) {
      if (isTransactionConflict(error) && requestedEtag) {
        const latest = await connection(db, ownerId);
        if (latest?.file_id === requestedId && latest.synced_etag === requestedEtag) return json({ unchanged: true, changes: { createdOrders: 0, updatedOrders: 0, createdPayments: 0, createdExchanges: 0 }, lastSyncAt: latest.last_sync_at });
      }
      const safeMessage = isTransactionConflict(error) ? "No se sincronizó ninguna fila: un pedido cambió, un movimiento existente fue alterado o una devolución no es válida. Actualiza el archivo y revisa el conflicto." : error instanceof ValidationError ? error.message : "No se pudo sincronizar OneDrive. Inténtalo nuevamente.";
      await db.prepare("UPDATE onedrive_connections SET last_sync_error=$1 WHERE owner_id=$2").bind(safeMessage, ownerId).run();
      if (isTransactionConflict(error)) return json({ error: safeMessage, conflicts: [] }, 409);
      throw error;
    }
  });
}
