import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import JSZip from "jszip";
import ExcelJS from "exceljs";

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
    const candidate = fileURLToPath(new URL(specifier, context.parentURL));
    if (existsSync(candidate + ".ts")) return { url: pathToFileURL(candidate + ".ts").href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}});
const { exportExcel, parseExcel, ORDER_HEADERS } = await import("../lib/excel.ts");
const { readInCellPhotos } = await import("../lib/incell-photos.ts");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9xkAAAAASUVORK5CYII=", "base64");
const order = { id:"P-001",client:"Cliente de prueba",phone:"",batch:"",article:"Camisa",variant:"Azul",quantity:2,unitCents:50000,extraCents:2000,discountCents:500,platform:"Temu",storeCents:70000,status:"Pedido",date:"2026-10-16",deliveryDate:"",notes:"",photoKey:"f7255b44-5fea-8c86-a5ee-d1f2d78e7138",revision:1 };
const payments = [{id:"A-001",orderId:"P-001",amountCents:30000,date:"2026-10-16",method:"Efectivo",note:"",kind:"Abono"},{id:"D-001",orderId:"P-001",amountCents:2000,date:"2026-10-16",method:"Popular",note:"",kind:"Devolución"}];
const toArray = (buffer) => buffer.buffer.slice(buffer.byteOffset,buffer.byteOffset+buffer.byteLength);

test("Excel export/import conserva dinero, IDs, revisión, pagos y foto", async () => {
  const blob = await exportExcel([order],payments,[],async()=>new Blob([png],{type:"image/png"}));
  const result = await parseExcel(await blob.arrayBuffer());
  assert.deepEqual(result.errors,[]);
  assert.deepEqual(result.orders,[order]);
  assert.deepEqual(result.payments,payments);
  assert.equal(result.photos.length,1);
  assert.equal(result.photos[0].row,2);
  assert.deepEqual(Buffer.from(await result.photos[0].blob.arrayBuffer()),png);
});

test("Excel rechaza IDs faltantes, repetidos, fechas e imágenes ambiguas", async () => {
  const blob = await exportExcel([{...order,id:""},order,order],[]);
  const result = await parseExcel(await blob.arrayBuffer());
  assert.ok(result.errors.some(e=>e.includes("falta ID Pedido")));
  assert.ok(result.errors.some(e=>e.includes("duplicado")));
  const wb = new ExcelJS.Workbook();const ws=wb.addWorksheet("Pedidos");ws.addRow(ORDER_HEADERS);
  ws.addRow(["P-002","Cliente","","2026-02-30","Camisa","Temu",1,100]);
  let parsed=await parseExcel(toArray(Buffer.from(await wb.xlsx.writeBuffer())));
  assert.ok(parsed.errors.some(e=>e.includes("fecha válida")));
  ws.getCell("D2").value="2026-10-16";ws.getRow(2).height=15;
  const id=wb.addImage({buffer:png,extension:"png"});ws.addImage(id,{tl:{col:16,row:1},ext:{width:60,height:200}});
  parsed=await parseExcel(toArray(Buffer.from(await wb.xlsx.writeBuffer())));
  assert.ok(parsed.errors.some(e=>e.includes("varias filas")));
});

test("Plantilla vacía no importa fórmulas como pedidos", async () => {
  const file=readFileSync(new URL("../public/plantilla-pedidos.xlsx",import.meta.url));
  const result=await parseExcel(toArray(file));
  assert.deepEqual(result.errors,[]);assert.equal(result.orders.length,0);assert.equal(result.payments.length,0);
  assert.ok(result.warnings.some(e=>e.includes("encabezados")));
});

test("Fotos en celda siguen metadatos y relaciones hasta la fila del artículo", async () => {
  const base=await exportExcel([{...order,photoKey:""}],payments);
  const zip=await JSZip.loadAsync(await base.arrayBuffer());
  const sheet=await zip.file("xl/worksheets/sheet1.xml").async("string");
  const photo='<c r="Q2" t="e" vm="1"><v>#VALUE!</v></c>';
  zip.file("xl/worksheets/sheet1.xml",/<c r="Q2"/.test(sheet)?sheet.replace(/<c r="Q2"[^>]*>[\s\S]*?<\/c>/,photo):sheet.replace(/(<row r="2"[^>]*>[\s\S]*?)(<\/row>)/,`$1${photo}$2`));
  zip.file("xl/metadata.xml",'<metadata><metadataTypes><metadataType name="XLRICHVALUE"/></metadataTypes><futureMetadata name="XLRICHVALUE"><bk><extLst><ext><rvb i="0"/></ext></extLst></bk></futureMetadata><valueMetadata><bk><rc t="1" v="0"/></bk></valueMetadata></metadata>');
  zip.file("xl/richData/rdrichvaluestructure.xml",'<rvStructures><s t="_localImage"><k n="_rvRel:LocalImageIdentifier" t="i"/><k n="CalcOrigin" t="i"/></s></rvStructures>');
  zip.file("xl/richData/rdrichvalue.xml",'<rvData><rv s="0"><v>0</v><v>5</v></rv></rvData>');
  zip.file("xl/richData/richValueRel.xml",'<richValueRels xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><rel r:id="rId1"/></richValueRels>');
  zip.file("xl/richData/_rels/richValueRel.xml.rels",'<Relationships><Relationship Id="rId1" Target="../media/picture.png"/></Relationships>');
  zip.file("xl/media/picture.png",png);
  const bytes=await zip.generateAsync({type:"arraybuffer"});
  const photos=await readInCellPhotos(bytes,"Pedidos");
  assert.equal(photos.length,1);assert.equal(photos[0].row,2);assert.equal(photos[0].column,17);
  const parsed=await parseExcel(bytes);assert.deepEqual(parsed.errors,[]);assert.equal(parsed.photos.length,1);assert.equal(parsed.photos[0].orderId,"P-001");
});
