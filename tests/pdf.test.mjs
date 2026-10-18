import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
    const candidate = fileURLToPath(new URL(specifier, context.parentURL));
    if (existsSync(candidate + ".ts")) return { url: pathToFileURL(candidate + ".ts").href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}});
const { createInvoicePdf } = await import("../lib/invoice-pdf.ts");
const scratch = fileURLToPath(new URL("../../pdf-previews/", import.meta.url));
mkdirSync(scratch, { recursive: true });
const python = process.env.PDF_TEST_PYTHON || "python";
const fixture = {
  id: "invoice-test", number: "FAC-2026-000042", issuedAt: "2026-10-16T18:00:00.000Z", client: "María Núñez Pérez", phone: "809 555 0123",
  businessName: "Encargos de prueba", notes: "Entrega parcial. Los artículos pendientes llegarán después. Gracias por tu pedido.",
  items: Array.from({ length: 60 }, (_, index) => ({ orderId: `P-${index + 1}`, article: `Artículo ${String(index + 1).padStart(3, "0")} - Vestido de algodón con diseño de flores y manga larga para una descripción completa del artículo`, variant: "Talla mediana - color azul oscuro", quantity: 2, unitCents: 12345, extraCents: 0, discountCents: 0, totalCents: 24690, status: "Pedido", platform: index % 2 ? "SHEIN" : "Temu", deliveryLabel: ["Llega en esta entrega", "Sigue pendiente", "Ya entregado", "Por confirmar"][index % 4] })),
  orderIds: Array.from({ length: 60 }, (_, i) => `P-${i + 1}`), pricingMode: "items", showAmounts: true,
  totalCents: 1481400, registeredTotalCents: 1481400, paidCents: 20000, balanceCents: 1461400,
};
function extract(path) {
  const result = spawnSync(python, ["-c", "import json,sys; from pypdf import PdfReader; r=PdfReader(sys.argv[1]); print(json.dumps({'pages':len(r.pages),'texts':[p.extract_text() for p in r.pages]},ensure_ascii=True))", path], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || "PDF text inspection failed");
  return JSON.parse(result.stdout);
}
async function save(invoice, name) {
  const path = `${scratch}/${name}.pdf`; mkdirSync(dirname(path), { recursive: true });
  const bytes = await createInvoicePdf(invoice);
  assert.ok(bytes.byteLength > 1000); assert.equal(Buffer.from(bytes.subarray(0, 4)).toString(), "%PDF");
  writeFileSync(path, bytes); return extract(path);
}

test("PDF multipágina conserva 60 artículos, acentos, entregas, importes y numeración", async () => {
  const pdf = await save(fixture, "invoice-preview");
  assert.ok(pdf.pages >= 4, `Expected multiple pages, got ${pdf.pages}`);
  const text = pdf.texts.join("\n");
  for (let i = 1; i <= 60; i++) assert.ok(text.includes(`Artículo ${String(i).padStart(3, "0")}`), `Missing article ${i}`);
  for (const value of [fixture.client, fixture.number, "algodón", "Llega en esta entrega", "Sigue pendiente", "Ya entregado", "Por confirmar", "RD$ 123.45", "RD$ 14,814.00", "RD$ 14,614.00", "Saldo pendiente de esta factura", fixture.notes]) assert.ok(text.includes(value), `Missing text: ${value}`);
  pdf.texts.forEach((page, index) => assert.ok(page.includes(`Página ${index + 1} de ${pdf.pages}`)));
});

test("PDF sin importes oculta precios, totales, pagos y saldos", async () => {
  const pdf = await save({ ...fixture, items: fixture.items.slice(0, 3), showAmounts: false }, "invoice-hidden");
  const text = pdf.texts.join("\n");
  assert.equal(pdf.pages, 1);
  assert.ok(text.includes(fixture.client)); assert.ok(text.includes("Llega en esta entrega"));
  assert.doesNotMatch(text, /RD\$|123\.45|246\.90|14,814\.00|14,614\.00|200\.00|Precio unitario|Total de los artículos|Pagado por cliente|Saldo pendiente|Saldo a favor/);
});

test("PDF manual muestra total elegido y saldo de factura, sin precios por artículo", async () => {
  const pdf = await save({ ...fixture, items: fixture.items.slice(0, 3), pricingMode: "manual", totalCents: 98765, paidCents: 20000, balanceCents: 78765 }, "invoice-manual");
  const text = pdf.texts.join("\n");
  assert.equal(pdf.pages, 1);
  for (const value of ["RD$ 987.65", "RD$ 200.00", "RD$ 787.65", "Monto indicado para esta factura", "Saldo pendiente de esta factura", "El monto manual de esta factura no modifica la cuenta del cliente."]) assert.ok(text.includes(value), `Missing manual text: ${value}`);
  assert.doesNotMatch(text, /123\.45|246\.90|14,814\.00|Precio unitario|Cargo:|Descuento:/);
});

test("PDF no cambia silenciosamente nombres con caracteres fuera de Helvetica", async () => {
  await assert.rejects(createInvoicePdf({ ...fixture, client: "María 🧵" }), /Usa el botón Imprimir/);
});

test("PDF conserva las fechas capturadas al emitir y no inventa fechas para documentos anteriores", async () => {
  const dated = await save({ ...fixture, items: [{ ...fixture.items[0], orderDate: "2026-10-17", deliveryDate: "2026-11-03" }] }, "invoice-dates");
  const text = dated.texts.join("\n");
  assert.ok(text.includes("Pedido: 17/10/2026"));
  assert.ok(text.includes("Entrega prevista: 03/11/2026"));
  const legacy = await save({ ...fixture, items: [fixture.items[0]] }, "invoice-legacy-dates");
  assert.doesNotMatch(legacy.texts.join("\n"), /Pedido:|Entrega prevista:/);
});
