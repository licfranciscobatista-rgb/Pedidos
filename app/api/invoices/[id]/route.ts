import { parseId, ValidationError } from "@/lib/validation";
import { context, type IdParams, INVOICE_COLUMNS, invoiceFromRow, json, route } from "../../_shared";

export async function GET(request: Request, args: IdParams) {
  return route(async () => {
    const { db, ownerId } = await context(request);
    const id = parseId((await args.params).id, "Factura");
    const invoice = await db.prepare(`SELECT ${INVOICE_COLUMNS} FROM invoices WHERE owner_id=$1 AND id=$2`).bind(ownerId, id).first();
    if (!invoice) throw new ValidationError("No se encontró la factura.", 404);
    return json({ invoice: invoiceFromRow(invoice) });
  });
}
