import JSZip from "jszip";
import type { Order, Payment, Exchange, Invoice } from "./types";
import type { Client, Quote, InvoiceDraft } from "./business-types";

/** These are changed records, not a replacement of every row in the workbook. */
export type WorkbookPatch = { orders: Order[]; payments: Payment[]; exchanges?: Exchange[]; clients: Client[]; quotes: Quote[]; invoiceDrafts: InvoiceDraft[]; invoices: (Invoice & { sourceDraftId?: string; clientId?: string })[] };
type Value = string | number | { date: string };
type RecordValues = Record<string, Value>;
type Sheet = { name: string; path: string; xml: string; header: number; columns: Map<string, number>; rows: Map<number, string>; prefix: string; changed: boolean };
const normalize = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, "").trim();
const escapeXml = (value: string) => { if ([...value].some(char => { const code = char.codePointAt(0)!; return code < 32 && ![9, 10, 13].includes(code) || code >= 0xd800 && code <= 0xdfff || code === 0xfffe || code === 0xffff; })) throw new Error("Hay un carácter no válido para Excel. Revisa los nombres y las notas antes de enviar cambios."); return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;"); };
const decode = (value: string) => value.replace(/&#x([a-f\d]+);|&#(\d+);|&(amp|lt|gt|quot|apos);/gi, (_, hex, decimal, named) => hex ? String.fromCodePoint(parseInt(hex, 16)) : decimal ? String.fromCodePoint(Number(decimal)) : ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[named.toLowerCase()] || "");
const attr = (tag: string, name: string) => decode(new RegExp(`(?:^|\\s)${name}=["']([^"']*)["']`).exec(tag)?.[1] || "");
const cells = (row: string) => [...row.matchAll(/<(?:\w+:)?c\b[^>]*?(?:\/>|>[\s\S]*?<\/(?:\w+:)?c>)/g)].map(match => match[0]);
const hasFormula = (cell: string) => /<(?:\w+:)?f\b/.test(cell);
const columnNumber = (reference: string) => [...reference.replace(/\d/g, "")].reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0);
const columnLetters = (index: number): string => index ? columnLetters(Math.floor((index - 1) / 26)) + String.fromCharCode(65 + (index - 1) % 26) : "";
const date = (value: string): Value => value ? { date: value } : "";
const amount = (cents: number) => cents / 100;
const CLIENT_HEADERS = ["ID Cliente", "Cliente", "Teléfono", "Correo", "Dirección", "Activo", "Notas", "Revisión"];
const QUOTE_HEADERS = ["ID Cotización", "ID Cliente", "Fecha", "Válida hasta", "Estado", "Notas", "Revisión", "Total"];
const QUOTE_LINE_HEADERS = ["ID Línea", "ID Cotización", "Artículo", "Variante", "Plataforma", "Unidades", "Precio unitario", "Cargos extra", "Descuento", "Importe"];
const DRAFT_HEADERS = ["ID Borrador", "ID Cliente", "Fecha", "Nombre del negocio", "Modo de precio", "Monto manual", "Mostrar importes", "Notas", "Revisión"];
const DRAFT_LINE_HEADERS = ["ID Borrador", "ID Pedido", "Aviso de entrega"];
const INVOICE_HEADERS = ["ID Factura", "Número", "ID Cliente", "Cliente", "Teléfono", "Fecha emisión", "Nombre negocio", "Modo precio", "Mostrar importes", "Total", "Pagado", "Saldo", "Notas", "ID Borrador"];
const INVOICE_LINE_HEADERS = ["ID Factura", "ID Pedido", "Artículo", "Variante", "Plataforma", "Unidades", "Precio unitario", "Cargos extra", "Descuento", "Importe", "Estado pedido", "Aviso de entrega", "Fecha pedido", "Fecha entrega"];

/** Patch OOXML directly: media, rich in-cell images, drawings, styles, validation,
 * formulas and all unrelated ZIP members are retained, never re-authored. */
export async function patchWorkbook(sourceBytes: Uint8Array | ArrayBuffer, snapshot: WorkbookPatch): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(sourceBytes);
  if (!zip.file("xl/workbook.xml") || !zip.file("xl/_rels/workbook.xml.rels")) throw new Error("El archivo no contiene un libro Excel válido.");
  let workbook = await zip.file("xl/workbook.xml")!.async("string");
  let workbookRels = await zip.file("xl/_rels/workbook.xml.rels")!.async("string");
  let contentTypes = await zip.file("[Content_Types].xml")!.async("string");
  const stringsXml = await zip.file("xl/sharedStrings.xml")?.async("string") || "";
  const richText = (xml: string) => [...xml.matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g)].map(match => decode(match[1])).join("");
  const sharedStrings = [...stringsXml.matchAll(/<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/g)].map(match => richText(match[1]));
  const cellText = (cell: string) => attr(cell, "t") === "s" ? sharedStrings[Number(/<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/.exec(cell)?.[1] || "-1")] || "" : attr(cell, "t") === "inlineStr" ? richText(cell) : decode(/<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/.exec(cell)?.[1] || "");
  const resolvePath = (base: string, target: string) => { const parts = (target.startsWith("/") ? target.slice(1) : `${base}/${target}`).split("/"); const normalized: string[] = []; for (const part of parts) { if (part === "..") normalized.pop(); else if (part && part !== ".") normalized.push(part); } return normalized.join("/"); };
  const relationships = () => new Map([...workbookRels.matchAll(/<(?:\w+:)?Relationship\b[^>]*\/>/g)].map(match => [attr(match[0], "Id"), attr(match[0], "Target")]));
  const sheets: Sheet[] = [];
  for (const match of workbook.matchAll(/<(?:\w+:)?sheet\b[^>]*\/>/g)) {
    const target = relationships().get(attr(match[0], "r:id")); if (!target) continue;
    const path = resolvePath("xl", target), entry = zip.file(path); if (!entry) throw new Error(`No se encuentra la hoja ${attr(match[0], "name")}.`);
    const xml = await entry.async("string"), rows = new Map<number, string>();
    for (const row of xml.matchAll(/<(?:\w+:)?row\b[^>]*?(?:\/>|>[\s\S]*?<\/(?:\w+:)?row>)/g)) rows.set(Number(attr(row[0], "r")), row[0]);
    sheets.push({ name: attr(match[0], "name"), path, xml, rows, columns: new Map(), header: 0, prefix: /<(\w+:)?worksheet\b/.exec(xml)?.[1] || "", changed: false });
  }
  let styles = await zip.file("xl/styles.xml")?.async("string") || "";
  let fallbackDateStyle = 0;
  const getDateStyle = () => {
    if (fallbackDateStyle) return fallbackDateStyle;
    const block = /<(?:\w+:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:\w+:)?cellXfs>/.exec(styles);
    if (!block) return 0;
    const xfs = [...block[1].matchAll(/<(?:\w+:)?xf\b[^>]*?(?:\/>|>[\s\S]*?<\/(?:\w+:)?xf>)/g)];
    const existing = xfs.findIndex(match => ["14", "22"].includes(attr(match[0], "numFmtId")));
    if (existing >= 0) { fallbackDateStyle = existing; return existing; }
    const next = xfs.length, p = /<(\w+:)?cellXfs\b/.exec(block[0])?.[1] || "";
    const added = `<${p}xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`;
    const replaced = block[0].replace(/count=["']\d+["']/, `count="${next + 1}"`).replace(new RegExp(`</${p}cellXfs>`), `${added}</${p}cellXfs>`);
    styles = styles.replace(block[0], replaced); fallbackDateStyle = next; zip.file("xl/styles.xml", styles); return next;
  };
  function valueCell(reference: string, value: Value, existing = "", prefix = "") {
    let attributes = existing ? /<(?:\w+:)?c\b([^>]*?)(?:\/?>)/.exec(existing)?.[1] || "" : ` r="${reference}"`;
    attributes = attributes.replace(/\s+t=["'][^"']*["']/, "");
    if (!attr(attributes, "r")) attributes += ` r="${reference}"`;
    if (typeof value === "object") {
      const parsed = Date.parse(value.date.length === 10 ? `${value.date}T00:00:00Z` : value.date);
      if (!Number.isFinite(parsed)) throw new Error(`Fecha inválida al escribir ${reference}.`);
      if (!attr(attributes, "s")) attributes += ` s="${getDateStyle()}"`;
      value = parsed / 86400000 + 25569;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error(`Número inválido al escribir ${reference}.`);
      return `<${prefix}c${attributes}><${prefix}v>${value}</${prefix}v></${prefix}c>`;
    }
    return `<${prefix}c${attributes} t="inlineStr"><${prefix}is><${prefix}t xml:space="preserve">${escapeXml(value)}</${prefix}t></${prefix}is></${prefix}c>`;
  }
  async function sheetFor(name: string, headers: string[], required = false) {
    let sheet = sheets.find(item => normalize(item.name) === normalize(name));
    if (!sheet && required) throw new Error(`Falta la hoja ${name}. Descarga la plantilla actual antes de enviar cambios.`);
    if (!sheet) {
      const usedIds = [...workbook.matchAll(/<(?:\w+:)?sheet\b[^>]*\/>/g)].map(match => Number(attr(match[0], "sheetId")));
      const nextId = Math.max(0, ...usedIds) + 1;
      let number = nextId; while (zip.file(`xl/worksheets/sheet${number}.xml`)) number++;
      let relNumber = nextId; while (workbookRels.includes(`Id="rIdMiEncargo${relNumber}"`)) relNumber++;
      const relId = `rIdMiEncargo${relNumber}`, path = `xl/worksheets/sheet${number}.xml`;
      const row = `<row r="4">${headers.map((header, index) => valueCell(`${columnLetters(index + 1)}4`, header)).join("")}</row>`;
      const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A4:${columnLetters(headers.length)}4"/><sheetData>${row}</sheetData></worksheet>`;
      sheet = { name, path, xml, rows: new Map([[4, row]]), header: 4, columns: new Map(), prefix: "", changed: true }; sheets.push(sheet);
      const p = /<(\w+:)?sheets\b/.exec(workbook)?.[1] || "";
      workbook = workbook.replace(new RegExp(`</${p}sheets>`), `<${p}sheet name="${escapeXml(name)}" sheetId="${nextId}" r:id="${relId}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></${p}sheets>`);
      workbookRels = workbookRels.replace(/<\/(\w+:)?Relationships>/, (closing, relPrefix = "") => `<${relPrefix}Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${number}.xml"/>${closing}`);
      contentTypes = contentTypes.replace(/<\/(\w+:)?Types>/, (closing, typePrefix = "") => `<${typePrefix}Override PartName="/${path}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>${closing}`);
    }
    if (!sheet.header) for (const [number, row] of sheet.rows) {
      if (number > 30) continue;
      const entries = cells(row).map(cell => [normalize(cellText(cell)), columnNumber(attr(cell, "r"))] as const);
      if (entries.some(([label]) => label === normalize(headers[0]))) { sheet.header = number; sheet.columns = new Map(entries); break; }
    }
    if (sheet.header && !sheet.columns.size) sheet.columns = new Map(cells(sheet.rows.get(sheet.header) || "").map(cell => [normalize(cellText(cell)), columnNumber(attr(cell, "r"))]));
    // The original workbook used Prenda; the expanded template calls the same
    // exchange snapshot fields Artículo. Both remain valid input layouts.
    for (const [legacy, current] of [["Prenda anterior", "Artículo anterior"], ["Prenda nueva", "Artículo nuevo"]]) {
      const legacyKey = normalize(legacy), currentKey = normalize(current);
      if (!sheet.columns.has(legacyKey) && sheet.columns.has(currentKey)) sheet.columns.set(legacyKey, sheet.columns.get(currentKey)!);
    }
    if (!sheet.header) throw new Error(`${name}: no se encuentra la fila de encabezados.`);
    for (const header of headers) if (!sheet.columns.has(normalize(header))) throw new Error(`${name}: falta la columna «${header}».`);
    return sheet;
  }
  function keyAt(sheet: Sheet, row: string, keys: string[]) { return keys.map(key => { const column = sheet.columns.get(normalize(key)); return cellText(cells(row).find(cell => columnNumber(attr(cell, "r")) === column) || ""); }).join("\u0000"); }
  function writeRow(sheet: Sheet, rowNumber: number, values: RecordValues, clearing = false) {
    const existing = sheet.rows.get(rowNumber) || `<${sheet.prefix}row r="${rowNumber}"></${sheet.prefix}row>`;
    const rowCells = new Map(cells(existing).map(cell => [columnNumber(attr(cell, "r")), cell]));
    const template = sheet.rows.get(sheet.header + 1) || "";
    const isBlankRow = !cells(existing).some(cell => !hasFormula(cell) && cellText(cell) !== "");
    // Appending an entry beyond the prepared rows also extends its calculated
    // columns, without moving rows (which would move image anchors).
    if (isBlankRow && !clearing) for (const templateCell of cells(template)) {
      const column = columnNumber(attr(templateCell, "r"));
      if (rowCells.has(column) || !hasFormula(templateCell)) continue;
      const label = [...sheet.columns].find(([, index]) => index === column)?.[0] || "";
      const calculatedLabel = label.replace(/\(calculad[oa]\)$/, "");
      const calculated = ["total", "importe", "totalacobrar", "pagadoporcliente", "saldopendiente", "facturaemitida"].includes(calculatedLabel)
        || normalize(sheet.name) === "precios" && calculatedLabel === "idcliente"
        || normalize(sheet.name) === "facturas" && calculatedLabel === "estado";
      // Never clone a user's IMAGE formula or formulas in unrelated columns.
      if (!calculated) continue;
      const formula = /<(?:\w+:)?f\b([^>]*)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?f>)/.exec(templateCell);
      let expression = formula?.[2], baseRow = sheet.header + 1;
      if (!expression && formula && attr(formula[0], "t") === "shared") {
        const sharedId = attr(formula[0], "si");
        for (const [candidateRow, xml] of sheet.rows) for (const cell of cells(xml)) {
          const base = /<(?:\w+:)?f\b[^>]*>([\s\S]*?)<\/(?:\w+:)?f>/.exec(cell);
          if (base?.[1] && attr(base[0], "si") === sharedId) { expression = base[1]; baseRow = candidateRow; }
        }
      }
      if (!expression) continue;
      const shifted = decode(expression).split(/("(?:[^"]|"")*")/).map((part, index) => index % 2 ? part : part.replace(/(\$?[A-Z]{1,3})(\$?)(\d+)\b/g, (_, letters, fixed, number) => `${letters}${fixed}${fixed ? number : Number(number) + rowNumber - baseRow}`)).join("");
      const style = attr(templateCell, "s"), reference = `${columnLetters(column)}${rowNumber}`;
      rowCells.set(column, `<${sheet.prefix}c r="${reference}"${style ? ` s="${style}"` : ""}><${sheet.prefix}f>${escapeXml(shifted)}</${sheet.prefix}f></${sheet.prefix}c>`);
    }
    for (const [header, value] of Object.entries(values)) {
      const column = sheet.columns.get(normalize(header)); if (!column) continue;
      const old = rowCells.get(column) || "", reference = `${columnLetters(column)}${rowNumber}`;
      if (hasFormula(old)) { if (["foto", "total", "importe", "totalacobrar", "pagadoporcliente", "saldopendiente"].includes(normalize(header))) continue; throw new Error(`${sheet.name}!${reference}: hay una fórmula en un campo de entrada. Resuélvela antes de enviar cambios.`); }
      if (normalize(header) === "foto" && (/\b(?:vm|cm)=["']/.test(old) || !value)) continue;
      const templateCell = cells(template).find(cell => columnNumber(attr(cell, "r")) === column);
      const inherited = old || (attr(templateCell || "", "s") ? `<c r="${reference}" s="${attr(templateCell!, "s")}"/>` : "");
      rowCells.set(column, valueCell(reference, clearing ? "" : value, inherited, sheet.prefix));
    }
    const open = /^<(?:\w+:)?row\b[^>]*>/.exec(existing)?.[0] || `<${sheet.prefix}row r="${rowNumber}">`;
    const cleanOpen = open.replace(/\/>$/, ">");
    const nonCells = existing.replace(/^<(?:\w+:)?row\b[^>]*>/, "").replace(/<\/(?:\w+:)?row>$/, "").replace(/<(?:\w+:)?c\b[^>]*?(?:\/>|>[\s\S]*?<\/(?:\w+:)?c>)/g, "");
    sheet.rows.set(rowNumber, cleanOpen + [...rowCells].sort(([a], [b]) => a - b).map(([, cell]) => cell).join("") + nonCells + `</${sheet.prefix}row>`); sheet.changed = true;
  }
  async function upsert(name: string, headers: string[], keys: string[], records: RecordValues[], options: { required?: boolean; parents?: { key: string; ids: string[] } } = {}) {
    if (!records.length && !options.parents?.ids.length) return;
    const sheet = await sheetFor(name, headers, options.required), indexed = new Map<string, number>();
    const emptyKey = keys.map(() => "").join("\u0000");
    for (const [number, row] of sheet.rows) if (number > sheet.header) {
      const key = keyAt(sheet, row, keys); if (key === emptyKey) continue;
      if (indexed.has(key)) throw new Error(`${name}: ID duplicado ${key.replace(/\u0000/g, " / ")}. Corrígelo antes de enviar cambios.`);
      indexed.set(key, number);
    }
    const incoming = new Set(records.map(record => keys.map(key => String(record[key] ?? "")).join("\u0000")));
    if (options.parents) for (const [number, row] of sheet.rows) if (number > sheet.header && options.parents.ids.includes(keyAt(sheet, row, [options.parents.key])) && !incoming.has(keyAt(sheet, row, keys))) writeRow(sheet, number, Object.fromEntries(headers.map(header => [header, ""])), true);
    for (const record of records) {
      const key = keys.map(key => String(record[key] ?? "")).join("\u0000"); let number = indexed.get(key);
      if (!number) {
        number = sheet.header + 1;
        while (number <= 10000) { const row = sheet.rows.get(number); if (!row || !cells(row).some(cell => !hasFormula(cell) && cellText(cell) !== "")) break; number++; }
        if (number > 10000) throw new Error(`${name}: supera el límite de 10,000 filas.`);
      }
      writeRow(sheet, number, record); indexed.set(key, number);
    }
  }
  await upsert("Clientes", CLIENT_HEADERS, ["ID Cliente"], snapshot.clients.map(client => ({ "ID Cliente": client.id, Cliente: client.name, "Teléfono": client.phone, Correo: client.email, "Dirección": client.address, Activo: client.active ? "Sí" : "No", Notas: client.notes, "Revisión": client.revision })));
  if (snapshot.orders.length) {
    const ordersSheet = await sheetFor("Pedidos", ["ID Pedido"], true);
    const v2 = !ordersSheet.columns.has(normalize("Cliente"));
    if (v2 && snapshot.orders.some(order => !order.clientId)) throw new Error("Hay pedidos sin ID Cliente. Asigna cada uno a un cliente registrado antes de enviarlo al Excel.");
    const orderRows = snapshot.orders.map(order => ({ "ID Pedido": order.id, "ID Cliente": order.clientId || "", Cliente: order.client, "Teléfono": order.phone, Fecha: date(order.date), "Artículo": order.article, Plataforma: order.platform, Unidades: order.quantity, "Precio unitario": amount(order.unitCents), "Cargos extra": amount(order.extraCents), Descuento: amount(order.discountCents), "Pagado a tienda": amount(order.storeCents), Estado: order.status, "Fecha de entrega": date(order.deliveryDate), Lote: order.batch, Notas: order.notes, "Revisión": order.revision, Foto: order.photoKey, Variante: order.variant }));
    await upsert("Pedidos", ["ID Pedido"], ["ID Pedido"], orderRows, { required: true });
    if (sheets.some(sheet => normalize(sheet.name) === "precios")) await upsert("Precios", ["ID Pedido", "Precio unitario", "Cargos extra", "Descuento", "Pagado a tienda"], ["ID Pedido"], orderRows.map(order => ({ "ID Pedido": order["ID Pedido"], "Precio unitario": order["Precio unitario"], "Cargos extra": order["Cargos extra"], Descuento: order.Descuento, "Pagado a tienda": order["Pagado a tienda"] })));
  }
  await upsert("Pagos", ["ID Pago", "ID Pedido", "Tipo", "Monto", "Fecha", "Medio", "Nota"], ["ID Pago"], snapshot.payments.map(payment => ({ "ID Pago": payment.id, "ID Pedido": payment.orderId, Tipo: payment.kind, Monto: amount(payment.amountCents), Fecha: date(payment.date), Medio: payment.method, Nota: payment.note })));
  await upsert("Cambios", ["ID Cambio", "ID Pedido", "Fecha", "Prenda anterior", "Prenda nueva", "Total anterior", "Total nuevo", "Diferencia", "Nota"], ["ID Cambio"], (snapshot.exchanges || []).map(item => ({ "ID Cambio": item.id, "ID Pedido": item.orderId, Fecha: date(item.date), "Prenda anterior": item.oldArticle, "Prenda nueva": item.newArticle, "Total anterior": amount(item.oldTotalCents), "Total nuevo": amount(item.newTotalCents), Diferencia: amount(item.differenceCents), Nota: item.note })));
  await upsert("Cotizaciones", QUOTE_HEADERS, ["ID Cotización"], snapshot.quotes.map(quote => ({ "ID Cotización": quote.id, "ID Cliente": quote.clientId, Fecha: date(quote.date), "Válida hasta": date(quote.validUntil), Estado: quote.status, Notas: quote.notes, "Revisión": quote.revision, Total: amount(quote.totalCents) })));
  await upsert("DetalleCotizaciones", QUOTE_LINE_HEADERS, ["ID Cotización", "ID Línea"], snapshot.quotes.flatMap(quote => quote.items.map(item => ({ "ID Línea": item.id, "ID Cotización": quote.id, "Artículo": item.article, Variante: item.variant, Plataforma: item.platform, Unidades: item.quantity, "Precio unitario": amount(item.unitCents), "Cargos extra": amount(item.extraCents), Descuento: amount(item.discountCents), Importe: amount(item.quantity * item.unitCents + item.extraCents - item.discountCents) }))), { parents: { key: "ID Cotización", ids: snapshot.quotes.map(quote => quote.id) } });
  await upsert("Facturas", DRAFT_HEADERS, ["ID Borrador"], snapshot.invoiceDrafts.map(draft => ({ "ID Borrador": draft.id, "ID Cliente": draft.clientId, Fecha: date(draft.date), "Nombre del negocio": draft.businessName, "Modo de precio": draft.pricingMode === "manual" ? "Manual" : "Precios registrados", "Monto manual": amount(draft.manualTotalCents), "Mostrar importes": draft.showAmounts ? "Sí" : "No", Notas: draft.notes, "Revisión": draft.revision })));
  await upsert("DetalleFacturas", DRAFT_LINE_HEADERS, ["ID Borrador", "ID Pedido"], snapshot.invoiceDrafts.flatMap(draft => draft.items.map(item => ({ "ID Borrador": draft.id, "ID Pedido": item.orderId, "Aviso de entrega": item.deliveryLabel }))), { parents: { key: "ID Borrador", ids: snapshot.invoiceDrafts.map(draft => draft.id) } });
  const draftFor = (invoice: Invoice) => snapshot.invoiceDrafts.find(draft => draft.issuedInvoiceId === invoice.id);
  await upsert("FacturasEmitidas", INVOICE_HEADERS, ["ID Factura"], snapshot.invoices.map(invoice => ({ "ID Factura": invoice.id, "Número": invoice.number, "ID Cliente": invoice.clientId || draftFor(invoice)?.clientId || "", Cliente: invoice.client, "Teléfono": invoice.phone, "Fecha emisión": date(invoice.issuedAt), "Nombre negocio": invoice.businessName, "Modo precio": invoice.pricingMode === "manual" ? "Manual" : "Precios registrados", "Mostrar importes": invoice.showAmounts ? "Sí" : "No", Total: amount(invoice.totalCents), Pagado: amount(invoice.paidCents), Saldo: amount(invoice.balanceCents), Notas: invoice.notes, "ID Borrador": invoice.sourceDraftId || draftFor(invoice)?.id || "" })));
  await upsert("DetalleEmitidas", INVOICE_LINE_HEADERS, ["ID Factura", "ID Pedido"], snapshot.invoices.flatMap(invoice => invoice.items.map(item => ({ "ID Factura": invoice.id, "ID Pedido": item.orderId, "Artículo": item.article, Variante: item.variant, Plataforma: item.platform, Unidades: item.quantity, "Precio unitario": amount(item.unitCents), "Cargos extra": amount(item.extraCents), Descuento: amount(item.discountCents), Importe: amount(item.totalCents), "Estado pedido": item.status, "Aviso de entrega": item.deliveryLabel, "Fecha pedido": date(item.orderDate || ""), "Fecha entrega": date(item.deliveryDate || "") }))));
  for (const sheet of sheets.filter(item => item.changed)) {
    const body = [...sheet.rows].sort(([a], [b]) => a - b).map(([, row]) => row).join("");
    sheet.xml = sheet.xml.replace(/<(?:\w+:)?sheetData\b[^>]*?(?:\/>|>[\s\S]*?<\/(?:\w+:)?sheetData>)/, `<${sheet.prefix}sheetData>${body}</${sheet.prefix}sheetData>`);
    const lastRow = Math.max(sheet.header, ...sheet.rows.keys());
    const expand = (reference: string) => { const parts = reference.split(":"); const end = parts[1] || parts[0]; return `${parts[0]}:${end.replace(/\d+$/, String(Math.max(Number(/\d+$/.exec(end)?.[0] || "1"), lastRow)))}`; };
    sheet.xml = sheet.xml.replace(/(<(?:\w+:)?(?:dimension|autoFilter)\b[^>]*\bref=["'])([^"']+)(["'])/g, (_, start, reference, end) => start + expand(reference) + end);
    zip.file(sheet.path, sheet.xml);
    const relPath = sheet.path.replace(/([^/]+)$/, "_rels/$1.rels"); const rels = await zip.file(relPath)?.async("string") || "";
    for (const match of rels.matchAll(/<(?:\w+:)?Relationship\b[^>]*\/>/g)) if (attr(match[0], "Type").endsWith("/table")) {
      const path = resolvePath(sheet.path.slice(0, sheet.path.lastIndexOf("/")), attr(match[0], "Target")), entry = zip.file(path);
      if (entry) zip.file(path, (await entry.async("string")).replace(/(\bref=["'])([^"']+)(["'])/g, (_, start, reference, end) => start + expand(reference) + end));
    }
  }
  if (!sheets.some(sheet => sheet.changed)) return sourceBytes instanceof Uint8Array ? sourceBytes : new Uint8Array(sourceBytes);
  if (/<(?:\w+:)?calcPr\b/.test(workbook)) workbook = workbook.replace(/<(?:\w+:)?calcPr\b[^>]*\/>/, tag => tag.replace(/\s+(?:fullCalcOnLoad|forceFullCalc)=["'][^"']*["']/g, "").replace(/\/>$/, ' fullCalcOnLoad="1" forceFullCalc="1"/>'));
  else workbook = workbook.replace(/<\/(\w+:)?workbook>/, (closing, prefix = "") => `<${prefix}calcPr fullCalcOnLoad="1" forceFullCalc="1"/>${closing}`);
  zip.file("xl/workbook.xml", workbook); zip.file("xl/_rels/workbook.xml.rels", workbookRels); zip.file("[Content_Types].xml", contentTypes);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
