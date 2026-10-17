import { parseDate, parseId, parseInteger, parsePhotoKey, parseText, record, ValidationError } from "@/lib/validation";
import { assertSql, body, context, type IdParams, json, ORDER_COLUMNS, EXCHANGE_COLUMNS, orderActivity, route, isTransactionConflict } from "../../../_shared";

export async function POST(request: Request, args: IdParams) {
  return route(async () => {
    const { db, ownerId } = await context(request, true);
    const id = parseId((await args.params).id);
    const source = record(await body(request));
    const revision = parseInteger(source.revision, "Versión del artículo", 1, 2_147_483_646);
    const article = parseText(source.article, "Artículo nuevo", 200, true);
    const quantity = parseInteger(source.quantity, "Cantidad", 1, 9999);
    const unitCents = parseInteger(source.unitCents, "Precio");
    const photoKey = parsePhotoKey(source.photoKey);
    const notes = parseText(source.notes, "Notas", 2000);
    const date = parseDate(source.date, "Fecha del cambio");
    const exchangeId = crypto.randomUUID();
    const newTotal = `($4::bigint * $5::bigint + extra_cents - discount_cents)`;
    try {
      const results = await db.batch([
        assertSql(db, `EXISTS (SELECT 1 FROM orders WHERE owner_id=$1 AND id=$2 AND revision=$3 AND ${newTotal} BETWEEN 0 AND 100000000)`, [ownerId, id, revision, quantity, unitCents]),
        db.prepare(`INSERT INTO exchanges (owner_id,id,order_id,date,old_article,new_article,old_total_cents,new_total_cents,difference_cents,note) SELECT owner_id,$1,id,$2,article,$3,CASE WHEN status='Cancelado' THEN 0 ELSE quantity*unit_cents+extra_cents-discount_cents END,${newTotal},${newTotal}-(CASE WHEN status='Cancelado' THEN 0 ELSE quantity*unit_cents+extra_cents-discount_cents END),$6 FROM orders WHERE owner_id=$7 AND id=$8 AND revision=$9 RETURNING ${EXCHANGE_COLUMNS}`).bind(exchangeId, date, article, quantity, unitCents, notes, ownerId, id, revision),
        db.prepare(`UPDATE orders SET article=$1,quantity=$2,unit_cents=$3,photo_key=$4,status='Cambiado',revision=revision+1 WHERE owner_id=$5 AND id=$6 AND revision=$7 RETURNING ${ORDER_COLUMNS}`).bind(article, quantity, unitCents, photoKey, ownerId, id, revision),
        orderActivity(db, ownerId, id, "Cambio", `Artículo cambiado por ${article}`, `Cantidad: ${quantity}. Nuevo precio unitario: RD$ ${(unitCents / 100).toFixed(2)}. Fecha: ${date}. Cambio: ${exchangeId}. Los pagos anteriores se mantienen.${notes ? ` Nota: ${notes}` : ""}`),
      ]);
      return json({ exchange: results[1].results[0], order: results[2].results[0] }, 201);
    } catch (error) {
      if (isTransactionConflict(error)) throw new ValidationError("El artículo cambió en otro dispositivo o el nuevo total no es válido. Actualiza la lista y revisa el precio.", 409);
      throw error;
    }
  });
}
