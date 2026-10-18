import { MAX_MONEY_CENTS, parseId, parseInteger, parseInvoiceRequest, record, ValidationError } from "@/lib/validation";
import { DRAFT_COLUMNS } from "@/lib/business-import";
import type { InvoiceDraft } from "@/lib/business-types";
import { assertSql, body, context, INVOICE_COLUMNS, invoiceFromRow, json, NET_PAID, route, isTransactionConflict } from "../_shared";

export async function POST(request: Request) {
  return route(async () => {
    const { db, ownerId } = await context(request, true);
    const raw = record(await body(request));
    const sourceDraftId = raw.sourceDraftId == null || raw.sourceDraftId === "" ? "" : parseId(raw.sourceDraftId, "ID Borrador");
    let sourceDraft: InvoiceDraft | null = null;
    let input;
    if (sourceDraftId) {
      const previous = await db.prepare(`SELECT ${INVOICE_COLUMNS} FROM invoices WHERE owner_id=$1 AND source_draft_id=$2`).bind(ownerId,sourceDraftId).first();
      if(previous) return json({invoice:invoiceFromRow(previous)});
      const sourceDraftRevision=parseInteger(raw.sourceDraftRevision,"Revisión del borrador",1,2_147_483_646);
      sourceDraft=await db.prepare(`SELECT ${DRAFT_COLUMNS} FROM invoice_drafts d WHERE owner_id=$1 AND id=$2`).bind(ownerId,sourceDraftId).first<InvoiceDraft>();
      if(!sourceDraft || sourceDraft.revision!==sourceDraftRevision)throw new ValidationError("El borrador cambió o no existe. Recarga antes de emitir.",409);
      input=parseInvoiceRequest({...sourceDraft,orderIds:sourceDraft.items.map(i=>i.orderId),deliveryLabels:Object.fromEntries(sourceDraft.items.map(i=>[i.orderId,i.deliveryLabel])),requestId:raw.requestId});
    } else input = parseInvoiceRequest(raw);
    const existing = await db.prepare(`SELECT ${INVOICE_COLUMNS},source_draft_id AS "sourceDraftId" FROM invoices WHERE owner_id=$1 AND request_id=$2`).bind(ownerId, input.requestId).first<{sourceDraftId:string|null}>();
    if (existing) {
      if((existing.sourceDraftId||"")!==sourceDraftId)throw new ValidationError("El identificador de emisión ya se utilizó para otro documento. Recarga y vuelve a intentarlo.",409);
      const {sourceDraftId: _sourceDraftId,...storedInvoice}=existing;void _sourceDraftId;
      return json({ invoice: invoiceFromRow(storedInvoice) });
    }
    const ids = JSON.stringify(input.orderIds);
    const id = crypto.randomUUID();
    const issuedAt = new Date().toISOString();
    const prefix = `FAC-${issuedAt.slice(0, 4)}-`;
    const selected = `SELECT orders.id,orders.platform,orders.client_id,COALESCE(master.name,orders.client) AS client,COALESCE(master.phone,orders.phone) AS phone,orders.article,orders.variant,orders.quantity,orders.unit_cents,orders.extra_cents,orders.discount_cents,orders.status,orders.date,orders.delivery_date,${NET_PAID} AS paid,selection.ordinal FROM jsonb_array_elements_text($2::jsonb) WITH ORDINALITY selection(value,ordinal) JOIN orders ON orders.owner_id=$1 AND orders.id=selection.value LEFT JOIN clients master ON master.owner_id=orders.owner_id AND master.id=orders.client_id WHERE orders.status<>'Cancelado'`;
    const normalized = `WITH selected AS (${selected}), normalized AS (SELECT selected.*,regexp_replace(phone,'[^0-9]','','g') AS phone_digits FROM selected)`;
    try {
      const results = await db.batch([
        assertSql(db, `EXISTS (SELECT 1 FROM invoices WHERE owner_id=$1 AND (request_id=$4 OR ($5::text<>'' AND source_draft_id=$5))) OR ((${normalized} SELECT COUNT(*)=$3::integer AND COUNT(DISTINCT lower(trim(client)))=1 AND COUNT(DISTINCT phone_digits)=1 AND COUNT(DISTINCT COALESCE(client_id,'legacy'))=1 AND SUM(quantity*unit_cents+extra_cents-discount_cents) BETWEEN 0 AND ${MAX_MONEY_CENTS} FROM normalized) AND ($5::text='' OR EXISTS(SELECT 1 FROM invoice_drafts d JOIN clients c ON c.owner_id=d.owner_id AND c.id=d.client_id WHERE d.owner_id=$1 AND d.id=$5 AND d.revision=$6 AND d.issued_invoice_id IS NULL AND NOT EXISTS(SELECT 1 FROM orders o WHERE o.owner_id=$1 AND o.id IN(SELECT jsonb_array_elements_text($2::jsonb)) AND ((o.client_id IS NOT NULL AND o.client_id<>c.id) OR (o.client_id IS NULL AND (lower(trim(o.client))<>lower(trim(c.name)) OR regexp_replace(o.phone,'[^0-9]','','g')<>regexp_replace(c.phone,'[^0-9]','','g') OR (SELECT count(*) FROM clients possible WHERE possible.owner_id=o.owner_id AND lower(trim(possible.name))=lower(trim(o.client)) AND regexp_replace(possible.phone,'[^0-9]','','g')=regexp_replace(o.phone,'[^0-9]','','g'))<>1)))))))`, [ownerId, ids, input.orderIds.length, input.requestId, sourceDraftId, sourceDraft?.revision??0]),
        db.prepare(`WITH selected AS (${selected}),
          snapshot AS (SELECT MIN(client) AS client,MIN(phone) AS phone,
            jsonb_agg(jsonb_build_object('orderId',id,'article',article,'variant',variant,'quantity',quantity,'unitCents',unit_cents,'extraCents',extra_cents,'discountCents',discount_cents,'totalCents',quantity*unit_cents+extra_cents-discount_cents,'status',status,'platform',platform,'orderDate',date,'deliveryDate',delivery_date,'deliveryLabel',COALESCE($12::jsonb->>id,'Por confirmar')) ORDER BY ordinal)::text AS items,
            SUM(quantity*unit_cents+extra_cents-discount_cents)::bigint AS registered,SUM(paid)::bigint AS paid
            FROM selected HAVING COUNT(*)>0),
          seq AS (INSERT INTO invoice_counters (owner_id,next_sequence)
            SELECT $1,COALESCE((SELECT MAX(sequence) FROM invoices WHERE owner_id=$1),0)+2
            WHERE NOT EXISTS (SELECT 1 FROM invoices WHERE owner_id=$1 AND (request_id=$8 OR ($13::text<>'' AND source_draft_id=$13)))
            ON CONFLICT(owner_id) DO UPDATE SET next_sequence=invoice_counters.next_sequence+1
            RETURNING next_sequence-1 AS value)
          INSERT INTO invoices (owner_id,id,sequence,number,issued_at,client,phone,business_name,notes,order_ids_json,items_json,total_cents,paid_cents,balance_cents,request_id,pricing_mode,show_amounts,registered_total_cents,source_draft_id)
          SELECT $1,$3,seq.value,$4::text || lpad(seq.value::text,GREATEST(6,length(seq.value::text)),'0'),$5,snapshot.client,snapshot.phone,$6,$7,$2::text,snapshot.items,
            CASE WHEN $9::text='manual' THEN $10::bigint ELSE registered END,paid,
            (CASE WHEN $9::text='manual' THEN $10::bigint ELSE registered END)-paid,$8,$9,$11,registered,NULLIF($13::text,'')
          FROM snapshot CROSS JOIN seq RETURNING ${INVOICE_COLUMNS}`).bind(ownerId, ids, id, prefix, issuedAt, input.businessName, input.notes, input.requestId, input.pricingMode, input.manualTotalCents, input.showAmounts ? 1 : 0, JSON.stringify(input.deliveryLabels), sourceDraftId),
        db.prepare(`INSERT INTO activities (owner_id,id,at,kind,order_id,client,summary,detail) SELECT owner_id,$1,$2,'Factura emitida','',client,'Se emitió ' || number,'Factura: ' || id || '. Artículos: ' || jsonb_array_length(order_ids_json::jsonb) || '. Total: RD$ ' || to_char(total_cents::numeric/100,'FM999999999990.00') || '. Recibido: RD$ ' || to_char(paid_cents::numeric/100,'FM999999999990.00') || '. Saldo: RD$ ' || to_char(balance_cents::numeric/100,'FM999999999990.00') FROM invoices WHERE owner_id=$3 AND id=$4`).bind(crypto.randomUUID(), issuedAt, ownerId, id),
        db.prepare(`UPDATE invoice_drafts SET issued_invoice_id=i.id,revision=invoice_drafts.revision+1,updated_at=$3 FROM invoices i WHERE invoice_drafts.owner_id=$1 AND invoice_drafts.id=$2 AND invoice_drafts.issued_invoice_id IS NULL AND i.owner_id=$1 AND i.source_draft_id=$2`).bind(ownerId,sourceDraftId,issuedAt),
        assertSql(db,`NOT EXISTS(SELECT 1 FROM invoices WHERE owner_id=$1 AND request_id=$2 AND source_draft_id IS DISTINCT FROM NULLIF($3::text,''))`,[ownerId,input.requestId,sourceDraftId]),
        db.prepare(`SELECT ${INVOICE_COLUMNS} FROM invoices WHERE owner_id=$1 AND (request_id=$2 OR ($3::text<>'' AND source_draft_id=$3))`).bind(ownerId, input.requestId,sourceDraftId),
      ]);
      return json({ invoice: invoiceFromRow(results[5].results[0]) }, results[1].results.length ? 201 : 200);
    } catch (error) {
      if (isTransactionConflict(error)) throw new ValidationError("Selecciona artículos vigentes del mismo cliente y teléfono. Algún artículo fue cancelado, eliminado o pertenece a otro cliente.", 409);
      throw error;
    }
  });
}
