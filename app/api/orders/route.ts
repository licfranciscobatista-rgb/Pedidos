import { parseOrder, record, ValidationError } from "@/lib/validation";
import { normalizeOrdersWithClients } from "@/lib/order-clients";
import { body, context, json, ORDER_COLUMNS, orderActivity, route, isTransactionConflict } from "../_shared";

export async function POST(request: Request) {
  return route(async () => {
    const { db, ownerId } = await context(request, true);
    const order = (await normalizeOrdersWithClients(db,ownerId,[parseOrder(record(await body(request)).order)]))[0];
    try {
      const results = await db.batch([
        db.prepare(`INSERT INTO orders (owner_id, id, platform, client, phone, batch, article, variant, quantity, unit_cents, extra_cents, discount_cents, store_cents, status, date, delivery_date, notes, photo_key, revision,client_id) VALUES ($1,$2,$3,COALESCE((SELECT name FROM clients WHERE owner_id=$1 AND id=$19),$4),COALESCE((SELECT phone FROM clients WHERE owner_id=$1 AND id=$19),$5),$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,1,$19) RETURNING ${ORDER_COLUMNS}`)
          .bind(ownerId, order.id, order.platform, order.client, order.phone, order.batch, order.article, order.variant, order.quantity, order.unitCents, order.extraCents, order.discountCents, order.storeCents, order.status, order.date, order.deliveryDate, order.notes, order.photoKey,order.clientId||null),
        orderActivity(db, ownerId, order.id, "Artículo creado", `Se agregó ${order.article}`, `Tienda: ${order.platform}. Cantidad: ${order.quantity}. Precio unitario: RD$ ${(order.unitCents / 100).toFixed(2)}. Estado: ${order.status}.`),
      ]);
      return json({ order: results[0].results[0] }, 201);
    } catch (error) {
      if (isTransactionConflict(error)) throw new ValidationError("Este artículo ya existe o el cliente cambió. Actualiza la lista antes de continuar.", 409);
      throw error;
    }
  });
}
