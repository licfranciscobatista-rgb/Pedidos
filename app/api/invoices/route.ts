import { parseInvoiceRequest, ValidationError } from "@/lib/validation";
import { assertSql, body, context, INVOICE_COLUMNS, invoiceFromRow, json, NET_PAID, route, isTransactionConflict } from "../_shared";

export async function POST(request: Request) {
  return route(async () => {
    const { db, ownerId } = await context(request, true);
    const input = parseInvoiceRequest(await body(request));
    const existing = await db.prepare(`SELECT ${INVOICE_COLUMNS} FROM invoices WHERE owner_id=$1 AND request_id=$2`).bind(ownerId, input.requestId).first();
    if (existing) return json({ invoice: invoiceFromRow(existing) });
    const ids = JSON.stringify(input.orderIds);
    const id = crypto.randomUUID();
    const issuedAt = new Date().toISOString();
    const prefix = `FAC-${issuedAt.slice(0, 4)}-`;
    const selected = `SELECT orders.*,${NET_PAID} AS paid,selection.ordinal FROM jsonb_array_elements_text($2::jsonb) WITH ORDINALITY selection(value,ordinal) JOIN orders ON orders.owner_id=$1 AND orders.id=selection.value WHERE status<>'Cancelado'`;
    const normalized = `WITH selected AS (${selected}), normalized AS (SELECT selected.*,regexp_replace(phone,'[^0-9]','','g') AS phone_digits FROM selected)`;
    try {
      const results = await db.batch([
        assertSql(db, `EXISTS (SELECT 1 FROM invoices WHERE owner_id=$1 AND request_id=$4) OR (${normalized} SELECT COUNT(*)=$3::integer AND COUNT(DISTINCT lower(trim(client)))=1 AND COUNT(DISTINCT phone_digits)=1 FROM normalized)`, [ownerId, ids, input.orderIds.length, input.requestId]),
        db.prepare(`WITH selected AS (${selected}),
          snapshot AS (SELECT MIN(client) AS client,MIN(phone) AS phone,
            jsonb_agg(jsonb_build_object('orderId',id,'article',article,'variant',variant,'quantity',quantity,'unitCents',unit_cents,'extraCents',extra_cents,'discountCents',discount_cents,'totalCents',quantity*unit_cents+extra_cents-discount_cents,'status',status,'platform',platform,'deliveryLabel',COALESCE($12::jsonb->>id,'Por confirmar')) ORDER BY ordinal)::text AS items,
            SUM(quantity*unit_cents+extra_cents-discount_cents)::bigint AS registered,SUM(paid)::bigint AS paid
            FROM selected HAVING COUNT(*)>0),
          seq AS (INSERT INTO invoice_counters (owner_id,next_sequence)
            SELECT $1,COALESCE((SELECT MAX(sequence) FROM invoices WHERE owner_id=$1),0)+2
            WHERE NOT EXISTS (SELECT 1 FROM invoices WHERE owner_id=$1 AND request_id=$8)
            ON CONFLICT(owner_id) DO UPDATE SET next_sequence=invoice_counters.next_sequence+1
            RETURNING next_sequence-1 AS value)
          INSERT INTO invoices (owner_id,id,sequence,number,issued_at,client,phone,business_name,notes,order_ids_json,items_json,total_cents,paid_cents,balance_cents,request_id,pricing_mode,show_amounts,registered_total_cents)
          SELECT $1,$3,seq.value,$4::text || lpad(seq.value::text,GREATEST(6,length(seq.value::text)),'0'),$5,snapshot.client,snapshot.phone,$6,$7,$2::text,snapshot.items,
            CASE WHEN $9::text='manual' THEN $10::bigint ELSE registered END,paid,
            (CASE WHEN $9::text='manual' THEN $10::bigint ELSE registered END)-paid,$8,$9,$11,registered
          FROM snapshot CROSS JOIN seq RETURNING ${INVOICE_COLUMNS}`).bind(ownerId, ids, id, prefix, issuedAt, input.businessName, input.notes, input.requestId, input.pricingMode, input.manualTotalCents, input.showAmounts ? 1 : 0, JSON.stringify(input.deliveryLabels)),
        db.prepare(`INSERT INTO activities (owner_id,id,at,kind,order_id,client,summary,detail) SELECT owner_id,$1,$2,'Factura emitida','',client,'Se emitió ' || number,'Factura: ' || id || '. Artículos: ' || jsonb_array_length(order_ids_json::jsonb) || '. Total: RD$ ' || to_char(total_cents::numeric/100,'FM999999999990.00') || '. Recibido: RD$ ' || to_char(paid_cents::numeric/100,'FM999999999990.00') || '. Saldo: RD$ ' || to_char(balance_cents::numeric/100,'FM999999999990.00') FROM invoices WHERE owner_id=$3 AND id=$4`).bind(crypto.randomUUID(), issuedAt, ownerId, id),
        db.prepare(`SELECT ${INVOICE_COLUMNS} FROM invoices WHERE owner_id=$1 AND request_id=$2`).bind(ownerId, input.requestId),
      ]);
      return json({ invoice: invoiceFromRow(results[3].results[0]) }, results[1].results.length ? 201 : 200);
    } catch (error) {
      if (isTransactionConflict(error)) throw new ValidationError("Selecciona artículos vigentes del mismo cliente y teléfono. Algún artículo fue cancelado, eliminado o pertenece a otro cliente.", 409);
      throw error;
    }
  });
}
