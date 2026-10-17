import { parseOrder, record, ValidationError } from "@/lib/validation";
import { body, context, json, ORDER_COLUMNS, orderActivity, route, isUniqueViolation } from "../_shared";

export async function POST(request: Request) {
  return route(async () => {
    const { db, ownerId } = await context(request, true);
    const order = parseOrder(record(await body(request)).order);
    try {
      const results = await db.batch([
        db.prepare(`INSERT INTO orders (owner_id, id, platform, client, phone, batch, article, variant, quantity, unit_cents, extra_cents, discount_cents, store_cents, status, date, delivery_date, notes, photo_key, revision) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,1) RETURNING ${ORDER_COLUMNS}`)
          .bind(ownerId, order.id, order.platform, order.client, order.phone, order.batch, order.article, order.variant, order.quantity, order.unitCents, order.extraCents, order.discountCents, order.storeCents, order.status, order.date, order.deliveryDate, order.notes, order.photoKey),
        orderActivity(db, ownerId, order.id, "Artículo creado", `Se agregó ${order.article}`, `Tienda: ${order.platform}. Cantidad: ${order.quantity}. Precio unitario: RD$ ${(order.unitCents / 100).toFixed(2)}. Estado: ${order.status}.`),
      ]);
      return json({ order: results[0].results[0] }, 201);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ValidationError("Este artículo ya existe. Actualiza la lista antes de continuar.", 409);
      throw error;
    }
  });
}
