import type { CellValue, Row, Worksheet } from "exceljs";
import { STATUSES, orderTotal, paidFor, type Exchange, type Order, type Payment } from "./types";
import { readInCellPhotos } from "./incell-photos";

export const ORDER_HEADERS = ["ID Pedido", "Cliente", "Teléfono", "Fecha", "Artículo", "Plataforma", "Unidades", "Precio unitario", "Cargos extra", "Descuento", "Pagado a tienda", "Estado", "Fecha de entrega", "Lote", "Notas", "Revisión", "Foto", "Total a cobrar", "Pagado por cliente", "Saldo pendiente", "Variante"];
export const PAYMENT_HEADERS = ["ID Pago", "ID Pedido", "Tipo", "Monto", "Fecha", "Medio", "Nota"];
const EXCHANGE_HEADERS = ["ID Cambio", "ID Pedido", "Fecha", "Prenda anterior", "Prenda nueva", "Total anterior", "Total nuevo", "Diferencia", "Nota"];
const MAX_CENTS = 100000000;
const normalize = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase().replace(/\s+/g, " ");
const ALIASES: Record<string, string[]> = {
  "Artículo": ["nombre de la prenda", "prenda", "articulo"], "Cliente": ["nombre del cliente", "nombre cliente"],
  "Precio unitario": ["precio", "precio de la prenda", "precio a cobrar"], "Unidades": ["cantidad", "cantidad de unidades"],
  "Teléfono": ["telefono", "celular"], "ID Pedido": ["id", "codigo pedido"], "Medio": ["metodo", "banco"],
};
export type ExcelPhoto = { orderId: string; row: number; name: string; blob: Blob };
export type ExcelPreview = { orders: Order[]; payments: Payment[]; exchanges: Exchange[]; photos: ExcelPhoto[]; errors: string[]; warnings: string[]; generatedIds: number; fileName: string };
type ColumnMap = Map<string, number>;

function text(value: CellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    if ("richText" in value) return value.richText.map(part => part.text).join("").trim();
    if ("text" in value) return String(value.text).trim();
    return "";
  }
  return String(value).trim();
}
function mapColumns(row: Row): ColumnMap {
  const map = new Map<string, number>();
  row.eachCell((cell, index) => {
    const key = normalize(text(cell.value));
    for (const label of [...ORDER_HEADERS, ...PAYMENT_HEADERS, ...EXCHANGE_HEADERS]) {
      if (key === normalize(label) || ALIASES[label]?.some(alias => normalize(alias) === key)) map.set(label, index);
    }
  });
  return map;
}
function field(row: Row, map: ColumnMap, name: string): CellValue {
  const column = map.get(name);
  if (!column) return null;
  const value = row.getCell(column).value;
  if (value && typeof value === "object" && ("formula" in value || "sharedFormula" in value)) throw new Error(`${name}: pega el resultado como valor; no se importan fórmulas en los datos de entrada.`);
  return value;
}
function required(value: CellValue, label: string): string {
  const result = text(value);
  if (!result) throw new Error(`falta ${label}.`);
  if (result.length > (label === "Notas" ? 2000 : 300)) throw new Error(`${label}: el texto es demasiado largo.`);
  return result;
}
function money(value: CellValue, name: string, optional = false): number {
  if (value === null || value === undefined || value === "") {
    if (optional) return 0;
    throw new Error(`falta ${name}.`);
  }
  const raw = typeof value === "number" ? value : typeof value === "string" && /^\d+(?:[.,]\d{1,2})?$/.test(value.trim()) ? Number(value.trim().replace(",", ".")) : NaN;
  const cents = Math.round(raw * 100);
  if (!Number.isFinite(raw) || Math.abs(raw * 100 - cents) > 0.000001 || cents < 0 || cents > MAX_CENTS) throw new Error(`${name}: usa un número de 0 a 1,000,000 con máximo dos decimales, sin símbolos ni separadores de miles.`);
  return cents;
}
function integer(value: CellValue, name: string, fallback: number, max: number, min = 0): number {
  const raw = value === null || value === "" ? fallback : Number(text(value));
  if (!Number.isSafeInteger(raw) || raw < min || raw > max) throw new Error(`${name}: debe ser un entero entre ${min} y ${max}.`);
  return raw;
}
function date(value: CellValue, name: string, optional = false): string {
  let result = "";
  if (value instanceof Date && Number.isFinite(value.getTime())) result = value.toISOString().slice(0, 10);
  else if (typeof value === "number") result = new Date(Math.round((value - 25569) * 86400000)).toISOString().slice(0, 10);
  else {
    const raw = text(value);
    if (!raw && optional) return "";
    const dayFirst = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw);
    result = dayFirst ? `${dayFirst[3]}-${dayFirst[2].padStart(2, "0")}-${dayFirst[1].padStart(2, "0")}` : raw;
  }
  const parsed = new Date(`${result}T12:00:00Z`);
  if (!/^20\d\d-\d{2}-\d{2}$|^2100-\d{2}-\d{2}$/.test(result) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result) throw new Error(`${name}: escribe una fecha válida en formato día/mes/año o AAAA-MM-DD (2000–2100).`);
  return result;
}
function id(value: CellValue, fallback: string, label: string): string {
  const result = text(value) || fallback;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(result)) throw new Error(`${label}: usa hasta 80 letras, números, guiones o guiones bajos.`);
  return result;
}
function headers(sheet: Worksheet, wanted: string): { row: number; map: ColumnMap } {
  for (let r = 1; r <= Math.min(30, sheet.rowCount); r++) {
    const map = mapColumns(sheet.getRow(r));
    if (map.has(wanted)) return { row: r, map };
  }
  return { row: 1, map: mapColumns(sheet.getRow(1)) };
}
function hasInput(row: Row, map: ColumnMap, keys: string[]): boolean {
  return keys.some(key => { const col = map.get(key); return col && text(row.getCell(col).value) !== ""; });
}

// Bound expansion before parsing. Rich in-cell images use their separate metadata reader.
function inspectZip(bytes: ArrayBuffer): boolean {
  const view = new DataView(bytes);
  let end = -1;
  for (let p = bytes.byteLength - 22; p >= Math.max(0, bytes.byteLength - 65557); p--) if (view.getUint32(p, true) === 0x06054b50) { end = p; break; }
  if (end < 0) throw new Error("El archivo no es un .xlsx válido.");
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true), expanded = 0, hasRichImages = false;
  if (count > 5000) throw new Error("El Excel contiene demasiados archivos internos.");
  for (let i = 0; i < count; i++) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== 0x02014b50) throw new Error("El Excel está dañado o usa un formato no compatible.");
    expanded += view.getUint32(offset + 24, true);
    const length = view.getUint16(offset + 28, true);
    const name = new TextDecoder().decode(new Uint8Array(bytes, offset + 46, length));
    if (/^xl\/(richData\/|cellimages\.xml)/i.test(name)) hasRichImages = true;
    offset += 46 + length + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
  if (expanded > 50 * 1024 * 1024) throw new Error("El Excel descomprimido supera 50 MB. Divide los pedidos en archivos más pequeños.");
  return hasRichImages;
}

export async function parseExcel(bytes: ArrayBuffer, fileName = "pedidos.xlsx"): Promise<ExcelPreview> {
  if (bytes.byteLength > 5 * 1024 * 1024) throw new Error("El Excel debe pesar 5 MB o menos.");
  const hasRichImages = inspectZip(bytes);
  const ExcelJS = await import("exceljs");
  const workbook = new ExcelJS.default.Workbook();
  // Some valid producers prefix SpreadsheetML tags. ExcelJS expects those tags
  // without a prefix, so normalize a copy in memory while preserving the source.
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(bytes);
  let normalized = false;
  for (const path of Object.keys(zip.files).filter(p => /\.xml$|\.rels$/.test(p))) {
    let xml = await zip.file(path)!.async("string");
    let changed = false;
    for (const match of xml.matchAll(/xmlns:([A-Za-z_][\w.-]*)=["'](http:\/\/schemas\.openxmlformats\.org\/(?:spreadsheetml\/2006\/main|package\/2006\/relationships))["']/g)) {
      const prefix = match[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      xml = xml.replace(new RegExp(`(<\\/?)(?:${prefix}):`, "g"), "$1");
      changed = true;
    }
    if (changed) { zip.file(path, xml.replace(/^\uFEFF/, "")); normalized = true; }
  }
  await workbook.xlsx.load(normalized ? await zip.generateAsync({ type: "arraybuffer" }) : bytes);
  const preview: ExcelPreview = { orders: [], payments: [], exchanges: [], photos: [], errors: [], warnings: [], generatedIds: 0, fileName };
  const sheet = workbook.getWorksheet("Pedidos") || workbook.worksheets.find(s => !["pagos", "abonos", "cambios", "guia", "instrucciones"].includes(normalize(s.name)));
  if (!sheet) throw new Error("No encuentro la hoja Pedidos. Descarga la plantilla para ver las columnas.");
  const header = headers(sheet, "Artículo");
  for (const name of ["ID Pedido", "Cliente", "Artículo", "Precio unitario", "Fecha"]) if (!header.map.has(name)) preview.errors.push(`${sheet.name}: falta la columna «${name}». Descarga la plantilla con las columnas necesarias.`);
  if (preview.errors.length) return preview;
  if (sheet.rowCount > 10000) throw new Error("La hoja contiene demasiadas filas; elimina filas y formatos sobrantes.");
  const seen = new Set<string>();
  const rowOrders = new Map<number, Order>();
  for (let r = header.row + 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    if (!hasInput(row, header.map, ["Cliente", "Artículo", "ID Pedido", "Precio unitario"])) continue;
    try {
      const get = (name: string) => field(row, header.map, name);
      const rawId = required(get("ID Pedido"), "ID Pedido (por ejemplo P-001; conserva ese código cuando edites el artículo)");
      const orderId = id(rawId, "", "ID Pedido");
      if (!text(rawId)) preview.generatedIds++;
      if (seen.has(orderId)) throw new Error(`ID Pedido duplicado: ${orderId}. Cada artículo debe tener un ID propio.`);
      seen.add(orderId);
      const status = text(get("Estado")) || "Pendiente";
      if (!(STATUSES as readonly string[]).includes(status)) throw new Error(`Estado: elige ${STATUSES.join(", ")}.`);
      const platformText = normalize(text(get("Plataforma")) || "Temu");
      if (!["temu", "shein"].includes(platformText)) throw new Error("Plataforma: usa Temu o SHEIN.");
      const photoKey = text(get("Foto"));
      if (photoKey && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(photoKey)) throw new Error("Foto: deja esta celda vacía y pega la imagen encima de ella, o conserva el código de una exportación de la app.");
      const order: Order = {
        id: orderId, client: required(get("Cliente"), "Cliente"), article: required(get("Artículo"), "Artículo"), phone: text(get("Teléfono")), batch: text(get("Lote")), variant: text(get("Variante")),
        quantity: integer(get("Unidades"), "Unidades", 1, 9999, 1), unitCents: money(get("Precio unitario"), "Precio unitario"), extraCents: money(get("Cargos extra"), "Cargos extra", true), discountCents: money(get("Descuento"), "Descuento", true),
        storeCents: money(get("Pagado a tienda"), "Pagado a tienda", true), platform: platformText === "temu" ? "Temu" : "SHEIN", status: status as Order["status"], date: date(get("Fecha"), "Fecha"), deliveryDate: date(get("Fecha de entrega"), "Fecha de entrega", true),
        notes: text(get("Notas")), photoKey, revision: integer(get("Revisión"), "Revisión", 0, Number.MAX_SAFE_INTEGER),
      };
      const rawTotal = order.quantity * order.unitCents + order.extraCents - order.discountCents;
      if (rawTotal < 0 || rawTotal > MAX_CENTS) throw new Error("El total del artículo debe quedar entre 0 y RD$ 1,000,000.");
      preview.orders.push(order); rowOrders.set(r, order);
    } catch (error) { preview.errors.push(`${sheet.name}, fila ${r}: ${error instanceof Error ? error.message : "dato no válido"}`); }
  }
  if (preview.orders.length > 1500) preview.errors.push("Máximo 1,500 artículos por archivo.");
  const images = sheet.getImages();
  const photoRows = new Set<number>();
  if (hasRichImages) {
    const embedded = await readInCellPhotos(bytes, sheet.name);
    for (const photo of embedded) {
      const order = rowOrders.get(photo.row);
      const column = header.map.get("Foto");
      if (!order || (column && photo.column !== column) || photoRows.has(photo.row)) {
        preview.errors.push(`${sheet.name}, foto en fila ${photo.row}: la imagen debe estar en la columna Foto de una fila válida, con una sola foto por artículo.`);
        continue;
      }
      photoRows.add(photo.row);
      preview.photos.push({ orderId: order.id, row: photo.row, name: photo.name, blob: photo.blob });
    }
  }
  for (const image of images) {
    const start = image.range.tl;
    const end = image.range.br;
    const r = Math.floor(start.row) + 1;
    try {
      const order = rowOrders.get(r);
      if (!order) throw new Error("La foto no está anclada en una fila de artículo válida.");
      if (end && end.row > r + 0.001) throw new Error("La foto ocupa varias filas. Ajusta su altura para que quede dentro de una sola fila.");
      const extent = (image.range as unknown as { ext?: { height: number } }).ext;
      const rowHeight = (sheet.getRow(r).height || sheet.properties.defaultRowHeight || 15) * 96 / 72;
      if (extent && (extent.height + (start.row % 1) * rowHeight) > rowHeight + 1) throw new Error("La foto ocupa varias filas. Ajusta su altura para que quede dentro de una sola fila.");
      const photoColumn = header.map.get("Foto");
      if (photoColumn && Math.floor(start.col) + 1 !== photoColumn) throw new Error("Mueve la foto a la columna Foto, dentro de la fila del artículo.");
      if (photoRows.has(r)) throw new Error("Hay más de una foto en esta fila. Deja una sola foto por artículo.");
      photoRows.add(r);
      const media = workbook.getImage(Number(image.imageId));
      if (!media?.buffer || !["jpeg", "png"].includes(media.extension)) throw new Error("La foto debe estar insertada como JPG o PNG.");
      const bytes = new Uint8Array(media.buffer);
      if (bytes.byteLength > 5 * 1024 * 1024) throw new Error("La foto pesa más de 5 MB.");
      preview.photos.push({ orderId: order.id, row: r, name: `${order.id}.${media.extension}`, blob: new Blob([bytes], { type: media.extension === "png" ? "image/png" : "image/jpeg" }) });
    } catch (error) { preview.errors.push(`${sheet.name}, foto en fila ${r}: ${error instanceof Error ? error.message : "foto no válida"}`); }
  }
  const payments = workbook.getWorksheet("Pagos") || workbook.getWorksheet("Abonos");
  if (payments) {
    const head = headers(payments, "ID Pedido"); const ids = new Set<string>();
    for (const label of ["ID Pago", "ID Pedido", "Tipo", "Monto", "Fecha"]) if (!head.map.has(label)) preview.errors.push(`${payments.name}: falta la columna «${label}».`);
    if (payments.rowCount > 10000) throw new Error("La hoja Pagos contiene demasiadas filas.");
    for (let r = head.row + 1; r <= payments.rowCount; r++) {
      const row = payments.getRow(r); if (!hasInput(row, head.map, ["ID Pago", "ID Pedido", "Monto"])) continue;
      try {
        const get = (name: string) => field(row, head.map, name);
        const paymentId = id(required(get("ID Pago"), "ID Pago (por ejemplo A-001; no reutilices el código para otro pago)"), "", "ID Pago");
        if (ids.has(paymentId)) throw new Error(`ID Pago duplicado: ${paymentId}.`); ids.add(paymentId);
        const kind = required(get("Tipo"), "Tipo");
        if (!["Abono", "Devolución"].includes(kind)) throw new Error("Tipo: usa Abono o Devolución.");
        const amountCents = money(get("Monto"), "Monto"); if (!amountCents) throw new Error("Monto debe ser mayor que cero.");
        preview.payments.push({ id: paymentId, orderId: id(required(get("ID Pedido"), "ID Pedido"), "", "ID Pedido"), kind: kind as Payment["kind"], amountCents, date: date(get("Fecha"), "Fecha"), method: text(get("Medio")) || "Efectivo", note: text(get("Nota")) });
      } catch (error) { preview.errors.push(`${payments.name}, fila ${r}: ${error instanceof Error ? error.message : "dato no válido"}`); }
    }
  }
  if (preview.payments.length > 3000) preview.errors.push("Máximo 3,000 pagos por archivo.");
  const changes = workbook.getWorksheet("Cambios");
  if (changes) {
    const head = headers(changes, "ID Cambio"); const ids = new Set<string>();
    for (let r = head.row + 1; r <= Math.min(changes.rowCount, 3001); r++) {
      const row = changes.getRow(r); if (!hasInput(row, head.map, ["ID Cambio", "ID Pedido", "Prenda nueva"])) continue;
      try {
        const get = (name: string) => field(row, head.map, name);
        const changeId = id(required(get("ID Cambio"), "ID Cambio"), "", "ID Cambio");
        if (ids.has(changeId)) throw new Error(`ID Cambio duplicado: ${changeId}.`); ids.add(changeId);
        const oldTotalCents = money(get("Total anterior"), "Total anterior"), newTotalCents = money(get("Total nuevo"), "Total nuevo");
        preview.exchanges.push({ id: changeId, orderId: id(required(get("ID Pedido"), "ID Pedido"), "", "ID Pedido"), date: date(get("Fecha"), "Fecha"), oldArticle: required(get("Prenda anterior"), "Prenda anterior"), newArticle: required(get("Prenda nueva"), "Prenda nueva"), oldTotalCents, newTotalCents, differenceCents: newTotalCents - oldTotalCents, note: text(get("Nota")) });
      } catch (error) { preview.errors.push(`${changes.name}, fila ${r}: ${error instanceof Error ? error.message : "dato no válido"}`); }
    }
    if (changes.rowCount > 3001) preview.errors.push("Máximo 3,000 cambios por archivo.");
  }
  if (!preview.orders.length && !preview.payments.length && !preview.exchanges.length && !preview.errors.length) preview.warnings.push("El archivo solo tiene encabezados. Añade tus artículos y vuelve a subirlo.");
  if (preview.generatedIds) preview.warnings.push(`Se crearán códigos para ${preview.generatedIds} artículos sin ID. El mismo archivo conserva esos códigos; para editar pedidos luego, descarga la exportación de la app y conserva sus IDs y revisiones.`);
  return preview;
}

export async function exportExcel(orders: Order[], payments: Payment[], exchanges: Exchange[] = [], fetchPhoto?: (key: string) => Promise<Blob>): Promise<Blob> {
  const ExcelJS = await import("exceljs"); const workbook = new ExcelJS.default.Workbook();
  workbook.creator = "Mis pedidos"; workbook.calcProperties.fullCalcOnLoad = true;
  const sheet = workbook.addWorksheet("Pedidos"); sheet.addRow(ORDER_HEADERS);
  for (const order of orders) {
    const paid = paidFor(order.id, payments); const total = orderTotal(order);
    const row = sheet.addRow([order.id, order.client, order.phone, new Date(`${order.date}T12:00:00Z`), order.article, order.platform, order.quantity, order.unitCents / 100, order.extraCents / 100, order.discountCents / 100, order.storeCents / 100, order.status, order.deliveryDate ? new Date(`${order.deliveryDate}T12:00:00Z`) : null, order.batch, order.notes, order.revision, order.photoKey, total / 100, paid / 100, (total - paid) / 100, order.variant]);
    const r = row.number;
    row.getCell(18).value = { formula: `IF(E${r}="","",IF(L${r}="Cancelado",0,G${r}*H${r}+I${r}-J${r}))`, result: total / 100 };
    row.getCell(19).value = { formula: `IF(E${r}="","",SUMIFS(Pagos!$D$2:$D$10001,Pagos!$B$2:$B$10001,A${r},Pagos!$C$2:$C$10001,"Abono")-SUMIFS(Pagos!$D$2:$D$10001,Pagos!$B$2:$B$10001,A${r},Pagos!$C$2:$C$10001,"Devolución"))`, result: paid / 100 };
    row.getCell(20).value = { formula: `IF(E${r}="","",R${r}-S${r})`, result: (total - paid) / 100 };
    if (order.photoKey && fetchPhoto) {
      const blob = await fetchPhoto(order.photoKey);
      if (!blob.size || blob.size > 5 * 1024 * 1024 || !["image/png", "image/jpeg", "image/webp"].includes(blob.type)) throw new Error(`No pude exportar la foto de ${order.article}. Intenta de nuevo.`);
      let imageBlob = blob;
      if (blob.type === "image/webp") {
        const bitmap = await createImageBitmap(blob); const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
        canvas.getContext("2d")!.drawImage(bitmap, 0, 0); bitmap.close();
        imageBlob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(result => result ? resolve(result) : reject(new Error("No pude convertir la foto.")), "image/png"));
      }
      const imageId = workbook.addImage({ buffer: new Uint8Array(await imageBlob.arrayBuffer()) as never, extension: imageBlob.type === "image/jpeg" ? "jpeg" : "png" });
      row.height = 84;
      sheet.addImage(imageId, { tl: { col: 16, row: row.number - 1 }, br: { col: 16.95, row: row.number - 0.05 }, editAs: "oneCell" } as Parameters<typeof sheet.addImage>[1]);
    }
  }
  const pay = workbook.addWorksheet("Pagos"); pay.addRow(PAYMENT_HEADERS);
  for (const p of payments) pay.addRow([p.id, p.orderId, p.kind, p.amountCents / 100, new Date(`${p.date}T12:00:00Z`), p.method, p.note]);
  if (exchanges.length) {
    const changes = workbook.addWorksheet("Cambios"); changes.addRow(EXCHANGE_HEADERS);
    for (const e of exchanges) changes.addRow([e.id, e.orderId, new Date(`${e.date}T12:00:00Z`), e.oldArticle, e.newArticle, e.oldTotalCents / 100, e.newTotalCents / 100, e.differenceCents / 100, e.note]);
  }
  for (const ws of workbook.worksheets) {
    ws.views = [{ state: "frozen", ySplit: 1, xSplit: ws === sheet ? 2 : 0 }];
    ws.getRow(1).font = { name: "Arial", bold: true, color: { argb: "FFFFFFFF" } }; ws.getRow(1).height = 30;
    ws.getRow(1).eachCell(cell => { cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF225644" } }; cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true }; });
    ws.columns.forEach((column, index) => { column.width = index === 0 ? 30 : 23; });
  }
  sheet.getColumn(5).width = 32; sheet.getColumn(17).width = 22;
  [4, 13].forEach(c => { sheet.getColumn(c).numFmt = "dd/mm/yyyy"; });
  [8, 9, 10, 11, 18, 19, 20].forEach(c => { sheet.getColumn(c).numFmt = '"RD$ "#,##0.00'; });
  pay.getColumn(4).numFmt = '"RD$ "#,##0.00'; pay.getColumn(5).numFmt = "dd/mm/yyyy";
  const bytes = await workbook.xlsx.writeBuffer();
  return new Blob([new Uint8Array(bytes)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}
