import { parseId, ValidationError } from "@/lib/validation";
import { assertSql, context, type IdParams, json, route, isTransactionConflict } from "../../_shared";

export async function DELETE(request: Request, args: IdParams) {
  return route(async () => {
    const { db, ownerId } = await context(request, true);
    const id = parseId((await args.params).id);
    const allowed = `owner_id=$1 AND id=$2 AND (COALESCE((SELECT SUM(CASE WHEN p.kind='Abono' THEN p.amount_cents ELSE -p.amount_cents END) FROM payments p WHERE p.owner_id=payments.owner_id AND p.order_id=payments.order_id),0) - CASE WHEN kind='Abono' THEN amount_cents ELSE -amount_cents END) BETWEEN 0 AND 100000000`;
    try {
      await db.batch([
        assertSql(db, `EXISTS (SELECT 1 FROM payments WHERE ${allowed})`, [ownerId, id]),
        db.prepare(`INSERT INTO activities (owner_id,id,at,kind,order_id,client,summary,detail) SELECT p.owner_id,$1,$2,'Movimiento eliminado',p.order_id,o.client,'Se eliminó ' || lower(p.kind) || ' de RD$ ' || to_char(p.amount_cents::numeric/100,'FM999999999990.00'),'Forma: ' || p.method || '. Fecha: ' || p.date || '. Movimiento: ' || p.id FROM payments p JOIN orders o ON o.owner_id=p.owner_id AND o.id=p.order_id WHERE p.owner_id=$3 AND p.id=$4`).bind(crypto.randomUUID(), new Date().toISOString(), ownerId, id),
        db.prepare(`DELETE FROM payments WHERE ${allowed} RETURNING id`).bind(ownerId, id),
      ]);
      return json({ deleted: id });
    } catch (error) {
      if (isTransactionConflict(error)) throw new ValidationError("No se pudo eliminar. El movimiento ya no existe o quitarlo dejaría un saldo recibido fuera del límite permitido o devoluciones superiores a los abonos.", 409);
      throw error;
    }
  });
}
