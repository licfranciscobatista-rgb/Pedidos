import { parseId, parseInteger, parseOrder, record, ValidationError } from "@/lib/validation";
import { assertSql, body, context, type IdParams, json, ORDER_COLUMNS, orderActivity, route, isTransactionConflict } from "../../_shared";

export async function PUT(request: Request, args: IdParams) {
  return route(async () => {
    const { db, ownerId } = await context(request, true);
    const id = parseId((await args.params).id);
    const order = parseOrder(record(await body(request)).order, "update");
    if (order.id !== id) throw new ValidationError("El artículo no coincide con la solicitud.");
    try {
      const results = await db.batch([
        assertSql(db, "EXISTS (SELECT 1 FROM orders WHERE owner_id=$1 AND id=$2 AND revision=$3)", [ownerId, id, order.revision]),
        db.prepare(`UPDATE orders SET platform=$1,client=$2,phone=$3,batch=$4,article=$5,variant=$6,quantity=$7,unit_cents=$8,extra_cents=$9,discount_cents=$10,store_cents=$11,status=$12,date=$13,delivery_date=$14,notes=$15,photo_key=$16,revision=revision+1 WHERE owner_id=$17 AND id=$18 AND revision=$19 RETURNING ${ORDER_COLUMNS}`)
          .bind(order.platform, order.client, order.phone, order.batch, order.article, order.variant, order.quantity, order.unitCents, order.extraCents, order.discountCents, order.storeCents, order.status, order.date, order.deliveryDate, order.notes, order.photoKey, ownerId, id, order.revision),
        orderActivity(db, ownerId, id, order.status === "Cancelado" ? "Artículo cancelado" : "Artículo actualizado", `${order.article}: ${order.status}`, `Cantidad: ${order.quantity}. Precio unitario: RD$ ${(order.unitCents / 100).toFixed(2)}. Pagado a tienda: RD$ ${(order.storeCents / 100).toFixed(2)}. Los movimientos registrados se conservan.`),
      ]);
      return json({ order: results[1].results[0] });
    } catch (error) {
      if (isTransactionConflict(error)) throw new ValidationError("El artículo cambió en otro dispositivo o fue eliminado. Actualiza la lista y vuelve a intentarlo.", 409);
      throw error;
    }
  });
}

export async function DELETE(request: Request, args: IdParams) {
  return route(async () => {
    const { db, ownerId } = await context(request, true);
    const id = parseId((await args.params).id);
    const rawRevision = new URL(request.url).searchParams.get("revision");
    if (!rawRevision || !/^\d+$/.test(rawRevision)) throw new ValidationError("Falta la versión del artículo.");
    const revision = parseInteger(Number(rawRevision), "Versión", 1, 2_147_483_646);
    const allowed = `owner_id=$1 AND id=$2 AND revision=$3 AND NOT EXISTS (SELECT 1 FROM payments WHERE owner_id=orders.owner_id AND order_id=orders.id) AND NOT EXISTS (SELECT 1 FROM exchanges WHERE owner_id=orders.owner_id AND order_id=orders.id)`;
    try {
      await db.batch([
        assertSql(db, `EXISTS (SELECT 1 FROM orders WHERE ${allowed})`, [ownerId, id, revision]),
        db.prepare(`INSERT INTO activities (owner_id,id,at,kind,order_id,client,summary,detail) SELECT owner_id,$1,$2,'Artículo eliminado',id,client,'Se eliminó ' || article,'Artículo sin movimientos ni cambios previos. Identificador: ' || id FROM orders WHERE owner_id=$3 AND id=$4`).bind(crypto.randomUUID(), new Date().toISOString(), ownerId, id),
        db.prepare(`DELETE FROM orders WHERE ${allowed} RETURNING id`).bind(ownerId, id, revision),
      ]);
      return json({ deleted: id });
    } catch (error) {
      if (isTransactionConflict(error)) throw new ValidationError("No se puede eliminar: el artículo cambió o tiene abonos o cambios registrados. Puedes marcarlo como Cancelado y conservar su historial.", 409);
      throw error;
    }
  });
}
