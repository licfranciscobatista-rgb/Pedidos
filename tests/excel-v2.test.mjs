import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import ExcelJS from "exceljs";
import JSZip from "jszip";

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
    const candidate = fileURLToPath(new URL(specifier, context.parentURL));
    if (existsSync(candidate + ".ts")) return { url: pathToFileURL(candidate + ".ts").href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}});
const excel = await import("../lib/excel.ts");
const { parseExcel, exportExcel, CLIENT_HEADERS, PRICE_HEADERS, QUOTE_HEADERS, QUOTE_ITEM_HEADERS, DRAFT_HEADERS, DRAFT_ITEM_HEADERS, PAYMENT_HEADERS } = excel;
const orderHeaders = ["ID Pedido", "ID Cliente", "Fecha", "Artículo", "Unidades", "Estado", "Foto", "Notas", "Plataforma", "Variante", "Fecha de entrega", "Lote", "Revisión"];
function fixture() {
  const wb = new ExcelJS.Workbook();
  const sheet = (name, headers, rows = []) => { const ws = wb.addWorksheet(name); ws.addRows([[name], ["Ejemplo para pruebas"], [], headers, ...rows]); return ws; };
  sheet("Inicio", ["Resumen", "Valor"]);
  sheet("Clientes", CLIENT_HEADERS, [["CLI-001", "Ana Prueba", "8095550101", "ana@example.com", "Santo Domingo", "Sí", "Cliente ficticio", 0]]);
  sheet("Pedidos", orderHeaders, [["PED-001", "CLI-001", "2026-10-18", "Organizador", 2, "En camino", "", "Prueba", "Temu", "Azul", "", "Lote A", 0]]);
  sheet("Precios", PRICE_HEADERS, [["PED-001", 650, 100, 50, 800, {formula: "1+1", result: 999}, {formula:"1+1",result:999}, {formula:"1+1",result:999}]]);
  sheet("Pagos", PAYMENT_HEADERS);
  sheet("Cotizaciones", QUOTE_HEADERS, [["COT-001", "CLI-001", "2026-10-18", "2026-10-25", "Borrador", "No crea una deuda", 0, {formula:"1+1",result:999}]]);
  sheet("DetalleCotizaciones", QUOTE_ITEM_HEADERS, [["LIN-001", "COT-001", "Camisa", "M azul", "SHEIN", 2, 450, 50, 25, {formula:"1+1",result:999}]]);
  sheet("Facturas", DRAFT_HEADERS, [["BOR-001", "CLI-001", "2026-10-18", "", "Manual", "", "No", "Solo aviso de entrega", 0]]);
  sheet("DetalleFacturas", DRAFT_ITEM_HEADERS, [["BOR-001", "PED-001", "Sigue pendiente"]]);
  return wb;
}
async function parse(wb) { const bytes = Buffer.from(await wb.xlsx.writeBuffer()); return parseExcel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)); }

test("Excel V2 relaciona clientes, precios, cotizaciones y borradores en cabecera fila 4", async () => {
  const result = await parse(fixture());
  assert.deepEqual(result.errors, []);
  assert.equal(result.clients[0].id, "CLI-001");
  assert.equal(result.orders[0].client, "Ana Prueba");
  assert.equal(result.orders[0].phone, "8095550101");
  assert.equal(result.orders[0].unitCents, 65000);
  assert.equal(result.orders[0].storeCents, 80000);
  assert.equal(result.orders[0].quantity * result.orders[0].unitCents + result.orders[0].extraCents - result.orders[0].discountCents, 135000);
  assert.equal(result.quotes[0].totalCents, 92500);
  assert.equal(result.quotes[0].items[0].platform, "SHEIN");
  assert.equal(result.invoiceDrafts[0].showAmounts, false);
  assert.equal(result.invoiceDrafts[0].manualTotalCents, 0);
  assert.deepEqual(result.invoiceDrafts[0].items, [{orderId:"PED-001",deliveryLabel:"Sigue pendiente"}]);
  assert.ok(result.warnings.some(message => message.includes("nunca emite")));
});

test("Excel V2 exige precios e IDs válidos y detecta filas huérfanas en las hojas de detalle", async () => {
  const missing = fixture(); missing.getWorksheet("Precios").getCell("A5").value = "PED-999";
  const result = await parse(missing);
  assert.ok(result.errors.some(message => message.includes("Falta la fila PED-001")));
  assert.ok(result.errors.some(message => message.includes("PED-999") && message.includes("no tiene fila")));
  const orphan = fixture(); orphan.getWorksheet("DetalleCotizaciones").getCell("B5").value = "COT-999"; orphan.getWorksheet("DetalleFacturas").getCell("A5").value = "BOR-999";
  const orphanResult = await parse(orphan);
  assert.ok(orphanResult.errors.some(message => message.includes("COT-999") && message.includes("no tiene cabecera")));
  assert.ok(orphanResult.errors.some(message => message.includes("BOR-999") && message.includes("no tiene cabecera")));
  const unknown = fixture(); unknown.getWorksheet("Pedidos").getCell("B5").value = "CLI-999";
  assert.ok((await parse(unknown)).errors.some(message => message.includes("CLI-999") && message.includes("Clientes")));
});

test("Excel V2 rechaza precio contradictorio, duplicados y fórmulas en entradas", async () => {
  const contradictory = fixture(); contradictory.getWorksheet("Pedidos").getCell("N4").value = "Precio unitario"; contradictory.getWorksheet("Pedidos").getCell("N5").value = 700;
  assert.ok((await parse(contradictory)).errors.some(message => message.includes("Pedidos y Precios son distintos")));
  const duplicate = fixture(); duplicate.getWorksheet("Precios").addRow(["PED-001",650,100,50,800]);
  assert.ok((await parse(duplicate)).errors.some(message => message.includes("duplicado")));
  const formula = fixture(); formula.getWorksheet("Clientes").getCell("B5").value = {formula:'"Ana"',result:"Ana"};
  assert.ok((await parse(formula)).errors.some(message => message.includes("no se importan fórmulas")));
});

test("Excel V2 conserva colecciones y desplegables al exportar y volver a importar", async () => {
  const original = await parse(fixture());
  const blob = await exportExcel(original.orders, original.payments, original.exchanges, undefined, original);
  const result = await parseExcel(await blob.arrayBuffer());
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.clients, original.clients);
  assert.deepEqual(result.quotes, original.quotes);
  assert.deepEqual(result.invoiceDrafts, original.invoiceDrafts);
  assert.deepEqual(result.orders, original.orders);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await blob.arrayBuffer());
  assert.equal(wb.getWorksheet("Pedidos").getCell("L2").dataValidation.type, "list");
  assert.equal(wb.getWorksheet("Cotizaciones").getCell("E2").dataValidation.formulae[0], "EstadosCotizacion");
});

test("Un Excel solo con clientes no se trata como un libro vacío ni genera pedidos", async () => {
  const wb = fixture(); wb.getWorksheet("Pedidos").spliceRows(5,1); wb.getWorksheet("Precios").spliceRows(5,1); wb.getWorksheet("Cotizaciones").spliceRows(5,1); wb.getWorksheet("DetalleCotizaciones").spliceRows(5,1); wb.getWorksheet("Facturas").spliceRows(5,1); wb.getWorksheet("DetalleFacturas").spliceRows(5,1);
  const result = await parse(wb);
  assert.deepEqual(result.errors, []);
  assert.equal(result.clients.length, 1);
  assert.equal(result.orders.length, 0);
  assert.ok(!result.warnings.some(message => message.includes("solo tiene encabezados")));
});

test("Fechas ISO OOXML y relaciones absolutas de tablas se leen sin alterar el libro original", async () => {
  const wb = fixture(), clients = wb.getWorksheet("Clientes");
  clients.addTable({name:"ClientesTabla",ref:"A4",headerRow:true,columns:CLIENT_HEADERS.map(name=>({name})),rows:[clients.getRow(5).values.slice(1)]});
  const zip=await JSZip.loadAsync(await wb.xlsx.writeBuffer());
  const relation="xl/worksheets/_rels/sheet2.xml.rels";
  zip.file(relation,(await zip.file(relation).async("string")).replace(/Target="\.\.\/tables\//g,'Target="/xl/tables/'));
  const sheet="xl/worksheets/sheet3.xml";
  zip.file(sheet,(await zip.file(sheet).async("string")).replace(/<c r="C5"[^>]*>[\s\S]*?<\/c>/,'<c r="C5" t="d"><v>2026-10-18T00:00:00.000Z</v></c>'));
  const source=await zip.generateAsync({type:"arraybuffer"}), result=await parseExcel(source);
  assert.deepEqual(result.errors,[]);assert.equal(result.orders[0].date,"2026-10-18");
  assert.match(await (await JSZip.loadAsync(source)).file(relation).async("string"),/Target="\/xl\/tables/);
});

test("Dos cotizaciones pueden usar la misma ID Línea dentro de cabeceras diferentes", async () => {
  const wb=fixture();wb.getWorksheet("Cotizaciones").addRow(["COT-002","CLI-001","2026-10-18","","Borrador","",0]);
  wb.getWorksheet("DetalleCotizaciones").addRow(["LIN-001","COT-002","Pantalón","M","Temu",1,650,0,0]);
  const result=await parse(wb);assert.deepEqual(result.errors,[]);assert.equal(result.quotes.length,2);
});
