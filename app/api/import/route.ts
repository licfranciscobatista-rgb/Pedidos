import { parseImport, ValidationError } from "@/lib/validation";
import { body, context, json, route, isTransactionConflict } from "../_shared";
import { buildImportStatements, importChanges } from "../_import";
import { parseBusinessImport } from "@/lib/business-validation";
import { prepareBusinessImport } from "@/lib/business-import";
import { normalizeOrdersWithClients } from "@/lib/order-clients";

export async function POST(request: Request) {
  return route(async () => {
    const { db, ownerId } = await context(request, true);
    const source = await body(request);
    const input = parseImport(source, true);
    const business = parseBusinessImport(source);
    if (![input.orders, input.payments, input.exchanges, business.clients, business.quotes, business.invoiceDrafts].some(records => records.length)) throw new ValidationError("El archivo no contiene clientes, pedidos, pagos ni documentos para importar.");
    try {
      input.orders = await normalizeOrdersWithClients(db, ownerId, input.orders, business.clients);
      const prepared = await prepareBusinessImport(db, ownerId, business);
      const results = await db.batch([...prepared.clientStatements, ...buildImportStatements(db, ownerId, input), ...prepared.documentStatements]);
      return json({ changes: { ...importChanges(results.slice(prepared.clientStatements.length), input), ...prepared.summary } });
    } catch (error) {
      if (isTransactionConflict(error)) throw new ValidationError("No se importó ninguna fila. Hay una versión antigua, un movimiento alterado, una referencia inexistente o una devolución superior al dinero recibido. Revisa el archivo actualizado.", 409);
      throw error;
    }
  });
}
