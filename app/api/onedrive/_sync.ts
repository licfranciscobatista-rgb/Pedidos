import type { Database } from "@/lib/db";
import type { Exchange, Order, Payment } from "@/lib/types";
import { parseExchange, parseOrder, parsePayment } from "@/lib/validation";
import type { ImportInput } from "../_import";
import { EXCHANGE_COLUMNS, ORDER_COLUMNS, PAYMENT_COLUMNS } from "../_shared";
import { hash } from "./_core";

type Baseline = { order_id: string; remote_hash: string; local_revision: number };
export type SyncConflict = { orderId: string; client: string; article: string; reason: string };
export type SyncExpectation = { id: string; revision: number | null; baselineHash: string | null; baselineRevision: number | null };

export function orderCanonical(order: Order) {
  const fields = parseOrder(order, "import");
  const { revision: _revision, ...business } = fields;
  void _revision;
  // Name and phone are derived from the linked client. A client rename must
  // not turn an unchanged article into a conflicting Excel edit.
  if (fields.clientId) {
    const { client: _client, phone: _phone, ...linked } = business;
    void _client; void _phone;
    return JSON.stringify(linked);
  }
  return JSON.stringify(business);
}

export async function planSync(db: Database, ownerId: string, fileId: string, input: ImportInput, options: { allowWebChanges?: boolean } = {}) {
  const [currentResult, baselineResult, paymentsResult, exchangesResult, ledgerBaselinesResult] = await db.batch([
    db.prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE owner_id=$1`).bind(ownerId),
    db.prepare("SELECT order_id,remote_hash,local_revision FROM onedrive_baselines WHERE owner_id=$1 AND file_id=$2").bind(ownerId, fileId),
    db.prepare(`SELECT ${PAYMENT_COLUMNS} FROM payments WHERE owner_id=$1`).bind(ownerId),
    db.prepare(`SELECT ${EXCHANGE_COLUMNS} FROM exchanges WHERE owner_id=$1`).bind(ownerId),
    db.prepare("SELECT kind,id,fingerprint FROM onedrive_ledger_baselines WHERE owner_id=$1 AND file_id=$2").bind(ownerId, fileId),
  ]);
  const current = new Map((currentResult.results as Order[]).map(order => [order.id, order]));
  const baselines = new Map((baselineResult.results as Baseline[]).map(row => [row.order_id, row]));
  const orders: Order[] = [];
  const expectations: SyncExpectation[] = [];
  const nextBaselines: { orderId: string; remoteHash: string; localRevision: number }[] = [];
  const conflicts: SyncConflict[] = [];
  const ledgerExpectations: { kind: string; id: string; present: boolean }[] = [];
  const nextLedgerBaselines: { kind: string; id: string; fingerprint: string }[] = [];
  const currentPayments = new Map((paymentsResult.results as Payment[]).map(item => [item.id, item]));
  const currentExchanges = new Map((exchangesResult.results as Exchange[]).map(item => [item.id, item]));
  const ledgerBaselines = new Map((ledgerBaselinesResult.results as { kind: string; id: string; fingerprint: string }[]).map(item => [`${item.kind}:${item.id}`, item]));
  for (const incoming of input.orders) {
    const local = current.get(incoming.id);
    const baseline = baselines.get(incoming.id);
    const remoteCanonical = orderCanonical(incoming);
    const remoteHash = await hash(remoteCanonical);
    const equal = local && orderCanonical(local) === remoteCanonical;
    const preserveWeb = Boolean(options.allowWebChanges && local && baseline && remoteHash === baseline.remote_hash);
    let reason = "";
    if (!local && baseline) reason = "El artículo fue eliminado en la web después de sincronizarse. No se volverá a crear automáticamente.";
    else if (local && !equal && baseline && local.revision !== baseline.local_revision && !preserveWeb) reason = "El artículo se modificó en la web después de la última sincronización. Revisa ambas versiones antes de continuar.";
    else if (local && !equal && baseline && remoteHash === baseline.remote_hash && !preserveWeb) reason = "La web contiene datos distintos del último Excel importado. No se sobrescribirán automáticamente.";
    else if (local && !equal && !baseline && (incoming.revision <= 0 || incoming.revision !== local.revision)) reason = "Este identificador ya existe en la web sin una sincronización previa y los datos difieren. Usa la revisión actual del pedido para vincularlo.";
    if (reason) { conflicts.push({ orderId: incoming.id, client: incoming.client, article: incoming.article, reason }); continue; }
    const expectedRevision = local?.revision ?? null;
    orders.push(preserveWeb && local ? local : { ...incoming, revision: local?.revision ?? 0 });
    expectations.push({ id: incoming.id, revision: expectedRevision, baselineHash: baseline?.remote_hash ?? null, baselineRevision: baseline?.local_revision ?? null });
    nextBaselines.push({ orderId: incoming.id, remoteHash, localRevision: preserveWeb && !equal ? baseline!.local_revision : local ? local.revision + (equal ? 0 : 1) : 1 });
  }
  for (const [kind, incomingItems] of [["payment", input.payments], ["exchange", input.exchanges]] as const) {
    for (const incoming of incomingItems) {
      const baseline = ledgerBaselines.get(`${kind}:${incoming.id}`);
      const local = kind === "payment" ? currentPayments.get(incoming.id) : currentExchanges.get(incoming.id);
      const canonicalIncoming = JSON.stringify(kind === "payment" ? parsePayment(incoming) : parseExchange(incoming));
      const fingerprint = await hash(canonicalIncoming);
      let reason = "";
      if (baseline && !local) reason = `El movimiento ${incoming.id} fue eliminado en la web. No se volverá a registrar automáticamente desde el Excel.`;
      else if (baseline && baseline.fingerprint !== fingerprint) reason = `El movimiento ${incoming.id} ya se importó con otros datos. Conserva el registro anterior y usa un ID nuevo para un movimiento adicional.`;
      else if (local && JSON.stringify(kind === "payment" ? parsePayment(local) : parseExchange(local)) !== canonicalIncoming) reason = `El movimiento ${incoming.id} ya está registrado en la web con otros datos. No se modificará automáticamente.`;
      if (reason) {
        const associated = current.get(incoming.orderId) ?? input.orders.find(item => item.id === incoming.orderId);
        conflicts.push({ orderId: incoming.orderId, client: associated?.client ?? "", article: associated?.article ?? "", reason });
      }
      ledgerExpectations.push({ kind, id: incoming.id, present: Boolean(local) });
      nextLedgerBaselines.push({ kind, id: incoming.id, fingerprint });
    }
  }
  return { input: { ...input, orders }, expectations, nextBaselines, ledgerExpectations, nextLedgerBaselines, conflicts };
}
