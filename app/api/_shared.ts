import { getAppUser } from "@/app/auth";
import { getPhotoBucket } from "@/lib/photos";
import { getDatabase, type Database } from "@/lib/db";
export { isTransactionConflict, isUniqueViolation } from "@/lib/db";
import { ValidationError } from "@/lib/validation";
import type { Invoice } from "@/lib/types";
import { businessReadStatements } from "@/lib/business-import";

export const ORDER_COLUMNS = `id, platform, client_id AS "clientId", client, phone, batch, article, variant, quantity, unit_cents AS "unitCents", extra_cents AS "extraCents", discount_cents AS "discountCents", store_cents AS "storeCents", status, date, delivery_date AS "deliveryDate", notes, photo_key AS "photoKey", revision`;
export const PAYMENT_COLUMNS = `id, order_id AS "orderId", kind, amount_cents AS "amountCents", date, method, note`;
export const EXCHANGE_COLUMNS = `id, order_id AS "orderId", date, old_article AS "oldArticle", new_article AS "newArticle", old_total_cents AS "oldTotalCents", new_total_cents AS "newTotalCents", difference_cents AS "differenceCents", note`;
export const ACTIVITY_COLUMNS = `id, at, kind, order_id AS "orderId", client, summary, detail`;
export const INVOICE_COLUMNS = `id, number, issued_at AS "issuedAt", client, phone, business_name AS "businessName", notes, pricing_mode AS "pricingMode", show_amounts AS "showAmounts", registered_total_cents AS "registeredTotalCents", order_ids_json AS "orderIdsJson", items_json AS "itemsJson", total_cents AS "totalCents", paid_cents AS "paidCents", balance_cents AS "balanceCents"`;
export const NET_PAID = `COALESCE((SELECT SUM(CASE WHEN p.kind = 'Abono' THEN p.amount_cents ELSE -p.amount_cents END)::bigint FROM payments p WHERE p.owner_id = orders.owner_id AND p.order_id = orders.id), 0)`;

type Context = { ownerId: string; db: Database };

function assertSameOrigin(request: Request): void {
  // Render terminates TLS before forwarding to Next. The configured public
  // origin, rather than an internal proxy URL or forwarded client header,
  // remains the authority for browser mutations.
  const expected = new URL(process.env.APP_ORIGIN || request.url).origin;
  const origin = request.headers.get("origin");
  if (origin && origin !== expected) throw new ValidationError("Esta solicitud debe hacerse desde la aplicación.", 403);
}

export async function context(request: Request, mutation = false): Promise<Context> {
  const user = await getAppUser();
  if (!user?.userId) throw new ValidationError("Inicia sesión para consultar tus pedidos.", 401);
  if (mutation) assertSameOrigin(request);
  if (!process.env.DATABASE_URL) throw new ValidationError("La base de datos no está disponible. Inténtalo nuevamente.", 503);
  return { ownerId: user.userId, db: getDatabase(user.userId) };
}

export async function photoContext(request: Request, mutation = false) {
  const user = await getAppUser();
  if (!user?.userId) throw new ValidationError("Inicia sesión para ver o subir fotos.", 401);
  if (mutation) assertSameOrigin(request);
  return { ownerId: user.userId, bucket: await getPhotoBucket() };
}

export function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
}

export async function body(request: Request): Promise<unknown> {
  const maxBytes = 8 * 1024 * 1024;
  const data = await boundedBody(request, maxBytes, "Los datos superan 8 MB. Divide la importación en archivos más pequeños.");
  try { return JSON.parse(new TextDecoder().decode(data)); }
  catch { throw new ValidationError("No se pudieron leer los datos de la solicitud."); }
}

export async function boundedBody(request: Request, maxBytes: number, message: string): Promise<Uint8Array<ArrayBuffer>> {
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes) throw new ValidationError(message, 413);
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maxBytes) { await reader.cancel(); throw new ValidationError(message, 413); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const data = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  return data;
}

export async function route(action: () => Promise<Response>): Promise<Response> {
  try { return await action(); }
  catch (error) {
    if (error instanceof ValidationError) return json({ error: error.message }, error.status);
    console.error("Pedido API error", error instanceof Error ? error.message : "Unknown error");
    return json({ error: "No se pudo guardar o consultar la información. Inténtalo nuevamente." }, 500);
  }
}

export async function readData(db: Database, ownerId: string) {
  const result = await db.batch([
    db.prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE owner_id = $1 ORDER BY date DESC, id DESC`).bind(ownerId),
    db.prepare(`SELECT ${PAYMENT_COLUMNS} FROM payments WHERE owner_id = $1 ORDER BY date DESC, id DESC`).bind(ownerId),
    db.prepare(`SELECT ${EXCHANGE_COLUMNS} FROM exchanges WHERE owner_id = $1 ORDER BY date DESC, id DESC`).bind(ownerId),
    db.prepare(`SELECT ${ACTIVITY_COLUMNS} FROM activities WHERE owner_id = $1 ORDER BY at DESC, insertion_sequence DESC LIMIT 500`).bind(ownerId),
    db.prepare(`SELECT ${INVOICE_COLUMNS} FROM invoices WHERE owner_id = $1 ORDER BY sequence DESC LIMIT 500`).bind(ownerId),
    ...businessReadStatements(db, ownerId),
  ]);
  return { orders: result[0].results, payments: result[1].results, exchanges: result[2].results, activities: result[3].results, invoices: result[4].results.map(invoiceFromRow), clients: result[5].results, quotes: result[6].results, invoiceDrafts: result[7].results };
}

export function invoiceFromRow(row: unknown): Invoice {
  const source = row as Omit<Invoice, "items" | "orderIds"> & { itemsJson: string; orderIdsJson: string };
  const { itemsJson, orderIdsJson, ...invoice } = source;
  const items: Invoice["items"] = JSON.parse(itemsJson);
  return { ...invoice, showAmounts: Boolean(invoice.showAmounts), registeredTotalCents: invoice.registeredTotalCents || items.reduce((sum, item) => sum + item.totalCents, 0), orderIds: JSON.parse(orderIdsJson), items: items.map(item => ({ ...item, deliveryLabel: item.deliveryLabel ?? "Por confirmar" })) };
}

export function orderActivity(db: Database, ownerId: string, orderId: string, kind: string, summary: string, detail = "") {
  return db.prepare(`INSERT INTO activities (owner_id,id,at,kind,order_id,client,summary,detail) SELECT owner_id,$1,$2,$3,$4,client,$5,$6 FROM orders WHERE owner_id=$7 AND id=$8`).bind(crypto.randomUUID(), new Date().toISOString(), kind, orderId, summary, detail, ownerId, orderId);
}

// The adapter throws before committing when this predicate is false, rolling
// back every statement in the batch, including writes that preceded it.
export function assertSql(db: Database, condition: string, values: unknown[]) {
  return db.prepare(`SELECT (${condition}) AS ok`).bind(...values).asAssertion();
}

export type IdParams = { params: Promise<{ id: string }> };
export type KeyParams = { params: Promise<{ key: string }> };
