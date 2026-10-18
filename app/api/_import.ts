import { parseImport, ValidationError } from "@/lib/validation";
import { assertSql } from "./_shared";
import type { Database, DbResult, PreparedStatement } from "@/lib/db";

const orderFields = {
  id: "id", platform: "platform", client_id: "clientId", client: "client", phone: "phone", batch: "batch", article: "article", variant: "variant",
  quantity: "quantity", unit_cents: "unitCents", extra_cents: "extraCents", discount_cents: "discountCents", store_cents: "storeCents",
  status: "status", date: "date", delivery_date: "deliveryDate", notes: "notes", photo_key: "photoKey", revision: "revision",
};
const paymentFields = { id: "id", order_id: "orderId", kind: "kind", amount_cents: "amountCents", date: "date", method: "method", note: "note" };
const exchangeFields = { id: "id", order_id: "orderId", date: "date", old_article: "oldArticle", new_article: "newArticle", old_total_cents: "oldTotalCents", new_total_cents: "newTotalCents", difference_cents: "differenceCents", note: "note" };

const integerFields = new Set(["quantity", "revision"]);
const moneyFields = new Set(["unit_cents", "extra_cents", "discount_cents", "store_cents", "amount_cents", "old_total_cents", "new_total_cents", "difference_cents"]);
function incoming(fields: Record<string, string>, placeholder = "$2") {
  const raw = `SELECT ${Object.entries(fields).map(([column, key]) => `(value->>'${key}')::${integerFields.has(column) ? "integer" : moneyFields.has(column) ? "bigint" : "text"} AS ${column}`).join(",")} FROM jsonb_array_elements(${placeholder}::jsonb)`;
  if(fields!==orderFields)return raw;
  return `SELECT ${Object.keys(fields).map(column=>column==="client_id"?"COALESCE(raw.client_id,prior.client_id) AS client_id":column==="client"?"COALESCE(master.name,raw.client) AS client":column==="phone"?"COALESCE(master.phone,raw.phone) AS phone":`raw.${column}`).join(",")} FROM (${raw}) raw LEFT JOIN orders prior ON prior.owner_id=$1 AND prior.id=raw.id LEFT JOIN clients master ON master.owner_id=$1 AND master.id=COALESCE(raw.client_id,prior.client_id)`;
}
function same(fields: Record<string, string>, left: string, right: string, excluded: string[] = ["id", "revision"]) {
  const linked=fields===orderFields;
  const comparison=Object.keys(fields).filter(key => !excluded.includes(key)&&!(linked&&["client","phone"].includes(key))).map(key => `${left}.${key} IS NOT DISTINCT FROM ${right}.${key}`).join(" AND ");
  return linked?`${comparison} AND (${left}.client_id IS NOT NULL OR (${left}.client IS NOT DISTINCT FROM ${right}.client AND ${left}.phone IS NOT DISTINCT FROM ${right}.phone))`:comparison;
}

export type ImportInput = ReturnType<typeof parseImport>;
export function buildImportStatements(db: Database, ownerId: string, input: ImportInput): PreparedStatement[] {
    const orders = JSON.stringify(input.orders);
    const payments = JSON.stringify(input.payments);
    const exchanges = JSON.stringify(input.exchanges);
    for (const payload of [orders, payments, exchanges]) {
      if (new TextEncoder().encode(payload).byteLength > 1_500_000) throw new ValidationError("Una sección del archivo contiene demasiados datos. Divide la importación en archivos más pequeños.", 413);
    }
    const incomingOrders = incoming(orderFields);
    const incomingPayments = incoming(paymentFields);
    const incomingExchanges = incoming(exchangeFields);
    const orderSame = same(orderFields, "o", "i");
    const paymentSame = same(paymentFields, "p", "i");
    const exchangeSame = same(exchangeFields, "e", "i");
    const orderColumns = Object.keys(orderFields).filter(key => key !== "revision");
    const paymentColumns = Object.keys(paymentFields);
    const exchangeColumns = Object.keys(exchangeFields);

  return [
        db.prepare(`WITH i AS (${incomingOrders}) SELECT SUM(CASE WHEN o.id IS NULL THEN 1 ELSE 0 END) AS created, SUM(CASE WHEN o.id IS NOT NULL AND NOT (${orderSame}) THEN 1 ELSE 0 END) AS updated FROM i LEFT JOIN orders o ON o.owner_id=$1 AND o.id=i.id`).bind(ownerId, orders),
        db.prepare(`WITH i AS (${incomingPayments}) SELECT COUNT(*) AS created FROM i WHERE NOT EXISTS (SELECT 1 FROM payments p WHERE p.owner_id=$1 AND p.id=i.id)`).bind(ownerId, payments),
        db.prepare(`WITH i AS (${incomingExchanges}) SELECT COUNT(*) AS created FROM i WHERE NOT EXISTS (SELECT 1 FROM exchanges e WHERE e.owner_id=$1 AND e.id=i.id)`).bind(ownerId, exchanges),
        db.prepare(`WITH i AS (${incomingOrders}), ip AS (${incoming(paymentFields, "$3")}), ie AS (${incoming(exchangeFields, "$4")}) INSERT INTO activities (owner_id,id,at,kind,order_id,client,summary,detail) SELECT $1,$5,$6,'Importación','','',$7,'Artículos creados: ' || (SELECT COUNT(*) FROM i WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.owner_id=$1 AND o.id=i.id)) || '. Artículos actualizados: ' || (SELECT COUNT(*) FROM i JOIN orders o ON o.owner_id=$1 AND o.id=i.id WHERE NOT (${orderSame})) || '. Movimientos nuevos: ' || (SELECT COUNT(*) FROM ip WHERE NOT EXISTS (SELECT 1 FROM payments p WHERE p.owner_id=$1 AND p.id=ip.id)) || '. Cambios nuevos: ' || (SELECT COUNT(*) FROM ie WHERE NOT EXISTS (SELECT 1 FROM exchanges e WHERE e.owner_id=$1 AND e.id=ie.id)) || '. Identificadores: ' || $8::text`).bind(ownerId, orders, payments, exchanges, crypto.randomUUID(), new Date().toISOString(), `Archivo importado: ${input.orders.length} artículos, ${input.payments.length} movimientos y ${input.exchanges.length} cambios.`, JSON.stringify({ orderIds: input.orders.map(item => item.id), paymentIds: input.payments.map(item => item.id), exchangeIds: input.exchanges.map(item => item.id) })),
        assertSql(db, `NOT EXISTS (WITH i AS (${incomingOrders}) SELECT 1 FROM i JOIN orders o ON o.owner_id=$1 AND o.id=i.id WHERE NOT (${orderSame}) AND o.revision<>i.revision)`, [ownerId, orders]),
        assertSql(db, `NOT EXISTS (WITH i AS (${incomingPayments}) SELECT 1 FROM i JOIN payments p ON p.owner_id=$1 AND p.id=i.id WHERE NOT (${paymentSame}))`, [ownerId, payments]),
        assertSql(db, `NOT EXISTS (WITH i AS (${incomingExchanges}) SELECT 1 FROM i JOIN exchanges e ON e.owner_id=$1 AND e.id=i.id WHERE NOT (${exchangeSame}))`, [ownerId, exchanges]),
        assertSql(db, `NOT EXISTS (WITH incoming_orders AS (${incoming(orderFields, "$2")}), incoming_payments AS (${incoming(paymentFields, "$3")}), incoming_exchanges AS (${incoming(exchangeFields, "$4")}), refs AS (SELECT order_id FROM incoming_payments UNION SELECT order_id FROM incoming_exchanges) SELECT 1 FROM refs WHERE NOT EXISTS (SELECT 1 FROM orders WHERE owner_id=$1 AND id=refs.order_id) AND NOT EXISTS (SELECT 1 FROM incoming_orders WHERE id=refs.order_id))`, [ownerId, orders, payments, exchanges]),
        assertSql(db, `NOT EXISTS (WITH i AS (${incomingPayments}), ledger AS (SELECT order_id,kind,amount_cents FROM payments WHERE owner_id=$1 UNION ALL SELECT i.order_id,i.kind,i.amount_cents FROM i WHERE NOT EXISTS (SELECT 1 FROM payments p WHERE p.owner_id=$1 AND p.id=i.id)) SELECT 1 FROM ledger GROUP BY order_id HAVING SUM(CASE WHEN kind='Abono' THEN amount_cents ELSE -amount_cents END) NOT BETWEEN 0 AND 100000000)`, [ownerId, payments]),
        db.prepare(`WITH i AS (${incomingOrders}) INSERT INTO orders (owner_id,${orderColumns.join(",")},revision) SELECT $1,${orderColumns.map(key => `i.${key}`).join(",")},1 FROM i WHERE true ON CONFLICT(owner_id,id) DO UPDATE SET ${orderColumns.filter(key => key !== "id").map(key => `${key}=excluded.${key}`).join(",")},revision=orders.revision+1 WHERE NOT (${same(orderFields, "orders", "excluded")})`).bind(ownerId, orders),
        db.prepare(`WITH i AS (${incomingPayments}) INSERT INTO payments (owner_id,${paymentColumns.join(",")}) SELECT $1,${paymentColumns.map(key => `i.${key}`).join(",")} FROM i WHERE NOT EXISTS (SELECT 1 FROM payments p WHERE p.owner_id=$1 AND p.id=i.id)`).bind(ownerId, payments),
        db.prepare(`WITH i AS (${incomingExchanges}) INSERT INTO exchanges (owner_id,${exchangeColumns.join(",")}) SELECT $1,${exchangeColumns.map(key => `i.${key}`).join(",")} FROM i WHERE NOT EXISTS (SELECT 1 FROM exchanges e WHERE e.owner_id=$1 AND e.id=i.id)`).bind(ownerId, exchanges),
      ];
}
export function importChanges(results: DbResult[], input: ImportInput) {
      const orderCounts = results[0].results[0] as { created?: number; updated?: number } | undefined;
      const paymentCounts = results[1].results[0] as { created?: number } | undefined;
      const exchangeCounts = results[2].results[0] as { created?: number } | undefined;
      const createdOrders = Number(orderCounts?.created ?? 0);
      const updatedOrders = Number(orderCounts?.updated ?? 0);
      const createdPayments = Number(paymentCounts?.created ?? 0);
      const createdExchanges = Number(exchangeCounts?.created ?? 0);
  return { createdOrders, updatedOrders, createdPayments, createdExchanges, unchangedOrders: input.orders.length - createdOrders - updatedOrders, unchangedPayments: input.payments.length - createdPayments, unchangedExchanges: input.exchanges.length - createdExchanges };
}
