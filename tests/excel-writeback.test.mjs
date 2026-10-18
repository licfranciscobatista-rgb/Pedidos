import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import JSZip from "jszip";
import ExcelJS from "exceljs";
registerHooks({ resolve(specifier, context, nextResolve) { if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) { const candidate = fileURLToPath(new URL(specifier, context.parentURL)); if (existsSync(candidate + ".ts")) return { url: pathToFileURL(candidate + ".ts").href, shortCircuit: true }; } return nextResolve(specifier, context); } });
const { patchWorkbook } = await import("../lib/excel-writeback.ts");
const { parseExcel, exportExcel } = await import("../lib/excel.ts");
const empty = () => ({ orders: [], payments: [], exchanges: [], clients: [], quotes: [], invoiceDrafts: [], invoices: [] });
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9xkAAAAASUVORK5CYII=", "base64");
const client = { id: "C-1", name: "Ana QA", phone: "8095551234", email: "", address: "", notes: "", active: true, revision: 2 };
const order = { id: "P-1", clientId: "C-1", client: "Ana QA", phone: "8095551234", batch: "", article: "Bolso", variant: "Azul", quantity: 2, unitCents: 65000, extraCents: 10000, discountCents: 5000, platform: "Temu", storeCents: 70000, status: "Pedido", date: "2026-10-18", deliveryDate: "", notes: "", photoKey: "", revision: 2 };
const pay = { id: "PAY-1", orderId: "P-1", amountCents: 20000, date: "2026-10-18", method: "Efectivo", note: "", kind: "Abono" };
const quote = { id: "Q-1", clientId: "C-1", date: "2026-10-18", validUntil: "2026-10-30", status: "Enviada", notes: "QA", revision: 1, totalCents: 135000, items: [{ id: "QL-1", article: "Bolso", variant: "Azul", platform: "Temu", quantity: 2, unitCents: 65000, extraCents: 10000, discountCents: 5000 }] };
const draft = { id: "D-1", clientId: "C-1", date: "2026-10-18", businessName: "", notes: "", pricingMode: "items", manualTotalCents: 0, showAmounts: false, revision: 1, items: [{ orderId: "P-1", deliveryLabel: "Sigue pendiente" }] };
const invoice = { id: "I-1", number: "F-QA-1", sourceDraftId: "D-1", clientId: "C-1", issuedAt: "2026-10-18T12:00:00Z", client: "Ana original", phone: "8095551234", businessName: "", notes: "Snapshot", orderIds: ["P-1"], items: [{ ...order, orderId: "P-1", totalCents: 135000, deliveryLabel: "Sigue pendiente", orderDate: "2026-10-18" }], totalCents: 135000, paidCents: 20000, balanceCents: 115000, pricingMode: "items", showAmounts: true, registeredTotalCents: 135000 };
const headers = {
  Clientes: ["ID Cliente", "Cliente", "Teléfono", "Correo", "Dirección", "Activo", "Notas", "Revisión"],
  Pedidos: ["ID Pedido", "ID Cliente", "Fecha", "Artículo", "Unidades", "Estado", "Foto", "Notas", "Plataforma", "Variante", "Fecha de entrega", "Lote", "Revisión"],
  Precios: ["ID Pedido", "Precio unitario", "Cargos extra", "Descuento", "Pagado a tienda", "Total a cobrar", "Pagado por cliente", "Saldo pendiente"],
  Pagos: ["ID Pago", "ID Pedido", "Tipo", "Monto", "Fecha", "Medio", "Nota"],
  Cotizaciones: ["ID Cotización", "ID Cliente", "Fecha", "Válida hasta", "Estado", "Notas", "Revisión", "Total"],
  DetalleCotizaciones: ["ID Línea", "ID Cotización", "Artículo", "Variante", "Plataforma", "Unidades", "Precio unitario", "Cargos extra", "Descuento", "Importe"],
  Facturas: ["ID Borrador", "ID Cliente", "Fecha", "Nombre del negocio", "Modo de precio", "Monto manual", "Mostrar importes", "Notas", "Revisión"],
  DetalleFacturas: ["ID Borrador", "ID Pedido", "Aviso de entrega"],
  FacturasEmitidas: ["ID Factura", "Número", "ID Cliente", "Cliente", "Teléfono", "Fecha emisión", "Nombre negocio", "Modo precio", "Mostrar importes", "Total", "Pagado", "Saldo", "Notas", "ID Borrador"],
  DetalleEmitidas: ["ID Factura", "ID Pedido", "Artículo", "Variante", "Plataforma", "Unidades", "Precio unitario", "Cargos extra", "Descuento", "Importe", "Estado pedido", "Aviso de entrega", "Fecha pedido", "Fecha entrega"],
  Cambios: ["ID Cambio", "ID Pedido", "Fecha", "Prenda anterior", "Prenda nueva", "Total anterior", "Total nuevo", "Diferencia", "Nota"],
};
async function fixture() {
  const wb = new ExcelJS.Workbook();
  for (const name of ["Inicio", ...Object.keys(headers), "Listas", "Guía", "Referencia original"]) { const ws = wb.addWorksheet(name); ws.getCell("A1").value = `QA ${name}`; if (headers[name]) { ws.getRow(4).values = headers[name]; ws.getRow(4).font = { bold: true }; } }
  const clients = wb.getWorksheet("Clientes"); clients.getRow(5).values = [client.id, "Ana antes", client.phone, "", "", "Sí", "", 1];
  const orders = wb.getWorksheet("Pedidos"); orders.getRow(5).values = [order.id, client.id, new Date("2026-10-17T00:00:00Z"), "Bolso viejo", 1, "Pendiente", "", "", "Temu", "", "", "", 1]; orders.getRow(5).height = 30;
  const imageId = wb.addImage({ buffer: png, extension: "png" }); orders.addImage(imageId, { tl: { col: 6, row: 4 }, br: { col: 6.9, row: 4.9 }, editAs: "oneCell" });
  orders.getCell("F5").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFAAFFAA" } }; orders.getCell("F5").dataValidation = { type: "list", formulae: ['"Pendiente,Pedido,En camino,Entregado"'] };
  const prices = wb.getWorksheet("Precios"); prices.addTable({ name: "TablaPreciosQA", ref: "A4", headerRow: true, columns: headers.Precios.map(name => ({ name })), rows: [[order.id, 650, 100, 50, 700, 700, 0, 700]] });
  for (const row of [5, 6]) { prices.getCell(`F${row}`).value = { formula: `IF(A${row}="","",B${row}*2+C${row}-D${row})`, result: 0 }; prices.getCell(`G${row}`).value = { formula: `SUMIF(Pagos!B:B,A${row},Pagos!D:D)`, result: 0 }; prices.getCell(`H${row}`).value = { formula: `F${row}-G${row}`, result: 0 }; prices.getCell(`B${row}`).numFmt = '#,##0.00'; }
  const qs = wb.getWorksheet("Cotizaciones"); qs.getRow(5).values = ["Q-1", "C-1", new Date("2026-10-18T00:00:00Z"), "", "Borrador", "", 0, { formula: 'SUMIF(DetalleCotizaciones!B:B,A5,DetalleCotizaciones!J:J)', result: 0 }];
  const lines = wb.getWorksheet("DetalleCotizaciones"); lines.getRow(5).values = ["OLD-LINE", "Q-1", "Obsoleto", "", "Temu", 1, 10, 0, 0, { formula: "F5*G5+H5-I5", result: 10 }];
  const bytes = await wb.xlsx.writeBuffer(); const zip = await JSZip.loadAsync(bytes);
  zip.file("customXml/do-not-touch.xml", '<private xmlns="urn:qa">preservar</private>'); zip.file("xl/richData/foreign-part.xml", '<richData xmlns="urn:qa">native-image-metadata</richData>');
  return zip.generateAsync({ type: "uint8array" });
}
const asArray = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

test("Writeback V2 conserva 15 hojas, imágenes, estilos, validación y fórmulas y actualiza por ID", async () => {
  const original = await fixture(); const before = await JSZip.loadAsync(original);
  const patch = { ...empty(), clients: [client], orders: [{ ...order, quantity: 3 }, { ...order, id: "P-2", quantity: 1, article: "Segundo" }], payments: [pay], quotes: [quote], invoiceDrafts: [draft], invoices: [invoice] };
  const bytes = await patchWorkbook(original, patch); const zip = await JSZip.loadAsync(bytes);
  for (const name of Object.keys(before.files).filter(name => /(?:xl\/media\/|xl\/drawings\/|customXml\/|xl\/richData\/)/.test(name) && !before.files[name].dir)) assert.deepEqual(await zip.file(name).async("uint8array"), await before.file(name).async("uint8array"), name);
  const loaded = new ExcelJS.Workbook(); await loaded.xlsx.load(bytes);
  assert.equal(loaded.worksheets.length, 15);
  const orders = loaded.getWorksheet("Pedidos"); assert.equal(orders.getCell("A5").value, "P-1"); assert.equal(orders.getCell("D5").value, "Bolso"); assert.equal(orders.getCell("E5").value, 3); assert.equal(orders.getCell("A6").value, "P-2");
  assert.equal(orders.getCell("F5").fill.fgColor.argb, "FFAAFFAA"); assert.equal(orders.getCell("F5").dataValidation.type, "list");
  assert.equal(loaded.getWorksheet("Precios").getCell("F6").formula, 'IF(A6="","",B6*2+C6-D6)');
  assert.equal(loaded.getWorksheet("Cotizaciones").getCell("H5").formula, 'SUMIF(DetalleCotizaciones!B:B,A5,DetalleCotizaciones!J:J)');
  assert.equal(loaded.getWorksheet("FacturasEmitidas").getCell("D5").value, "Ana original"); assert.equal(loaded.getWorksheet("FacturasEmitidas").getCell("N5").value, "D-1");
  const table = await zip.file("xl/tables/table1.xml").async("string"); assert.match(table, /ref="A4:H6"/);
  const preview = await parseExcel(asArray(bytes)); assert.deepEqual(preview.errors, []); assert.equal(preview.orders.length, 2); assert.equal(preview.orders[0].clientId, "C-1"); assert.equal(preview.clients[0].name, "Ana QA"); assert.equal(preview.quotes[0].items.length, 1); assert.equal(preview.quotes[0].items[0].id, "QL-1"); assert.equal(preview.invoiceDrafts.length, 1); assert.equal(preview.photos.length, 1);
  const repeated = await patchWorkbook(bytes, patch); const again = await JSZip.loadAsync(repeated);
  for (const name of Object.keys(zip.files).filter(name => name.endsWith(".xml"))) assert.equal(await again.file(name).async("string"), await zip.file(name).async("string"), `idempotent ${name}`);
});

test("Writeback legado permite pedidos sin ID Cliente y conserva las fórmulas calculadas", async () => {
  const legacyOrder = { ...order }; delete legacyOrder.clientId;
  const file = await exportExcel([legacyOrder], []); const original = new Uint8Array(await file.arrayBuffer());
  const bytes = await patchWorkbook(original, { ...empty(), orders: [{ ...legacyOrder, quantity: 4 }] });
  const preview = await parseExcel(asArray(bytes)); assert.deepEqual(preview.errors, []); assert.equal(preview.orders[0].quantity, 4);
});

test("Writeback V2 rechaza pedidos sin relación y un ID repetido antes de devolver un archivo", async () => {
  const original = await fixture(), unlinked = { ...order }; delete unlinked.clientId;
  await assert.rejects(patchWorkbook(original, { ...empty(), orders: [unlinked] }), /sin ID Cliente/);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(original); wb.getWorksheet("Pedidos").getRow(6).values = wb.getWorksheet("Pedidos").getRow(5).values;
  await assert.rejects(patchWorkbook(await wb.xlsx.writeBuffer(), { ...empty(), orders: [order] }), /ID duplicado/);
});

test("Sin cambios devuelve exactamente los mismos bytes", async () => {
  const original = await fixture(); assert.deepEqual(await patchWorkbook(original, empty()), original);
});

test("Las líneas con el mismo ID en cotizaciones distintas conservan su clave compuesta", async () => {
  const original = await fixture();
  const bytes = await patchWorkbook(original, { ...empty(), quotes: [quote, { ...quote, id: "Q-2", items: [{ ...quote.items[0], article: "Otro artículo" }] }] });
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(bytes); const ws = wb.getWorksheet("DetalleCotizaciones");
  const records = []; ws.eachRow((row, index) => { if (index > 4 && row.getCell(1).value) records.push([row.getCell(1).value, row.getCell(2).value, row.getCell(3).value]); });
  assert.deepEqual(records, [["QL-1", "Q-1", "Bolso"], ["QL-1", "Q-2", "Otro artículo"]]);
  await patchWorkbook(bytes, { ...empty(), quotes: [quote] });
});

test("Cambios acepta los encabezados Artículo anterior y Artículo nuevo de la plantilla ampliada", async () => {
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await fixture());
  wb.getWorksheet("Cambios").getCell("D4").value = "Artículo anterior"; wb.getWorksheet("Cambios").getCell("E4").value = "Artículo nuevo";
  const bytes = await patchWorkbook(await wb.xlsx.writeBuffer(), { ...empty(), exchanges: [{ id: "EX-1", orderId: "P-1", date: "2026-10-18", oldArticle: "Anterior", newArticle: "Nuevo", oldTotalCents: 10000, newTotalCents: 15000, differenceCents: 5000, note: "QA" }] });
  const after = new ExcelJS.Workbook(); await after.xlsx.load(bytes); assert.equal(after.getWorksheet("Cambios").getCell("D5").value, "Anterior"); assert.equal(after.getWorksheet("Cambios").getCell("E5").value, "Nuevo");
});

test("Crear el archivo de emitidas en un libro legado añade las relaciones XML válidas", async () => {
  const file = await exportExcel([order], []); const original = new Uint8Array(await file.arrayBuffer());
  const bytes = await patchWorkbook(original, { ...empty(), invoices: [invoice] });
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(bytes); assert.equal(wb.getWorksheet("FacturasEmitidas").getCell("B5").value, "F-QA-1"); assert.equal(wb.getWorksheet("DetalleEmitidas").getCell("B5").value, "P-1");
});

test("Un control inválido en XML se rechaza sin generar un libro corrupto", async () => {
  await assert.rejects(patchWorkbook(await fixture(), { ...empty(), clients: [{ ...client, notes: "Texto\u0000inválido" }] }), /carácter no válido/);
});

test("Una nueva fila no hereda la fórmula de foto ni fórmulas ajenas de otro artículo", async () => {
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await fixture());
  wb.getWorksheet("Pedidos").getCell("G5").value = { formula: 'IMAGE("https://example.invalid/foto.png")' };
  wb.getWorksheet("Pedidos").getCell("N5").value = { formula: "1+1" };
  const bytes = await patchWorkbook(await wb.xlsx.writeBuffer(), { ...empty(), orders: [{ ...order, id: "P-NEW" }] });
  const after = new ExcelJS.Workbook(); await after.xlsx.load(bytes);
  assert.equal(after.getWorksheet("Pedidos").getCell("G6").value, null);
  assert.equal(after.getWorksheet("Pedidos").getCell("N6").value, null);
  assert.equal(after.getWorksheet("Pedidos").getCell("G5").formula, 'IMAGE("https://example.invalid/foto.png")');
});

test("Ampliar más allá de 200 registros conserva el vínculo calculado al cliente y el estado del borrador", async () => {
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await fixture());
  const prices = wb.getWorksheet("Precios"), drafts = wb.getWorksheet("Facturas");
  prices.getCell("I4").value = "ID Cliente (calculado)";
  prices.getCell("I5").value = { formula: 'IF(A5="","",INDEX(Pedidos!$B$5:$B$10000,MATCH(A5,Pedidos!$A$5:$A$10000,0)))' };
  drafts.getCell("J4").value = "Estado (calculado)";
  drafts.getCell("K4").value = "Factura emitida (calculada)";
  drafts.getCell("J5").value = { formula: 'IF(A5="","",IF(COUNTIFS(FacturasEmitidas!$N$5:$N$10000,A5)>0,"Emitida","Borrador"))' };
  drafts.getCell("K5").value = { formula: 'IF(A5="","",IF(COUNTIFS(FacturasEmitidas!$N$5:$N$10000,A5)>0,INDEX(FacturasEmitidas!$B$5:$B$10000,MATCH(A5,FacturasEmitidas!$N$5:$N$10000,0)),""))' };
  for (let row = 5; row <= 204; row++) {
    wb.getWorksheet("Pedidos").getCell(`A${row}`).value = `OLD-P-${row}`;
    prices.getCell(`A${row}`).value = `OLD-P-${row}`;
    drafts.getCell(`A${row}`).value = `OLD-D-${row}`;
  }
  const bytes = await patchWorkbook(await wb.xlsx.writeBuffer(), { ...empty(), orders: [{ ...order, id: "P-NEW" }], invoiceDrafts: [{ ...draft, id: "D-NEW", items: [] }] });
  const after = new ExcelJS.Workbook(); await after.xlsx.load(bytes);
  assert.equal(after.getWorksheet("Pedidos").getCell("A205").value, "P-NEW");
  assert.equal(after.getWorksheet("Precios").getCell("I205").formula, 'IF(A205="","",INDEX(Pedidos!$B$5:$B$10000,MATCH(A205,Pedidos!$A$5:$A$10000,0)))');
  assert.equal(after.getWorksheet("Facturas").getCell("A205").value, "D-NEW");
  assert.equal(after.getWorksheet("Facturas").getCell("J205").formula, 'IF(A205="","",IF(COUNTIFS(FacturasEmitidas!$N$5:$N$10000,A205)>0,"Emitida","Borrador"))');
  assert.equal(after.getWorksheet("Facturas").getCell("K205").formula, 'IF(A205="","",IF(COUNTIFS(FacturasEmitidas!$N$5:$N$10000,A205)>0,INDEX(FacturasEmitidas!$B$5:$B$10000,MATCH(A205,FacturasEmitidas!$N$5:$N$10000,0)),""))');
});

test("Cambiar cliente, pedido y borrador conserva las dos hojas de facturas emitidas sin reescribir el snapshot", async () => {
  const initial = await patchWorkbook(await fixture(), { ...empty(), clients: [client], orders: [order], invoiceDrafts: [draft], invoices: [invoice] });
  const before = await JSZip.loadAsync(initial);
  const changed = await patchWorkbook(initial, { ...empty(), clients: [{ ...client, name: "Nombre nuevo", phone: "8095558888", revision: 3 }], orders: [{ ...order, article: "Artículo nuevo", unitCents: 99900, revision: 3 }], invoiceDrafts: [{ ...draft, notes: "Borrador actualizado", revision: 2 }] });
  const after = await JSZip.loadAsync(changed);
  const bookBefore = new ExcelJS.Workbook(); await bookBefore.xlsx.load(initial);
  const bookAfter = new ExcelJS.Workbook(); await bookAfter.xlsx.load(changed);
  for (const sheetName of ["FacturasEmitidas", "DetalleEmitidas"]) {
    const old = bookBefore.getWorksheet(sheetName), updated = bookAfter.getWorksheet(sheetName);
    assert.deepEqual(updated.getSheetValues(), old.getSheetValues(), sheetName);
    const path = `xl/worksheets/sheet${old.id}.xml`;
    assert.equal(await after.file(path).async("string"), await before.file(path).async("string"), `${sheetName} XML`);
  }
  assert.equal(bookAfter.getWorksheet("FacturasEmitidas").getCell("D5").value, "Ana original");
  assert.equal(bookAfter.getWorksheet("DetalleEmitidas").getCell("C5").value, "Bolso");
  const reparsed = await parseExcel(asArray(changed));
  assert.deepEqual(reparsed.errors, []);
  assert.equal(reparsed.orders[0].client, "Nombre nuevo");
  assert.equal(reparsed.orders[0].phone, "8095558888");
});

const nativePath = new URL("../../../outputs/excel-v2/PROGRAMA  DE PEDIDOS.xlsx", import.meta.url);
test("El libro nativo creado para OneDrive admite parche por ID sin perder sus 15 hojas", { skip: !existsSync(nativePath) }, async () => {
  const original = new Uint8Array(readFileSync(nativePath)); const before = await JSZip.loadAsync(original);
  const bytes = await patchWorkbook(original, { ...empty(), clients: [{ ...client, id: "QA-NATIVE-C1" }], orders: [{ ...order, id: "QA-NATIVE-P1", clientId: "QA-NATIVE-C1" }], invoices: [invoice] }); const after = await JSZip.loadAsync(bytes);
  const beforeBook = await before.file("xl/workbook.xml").async("string"), afterBook = await after.file("xl/workbook.xml").async("string");
  assert.equal([...beforeBook.matchAll(/<(?:\w+:)?sheet\b/g)].length, 15); assert.equal([...afterBook.matchAll(/<(?:\w+:)?sheet\b/g)].length, 15);
  for (const name of Object.keys(before.files).filter(name => /(?:media\/|drawings\/|richData\/)/.test(name) && !before.files[name].dir)) assert.deepEqual(await after.file(name).async("uint8array"), await before.file(name).async("uint8array"));
  const preview = await parseExcel(asArray(bytes)); assert.deepEqual(preview.errors, []); assert.ok(preview.orders.some(item => item.id === "QA-NATIVE-P1" && item.clientId === "QA-NATIVE-C1"));
});
