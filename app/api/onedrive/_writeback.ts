import { createHash } from "node:crypto";
import type { Database, PreparedStatement } from "@/lib/db";
import type { Order, Payment, Exchange, Invoice } from "@/lib/types";
import type { BusinessData, Client, Quote, InvoiceDraft } from "@/lib/business-types";
import { businessFingerprint, businessReadStatements } from "@/lib/business-import";
import { parseExcel } from "@/lib/excel";
import { patchWorkbook, type WorkbookPatch } from "@/lib/excel-writeback";
import { embedStoredOrderPhotos } from "@/lib/excel-photo-writeback";
import { parseExchange, parsePayment, ValidationError } from "@/lib/validation";
import { assertSql, EXCHANGE_COLUMNS, INVOICE_COLUMNS, invoiceFromRow, ORDER_COLUMNS, PAYMENT_COLUMNS } from "../_shared";
import { hash } from "./_core";
import { orderCanonical } from "./_sync";

type OrderBaseline = { order_id: string; remote_hash: string; local_revision: number };
type BusinessBaseline = { kind: keyof BusinessData; id: string; fingerprint: string; local_revision: number };
type LedgerBaseline = { kind: string; id: string; fingerprint: string };
type OutputBaseline = { kind: string; id: string; fingerprint: string };
type ArchiveInvoice = Invoice & { sourceDraftId?: string; clientId?: string };
export type WriteSnapshot = WorkbookPatch & { invoices: ArchiveInvoice[] };
export type WriteJob = { owner_id: string; file_id: string; source_etag: string; target_hash: string; snapshot_json: string; connection_revision: number; created_at: string };
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}` : JSON.stringify(value);
export const bytesHash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
export const invoiceFingerprint = (value: Invoice) => createHash("sha256").update(canonical(value)).digest("hex");

/** Capture a consistent owner snapshot and choose only web changes. The source
 * version must already have completed its atomic inbound import. */
export async function prepareWriteback(db: Database, ownerId: string, fileId: string, source: Uint8Array): Promise<{ bytes: Uint8Array; snapshot: WriteSnapshot; count: number }> {
  const preview = await parseExcel(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as ArrayBuffer);
  if (preview.errors.length) throw new ValidationError(`No se enviaron cambios: corrige el Excel antes de escribir. ${preview.errors.slice(0, 4).join(" ")}`, 409);
  const result = await db.batch([
    db.prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE owner_id=$1 ORDER BY id`).bind(ownerId),
    db.prepare(`SELECT ${PAYMENT_COLUMNS} FROM payments WHERE owner_id=$1 ORDER BY id`).bind(ownerId),
    db.prepare(`SELECT ${EXCHANGE_COLUMNS} FROM exchanges WHERE owner_id=$1 ORDER BY id`).bind(ownerId),
    ...businessReadStatements(db, ownerId),
    db.prepare(`SELECT ${INVOICE_COLUMNS} FROM invoices WHERE owner_id=$1 ORDER BY sequence`).bind(ownerId),
    db.prepare("SELECT order_id,remote_hash,local_revision FROM onedrive_baselines WHERE owner_id=$1 AND file_id=$2").bind(ownerId, fileId),
    db.prepare("SELECT kind,id,fingerprint,local_revision FROM business_baselines WHERE owner_id=$1 AND file_id=$2").bind(ownerId, fileId),
    db.prepare("SELECT kind,id,fingerprint FROM onedrive_ledger_baselines WHERE owner_id=$1 AND file_id=$2").bind(ownerId, fileId),
    db.prepare("SELECT kind,id,fingerprint FROM onedrive_output_baselines WHERE owner_id=$1 AND file_id=$2").bind(ownerId, fileId),
    db.prepare(`SELECT i.id,i.source_draft_id AS "sourceDraftId",d.client_id AS "clientId" FROM invoices i LEFT JOIN invoice_drafts d ON d.owner_id=i.owner_id AND d.id=i.source_draft_id WHERE i.owner_id=$1`).bind(ownerId),
  ]);
  const orderBaselines = new Map((result[7].results as OrderBaseline[]).map(row => [row.order_id, row]));
  const businessBaselines = new Map((result[8].results as BusinessBaseline[]).map(row => [`${row.kind}:${row.id}`, row]));
  const ledgerBaselines = new Map((result[9].results as LedgerBaseline[]).map(row => [`${row.kind}:${row.id}`, row]));
  const outputBaselines = new Map((result[10].results as OutputBaseline[]).map(row => [row.id, row.fingerprint]));
  const archiveLinks = new Map((result[11].results as { id: string; sourceDraftId?: string; clientId?: string }[]).map(row => [row.id, row]));
  const allClients = result[3].results as Client[];
  const clients = new Map(allClients.map(client => [client.id, client]));
  const snapshot: WriteSnapshot = { orders: [], payments: [], exchanges: [], clients: [], quotes: [], invoiceDrafts: [], invoices: [] };
  for (const record of result[0].results as Order[]) {
    const baseline = orderBaselines.get(record.id);
    if (!baseline || baseline.local_revision !== record.revision || baseline.remote_hash !== await hash(orderCanonical(record))) {
      const master = record.clientId ? clients.get(record.clientId) : undefined;
      snapshot.orders.push(master ? { ...record, client: master.name, phone: master.phone } : record);
    }
  }
  for (const [kind, rows] of [["clients", allClients], ["quotes", result[4].results as Quote[]], ["invoiceDrafts", result[5].results as InvoiceDraft[]]] as const) {
    for (const record of rows) {
      const baseline = businessBaselines.get(`${kind}:${record.id}`);
      if (!baseline || baseline.local_revision !== record.revision || baseline.fingerprint !== businessFingerprint(kind, record)) (snapshot[kind] as (Client | Quote | InvoiceDraft)[]).push(record);
    }
  }
  for (const record of result[1].results as Payment[]) {
    const fingerprint = await hash(JSON.stringify(parsePayment(record)));
    const baseline = ledgerBaselines.get(`payment:${record.id}`);
    if (baseline && baseline.fingerprint !== fingerprint) throw new ValidationError(`El pago ${record.id} cambió después de sincronizar. Revisa el movimiento antes de enviar.`, 409);
    if (!baseline) snapshot.payments.push(record);
  }
  for (const record of result[2].results as Exchange[]) {
    const fingerprint = await hash(JSON.stringify(parseExchange(record)));
    const baseline = ledgerBaselines.get(`exchange:${record.id}`);
    if (baseline && baseline.fingerprint !== fingerprint) throw new ValidationError(`El cambio ${record.id} fue alterado. Revisa el historial antes de enviar.`, 409);
    if (!baseline) snapshot.exchanges!.push(record);
  }
  for (const row of result[6].results) {
    const invoice = invoiceFromRow(row);
    const link = archiveLinks.get(invoice.id);
    const record = { ...invoice, ...(link?.sourceDraftId ? { sourceDraftId: link.sourceDraftId } : {}), ...(link?.clientId ? { clientId: link.clientId } : {}) };
    if (outputBaselines.get(record.id) !== invoiceFingerprint(record)) snapshot.invoices.push(record);
  }
  const count = Object.values(snapshot).reduce((total, rows) => total + rows.length, 0);
  if (!count) return { bytes: source, snapshot, count: 0 };
  // The writer retains unrelated parts and does not treat omitted rows as deletes.
  let patched: Uint8Array;
  try { patched = await patchWorkbook(source, snapshot); }
  catch (error) { if (error instanceof ValidationError) throw error; throw new ValidationError(`${error instanceof Error ? error.message : "No se pudo preparar el Excel."} No se escribió en OneDrive.`, 409); }
  const bytes = await embedStoredOrderPhotos(patched, ownerId, snapshot.orders);
  if (bytes.byteLength > 5 * 1024 * 1024) throw new ValidationError("Los cambios harían que el Excel supere 5 MB. Reduce las fotos o archiva un período antes de enviar.", 413);
  const check = await parseExcel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  if (check.errors.length) throw new ValidationError(`El archivo resultante no superó la comprobación. No se escribió en OneDrive. ${check.errors.slice(0, 3).join(" ")}`, 409);
  for (const record of snapshot.orders) {
    const written = check.orders.find(row => row.id === record.id);
    if (!written || orderCanonical(written) !== orderCanonical(record)) throw new ValidationError(`No se pudo comprobar el pedido ${record.id} dentro del Excel. No se escribió el libro. Revisa el ID Cliente y la foto de esa fila.`, 409);
  }
  for (const kind of ["clients", "quotes", "invoiceDrafts"] as const) for (const record of snapshot[kind]) {
    const written = check[kind].find(row => row.id === record.id);
    if (!written || businessFingerprint(kind, written) !== businessFingerprint(kind, record)) throw new ValidationError(`No se pudo comprobar ${record.id} después de preparar el libro. No se escribió en OneDrive.`, 409);
  }
  for (const record of snapshot.payments) {
    const written = check.payments.find(row => row.id === record.id);
    if (!written || JSON.stringify(parsePayment(written)) !== JSON.stringify(parsePayment(record))) throw new ValidationError(`No se pudo comprobar el pago ${record.id} dentro del Excel. No se escribió en OneDrive.`, 409);
  }
  for (const record of snapshot.exchanges || []) {
    const written = check.exchanges.find(row => row.id === record.id);
    if (!written || JSON.stringify(parseExchange(written)) !== JSON.stringify(parseExchange(record))) throw new ValidationError(`No se pudo comprobar el cambio ${record.id} dentro del Excel. No se escribió en OneDrive.`, 409);
  }
  return { bytes, snapshot, count };
}

/** Acknowledge the exact captured records, even if the user changed them again
 * while the external PUT was in flight. Those newer revisions remain pending. */
export async function acknowledgeWrite(db: Database, ownerId: string, job: WriteJob, etag: string) {
  const snapshot = JSON.parse(job.snapshot_json) as WriteSnapshot;
  const fileId = job.file_id, statements: PreparedStatement[] = [
    assertSql(db, "EXISTS(SELECT 1 FROM onedrive_write_jobs WHERE owner_id=$1 AND file_id=$2 AND source_etag=$3 AND target_hash=$4 AND created_at=$5 AND connection_revision=$6)", [ownerId, fileId, job.source_etag, job.target_hash, job.created_at, job.connection_revision]),
    assertSql(db, "EXISTS(SELECT 1 FROM onedrive_connections WHERE owner_id=$1 AND file_id=$2 AND refresh_cipher<>'' AND revision=$3)", [ownerId, fileId, job.connection_revision]),
  ];
  for (const record of snapshot.orders) statements.push(db.prepare("INSERT INTO onedrive_baselines(owner_id,file_id,order_id,remote_hash,local_revision) VALUES($1,$2,$3,$4,$5) ON CONFLICT(owner_id,file_id,order_id) DO UPDATE SET remote_hash=excluded.remote_hash,local_revision=excluded.local_revision").bind(ownerId, fileId, record.id, await hash(orderCanonical(record)), record.revision));
  for (const kind of ["clients", "quotes", "invoiceDrafts"] as const) for (const record of snapshot[kind]) statements.push(db.prepare("INSERT INTO business_baselines(owner_id,file_id,kind,id,fingerprint,local_revision) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(owner_id,file_id,kind,id) DO UPDATE SET fingerprint=excluded.fingerprint,local_revision=excluded.local_revision").bind(ownerId, fileId, kind, record.id, businessFingerprint(kind, record), record.revision));
  for (const [kind, rows] of [["payment", snapshot.payments], ["exchange", snapshot.exchanges || []]] as const) for (const record of rows) statements.push(db.prepare("INSERT INTO onedrive_ledger_baselines(owner_id,file_id,kind,id,fingerprint) VALUES($1,$2,$3,$4,$5) ON CONFLICT(owner_id,file_id,kind,id) DO UPDATE SET fingerprint=excluded.fingerprint").bind(ownerId, fileId, kind, record.id, await hash(JSON.stringify(kind === "payment" ? parsePayment(record) : parseExchange(record)))));
  for (const record of snapshot.invoices) statements.push(db.prepare("INSERT INTO onedrive_output_baselines(owner_id,file_id,kind,id,fingerprint) VALUES($1,$2,'invoice',$3,$4) ON CONFLICT(owner_id,file_id,kind,id) DO UPDATE SET fingerprint=excluded.fingerprint").bind(ownerId, fileId, record.id, invoiceFingerprint(record)));
  const now = new Date().toISOString();
  statements.push(db.prepare("UPDATE onedrive_connections SET etag=$1,downloaded_etag=$1,synced_etag=$1,last_sync_at=$2,last_write_at=$2,last_sync_error='',revision=revision+1 WHERE owner_id=$3 AND file_id=$4").bind(etag, now, ownerId, fileId));
  statements.push(db.prepare("DELETE FROM onedrive_write_jobs WHERE owner_id=$1 AND file_id=$2 AND target_hash=$3 AND created_at=$4 AND connection_revision=$5").bind(ownerId, fileId, job.target_hash, job.created_at, job.connection_revision));
  await db.batch(statements);
  return { written: Object.values(snapshot).reduce((total, rows) => total + rows.length, 0), etag, lastWriteAt: now };
}
