import { parseImport, ValidationError } from "@/lib/validation";
import { body, context, json, route, isTransactionConflict } from "../_shared";
import { buildImportStatements, importChanges } from "../_import";

export async function POST(request: Request) {
  return route(async () => {
    const { db, ownerId } = await context(request, true);
    const input = parseImport(await body(request));
    try {
      const results = await db.batch(buildImportStatements(db, ownerId, input));
      return json({ changes: importChanges(results, input) });
    } catch (error) {
      if (isTransactionConflict(error)) throw new ValidationError("No se importó ninguna fila. Hay una versión antigua, un movimiento alterado, una referencia inexistente o una devolución superior al dinero recibido. Revisa el archivo actualizado.", 409);
      throw error;
    }
  });
}
