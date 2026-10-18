import { DELIVERY_LABELS, QUOTE_STATUSES, type Client, type InvoiceDraft, type Quote, type QuoteItem, type BusinessData } from "./business-types";
import { MAX_MONEY_CENTS, parseDate, parseId, parseInteger, parseText, record, ValidationError } from "./validation";
type Mode = "create" | "update" | "import";
function revision(value: unknown, mode: Mode) { return mode === "create" ? 1 : parseInteger(value ?? (mode === "import" ? 0 : undefined), "Revisión", mode === "import" ? 0 : 1, 2_147_483_646); }
function boolean(value: unknown, label: string, fallback?: boolean) { if (value == null && fallback !== undefined) return fallback; if (typeof value !== "boolean") throw new ValidationError(`${label}: selecciona una opción válida.`); return value; }
function unique<T>(items: T[], id: (item: T) => string, label: string) { if (new Set(items.map(id)).size !== items.length) throw new ValidationError(`${label}: hay identificadores repetidos.`); }
export function parseClient(value: unknown, mode: Mode = "create"): Client {
  const item = record(value, "datos del cliente");
  const email = parseText(item.email, "Correo", 200);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ValidationError("Correo: escribe una dirección válida.");
  return { id: parseId(item.id, "ID Cliente"), name: parseText(item.name, "Nombre del cliente", 120, true), phone: parseText(item.phone, "Teléfono", 40), email, address: parseText(item.address, "Dirección", 500), notes: parseText(item.notes, "Notas del cliente", 2000), active: boolean(item.active, "Cliente activo", true), revision: revision(item.revision, mode) };
}
function quoteItem(value: unknown): QuoteItem {
  const item = record(value, "datos del artículo cotizado");
  const quantity = parseInteger(item.quantity, "Cantidad", 1, 9999), unitCents = parseInteger(item.unitCents, "Precio"), extraCents = parseInteger(item.extraCents ?? 0, "Cargos"), discountCents = parseInteger(item.discountCents ?? 0, "Descuento");
  const total = quantity * unitCents + extraCents - discountCents;
  if (!Number.isSafeInteger(total) || total < 0 || total > MAX_MONEY_CENTS) throw new ValidationError("El total del artículo cotizado no es válido.");
  if (item.platform !== "Temu" && item.platform !== "SHEIN") throw new ValidationError("Selecciona Temu o SHEIN.");
  return { id: parseId(item.id, "ID de línea"), article: parseText(item.article, "Artículo", 200, true), variant: parseText(item.variant, "Variante", 160), platform: item.platform, quantity, unitCents, extraCents, discountCents };
}
export function parseQuote(value: unknown, mode: Mode = "create"): Quote {
  const item = record(value, "datos de la cotización");
  if (!QUOTE_STATUSES.includes(item.status as Quote["status"])) throw new ValidationError("Selecciona un estado de cotización válido.");
  if (!Array.isArray(item.items) || !item.items.length || item.items.length > 500) throw new ValidationError("La cotización necesita entre 1 y 500 artículos.");
  const items = item.items.map(quoteItem); unique(items, line => line.id, "Cotización");
  const totalCents = items.reduce((sum, line) => sum + line.quantity * line.unitCents + line.extraCents - line.discountCents, 0);
  if (totalCents > MAX_MONEY_CENTS) throw new ValidationError("La cotización supera RD$1,000,000.");
  const date = parseDate(item.date), validUntil = item.validUntil == null || item.validUntil === "" ? "" : parseDate(item.validUntil, "Válida hasta");
  if (validUntil && validUntil < date) throw new ValidationError("El vencimiento debe ser igual o posterior a la fecha de cotización.");
  return { id: parseId(item.id, "ID Cotización"), clientId: parseId(item.clientId, "ID Cliente"), date, validUntil, status: item.status as Quote["status"], notes: parseText(item.notes, "Notas", 2000), revision: revision(item.revision, mode), items, totalCents };
}
export function parseInvoiceDraft(value: unknown, mode: Mode = "create"): InvoiceDraft {
  const item = record(value, "datos del borrador");
  if (!Array.isArray(item.items) || !item.items.length || item.items.length > 500) throw new ValidationError("El borrador necesita entre 1 y 500 artículos.");
  const items = item.items.map(value => { const line = record(value); const label = line.deliveryLabel ?? "Por confirmar"; if (!DELIVERY_LABELS.includes(label as typeof DELIVERY_LABELS[number])) throw new ValidationError("Selecciona un aviso de entrega válido."); return { orderId: parseId(line.orderId, "ID Pedido"), deliveryLabel: label as typeof DELIVERY_LABELS[number] }; });
  unique(items, line => line.orderId, "Borrador");
  if (item.pricingMode !== "items" && item.pricingMode !== "manual") throw new ValidationError("Selecciona precios registrados o monto manual.");
  const showAmounts = boolean(item.showAmounts, "Mostrar importes", true);
  return { id: parseId(item.id, "ID Borrador"), clientId: parseId(item.clientId, "ID Cliente"), date: parseDate(item.date), businessName: parseText(item.businessName, "Negocio", 160), notes: parseText(item.notes, "Notas", 2000), pricingMode: item.pricingMode, manualTotalCents: parseInteger(item.manualTotalCents ?? 0, "Monto manual"), showAmounts, revision: revision(item.revision, mode), items };
}
export function parseBusinessImport(value: unknown): BusinessData {
  const source = record(value);
  const result: BusinessData = { clients: [], quotes: [], invoiceDrafts: [] };
  for (const kind of ["clients", "quotes", "invoiceDrafts"] as const) { const list = source[kind] ?? []; if (!Array.isArray(list) || list.length > 1500) throw new ValidationError(`${kind}: importa hasta 1,500 registros.`); }
  result.clients = (source.clients as unknown[] ?? []).map(item => parseClient(item, "import"));
  result.quotes = (source.quotes as unknown[] ?? []).map(item => parseQuote(item, "import"));
  result.invoiceDrafts = (source.invoiceDrafts as unknown[] ?? []).map(item => parseInvoiceDraft(item, "import"));
  unique(result.clients, item => item.id, "Clientes"); unique(result.quotes, item => item.id, "Cotizaciones"); unique(result.invoiceDrafts, item => item.id, "Borradores");
  return result;
}
