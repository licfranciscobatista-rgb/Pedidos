import type { Exchange, Order, Payment } from "./types";

export class ValidationError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = "ValidationError";
  }
}

export const MAX_MONEY_CENTS = 100_000_000;
const statuses = ["Pendiente", "Pedido", "En camino", "Recibido", "Entregado", "Cancelado", "Cambiado"] as const;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function record(value: unknown, label = "datos"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError(`Los ${label} no tienen un formato válido.`);
  return value as Record<string, unknown>;
}

export function parseText(value: unknown, label: string, max: number, required = false): string {
  if (value == null && !required) return "";
  if (typeof value !== "string") throw new ValidationError(`${label}: escribe un texto válido.`);
  const result = value.trim();
  if ((required && !result) || result.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(result)) throw new ValidationError(`${label}: ${required ? "es obligatorio y " : ""}admite hasta ${max} caracteres.`);
  return result;
}

export function parseId(value: unknown, label = "Identificador"): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value)) throw new ValidationError(`${label} no válido.`);
  return value;
}

export function parsePhotoKey(value: unknown): string {
  if (value == null || value === "") return "";
  if (typeof value !== "string" || !uuidPattern.test(value)) throw new ValidationError("La referencia de la foto no es válida.");
  return value;
}

export function parseInteger(value: unknown, label: string, min = 0, max = MAX_MONEY_CENTS): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new ValidationError(`${label}: debe ser un número entero entre ${min} y ${max}.`);
  return value;
}

export function parseDate(value: unknown, label = "Fecha"): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ValidationError(`${label}: usa una fecha válida.`);
  const date = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value || value < "2000-01-01" || value > "2100-12-31") throw new ValidationError(`${label}: usa una fecha real entre 2000 y 2100.`);
  return value;
}

export function parseOrder(value: unknown, mode: "create" | "update" | "import" = "create"): Order {
  const source = record(value, "datos del artículo");
  const quantity = parseInteger(source.quantity, "Cantidad", 1, 9999);
  const unitCents = parseInteger(source.unitCents, "Precio");
  const extraCents = parseInteger(source.extraCents ?? 0, "Cargos adicionales");
  const discountCents = parseInteger(source.discountCents ?? 0, "Descuento");
  const total = quantity * unitCents + extraCents - discountCents;
  if (!Number.isSafeInteger(total) || total < 0 || total > MAX_MONEY_CENTS) throw new ValidationError("El total no es válido: revisa cantidad, precio, cargos y descuento.");
  if (!statuses.includes(source.status as typeof statuses[number])) throw new ValidationError("Selecciona un estado de entrega válido.");
  const revision = mode === "create" ? 1 : parseInteger(source.revision ?? (mode === "import" ? 0 : undefined), "Versión del artículo", mode === "import" ? 0 : 1, 2_147_483_646);
  return {
    id: parseId(source.id),
    platform: source.platform === "Temu" || source.platform === "SHEIN" ? source.platform : (() => { throw new ValidationError("Selecciona Temu o SHEIN."); })(),
    client: parseText(source.client, "Cliente", 120, true),
    phone: parseText(source.phone, "Teléfono", 40),
    batch: parseText(source.batch, "Grupo o pedido", 100),
    article: parseText(source.article, "Artículo", 200, true),
    variant: parseText(source.variant, "Talla, color o variante", 160),
    quantity, unitCents, extraCents, discountCents,
    storeCents: parseInteger(source.storeCents ?? 0, "Pagado a la tienda"),
    status: source.status as Order["status"],
    date: parseDate(source.date),
    deliveryDate: source.deliveryDate == null || source.deliveryDate === "" ? "" : parseDate(source.deliveryDate, "Fecha de entrega"),
    notes: parseText(source.notes, "Notas", 2000),
    photoKey: parsePhotoKey(source.photoKey),
    revision,
  };
}

export function parsePayment(value: unknown): Payment {
  const source = record(value, "datos del abono");
  return {
    id: parseId(source.id),
    orderId: parseId(source.orderId, "Artículo del abono"),
    kind: source.kind === "Abono" || source.kind === "Devolución" ? source.kind : (() => { throw new ValidationError("Selecciona abono o devolución."); })(),
    amountCents: parseInteger(source.amountCents, "Abono", 1),
    date: parseDate(source.date, "Fecha del abono"),
    method: parseText(source.method ?? "Efectivo", "Forma de pago", 80, true),
    note: parseText(source.note, "Nota del abono", 1000),
  };
}

export function parseExchange(value: unknown): Exchange {
  const source = record(value, "datos del cambio");
  const oldTotalCents = parseInteger(source.oldTotalCents, "Importe anterior");
  const newTotalCents = parseInteger(source.newTotalCents, "Importe nuevo");
  if (source.differenceCents !== newTotalCents - oldTotalCents) throw new ValidationError("La diferencia del cambio no coincide con sus importes.");
  return {
    id: parseId(source.id), orderId: parseId(source.orderId), date: parseDate(source.date),
    oldArticle: parseText(source.oldArticle, "Artículo anterior", 200, true),
    newArticle: parseText(source.newArticle, "Artículo nuevo", 200, true),
    oldTotalCents, newTotalCents, differenceCents: newTotalCents - oldTotalCents,
    note: parseText(source.note, "Nota del cambio", 2000),
  };
}

export function parseImport(value: unknown, allowEmpty = false): { orders: Order[]; payments: Payment[]; exchanges: Exchange[] } {
  const source = record(value, "datos de la importación");
  if (!Array.isArray(source.orders) || !Array.isArray(source.payments)) throw new ValidationError("El archivo debe incluir artículos y abonos.");
  if (source.orders.length > 1500 || source.payments.length > 3000) throw new ValidationError("Importa como máximo 1,500 artículos y 3,000 abonos por archivo.");
  if (source.exchanges != null && (!Array.isArray(source.exchanges) || source.exchanges.length > 3000)) throw new ValidationError("El historial admite como máximo 3,000 cambios por archivo.");
  if (!allowEmpty && !source.orders.length && !source.payments.length && !(source.exchanges as unknown[] | undefined)?.length) throw new ValidationError("El archivo no contiene artículos, abonos ni cambios para importar.");
  const orders = source.orders.map((item, index) => {
    try { return parseOrder(item, "import"); } catch (error) { throw new ValidationError(`Artículo ${index + 1}: ${(error as Error).message}`); }
  });
  const payments = source.payments.map((item, index) => {
    try { return parsePayment(item); } catch (error) { throw new ValidationError(`Abono ${index + 1}: ${(error as Error).message}`); }
  });
  const exchanges = ((source.exchanges ?? []) as unknown[]).map((item, index) => {
    try { return parseExchange(item); } catch (error) { throw new ValidationError(`Cambio ${index + 1}: ${(error as Error).message}`); }
  });
  for (const [items, label] of [[orders, "artículos"], [payments, "abonos"], [exchanges, "cambios"]] as const) {
    const ids = new Set(items.map((item) => item.id));
    if (ids.size !== items.length) throw new ValidationError(`El archivo repite identificadores de ${label}. Cada fila necesita un ID distinto.`);
  }
  return { orders, payments, exchanges };
}

export function parseInvoiceRequest(value: unknown): { orderIds: string[]; businessName: string; notes: string; requestId: string; pricingMode: "items" | "manual"; manualTotalCents: number; showAmounts: boolean; deliveryLabels: Record<string, string> } {
  const source = record(value, "datos de la factura");
  if (!Array.isArray(source.orderIds) || !source.orderIds.length || source.orderIds.length > 500) throw new ValidationError("Selecciona entre 1 y 500 artículos para la factura.");
  const orderIds = source.orderIds.map(item => parseId(item, "Artículo de la factura"));
  if (new Set(orderIds).size !== orderIds.length) throw new ValidationError("La factura contiene artículos repetidos.");
  if (typeof source.requestId !== "string" || !uuidPattern.test(source.requestId)) throw new ValidationError("Falta el identificador de emisión. Actualiza la página y vuelve a intentarlo.");
  if (source.pricingMode !== "items" && source.pricingMode !== "manual") throw new ValidationError("Selecciona precios registrados o monto manual.");
  if (typeof source.showAmounts !== "boolean") throw new ValidationError("Selecciona si la factura mostrará los importes.");
  const labels = record(source.deliveryLabels ?? {}, "estados de entrega");
  const allowedLabels = ["Llega en esta entrega", "Sigue pendiente", "Ya entregado", "Por confirmar"];
  const deliveryLabels: Record<string, string> = {};
  for (const id of orderIds) {
    const label = labels[id] ?? "Por confirmar";
    if (typeof label !== "string" || !allowedLabels.includes(label)) throw new ValidationError("Selecciona un aviso de entrega válido para cada artículo.");
    deliveryLabels[id] = label;
  }
  return { orderIds, businessName: parseText(source.businessName, "Nombre del negocio", 160, true), notes: parseText(source.notes, "Notas de la factura", 2000), requestId: source.requestId, pricingMode: source.pricingMode, showAmounts: source.showAmounts, manualTotalCents: parseInteger(source.manualTotalCents ?? 0, "Monto manual", 0, 100_000_000_000), deliveryLabels };
}
