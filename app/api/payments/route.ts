import { parsePayment, record, ValidationError } from "@/lib/validation";
import { assertSql, body, context, json, NET_PAID, PAYMENT_COLUMNS, orderActivity, route, isTransactionConflict, isUniqueViolation } from "../_shared";

export async function POST(request: Request) {
  return route(async () => {
    const { db, ownerId } = await context(request, true);
    const payment = parsePayment(record(await body(request)).payment);
    const existing = await db.prepare(`SELECT ${PAYMENT_COLUMNS} FROM payments WHERE owner_id=$1 AND id=$2`).bind(ownerId, payment.id).first();
    if (existing) {
      if (Object.entries(payment).every(([key, value]) => existing[key] === value)) return json({ payment: existing });
      throw new ValidationError("El identificador de este movimiento ya corresponde a otro abono o devolución.", 409);
    }
    try {
      const results = await db.batch([
        assertSql(db, `EXISTS (SELECT 1 FROM orders WHERE owner_id=$1 AND id=$2 AND ($3::text='Abono' OR ${NET_PAID}>=$4::bigint) AND ${NET_PAID} + CASE WHEN $3::text='Abono' THEN $4::bigint ELSE -$4::bigint END <= 100000000)`, [ownerId, payment.orderId, payment.kind, payment.amountCents]),
        db.prepare(`INSERT INTO payments (owner_id,id,order_id,kind,amount_cents,date,method,note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${PAYMENT_COLUMNS}`)
          .bind(ownerId, payment.id, payment.orderId, payment.kind, payment.amountCents, payment.date, payment.method, payment.note),
        orderActivity(db, ownerId, payment.orderId, payment.kind, `${payment.kind} de RD$ ${(payment.amountCents / 100).toFixed(2)}`, `Forma: ${payment.method}. Fecha: ${payment.date}. Movimiento: ${payment.id}.${payment.note ? ` Nota: ${payment.note}` : ""}`),
      ]);
      return json({ payment: results[1].results[0] }, 201);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ValidationError("Este movimiento ya se registró. Actualiza la lista para comprobarlo.", 409);
      if (isTransactionConflict(error)) throw new ValidationError("El artículo no existe, la devolución supera el dinero recibido o el saldo excede el límite permitido. Actualiza la lista.", 409);
      throw error;
    }
  });
}
