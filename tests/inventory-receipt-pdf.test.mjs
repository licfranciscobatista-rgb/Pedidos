import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const candidate = fileURLToPath(new URL(specifier, context.parentURL));
    if (existsSync(candidate + '.ts')) return { url: pathToFileURL(candidate + '.ts').href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
} });
const { createReceiptPdfBytes } = await import('../lib/inventory/receipt-pdf.ts');
const scratch = fileURLToPath(new URL('../../pdf-previews/', import.meta.url));
const python = process.env.PDF_TEST_PYTHON || 'python';

test('PDF de factura interna incluye datos del cliente, cobros, devolución y saldo conciliado', async () => {
  const invoice = {
    id: 'invoice-test', number: 'INT-2026-0000042', at: '2026-10-16T18:00:00.000Z',
    customer: 'María Núñez Pérez', customerPhone: '809-555-0123', customerIdNumber: '001-1234567-8',
    method: 'Efectivo', status: 'Parcialmente devuelta', shop: { name: 'Librería Valencia', rnc: '101123456', phone: '809-555-0100', address: 'Santo Domingo' },
    items: [
      { name: 'Cuaderno rayado', sku: 'LIB-001', quantity: 1000, unitCents: 4500, totalCents: 4500 },
      { name: 'Lápiz HB', sku: 'LIB-002', quantity: 1000, unitCents: 4500, totalCents: 4500 },
    ],
    totalCents: 9000, paidCents: 5000, changeCents: 0, netSalesCents: 4500,
    collectedLaterCents: 0, refundCents: 4500, cashRefundedCents: 500, balanceCents: 0,
    collections: [],
    refunds: [{ at: '2026-10-16T19:00:00.000Z', amountCents: 4500, cashRefundCents: 500, note: 'Cambio de producto' }],
  };
  const bytes = await createReceiptPdfBytes(invoice);
  assert.ok(bytes.byteLength > 1000);
  assert.equal(Buffer.from(bytes.subarray(0, 4)).toString(), '%PDF');
  mkdirSync(dirname(`${scratch}/internal-invoice.pdf`), { recursive: true });
  const path = `${scratch}/internal-invoice.pdf`;
  writeFileSync(path, bytes);
  const extracted = spawnSync(python, ['-c', "from pypdf import PdfReader; import json,sys; print(json.dumps([p.extract_text() or '' for p in PdfReader(sys.argv[1]).pages],ensure_ascii=True))", path], { encoding: 'utf8' });
  assert.equal(extracted.status, 0, extracted.stderr || 'PDF text extraction failed');
  const pdfText = JSON.parse(extracted.stdout).join('\n');
  for (const value of ['FACTURA COMERCIAL INTERNA', invoice.number, invoice.customer, invoice.customerPhone, invoice.customerIdNumber, 'Librería Valencia', 'Cuaderno rayado', 'Lápiz HB', 'Total original', 'Cobrado al emitir', 'Mercancía devuelta', 'Dinero reembolsado', 'Saldo pendiente', 'RD$ 90.00', 'RD$ 45.00', 'RD$ 5.00', 'Cambio de producto', 'no incluye NCF, e-CF ni ITBIS']) {
    assert.ok(pdfText.includes(value), `Missing PDF text: ${value}`);
  }
});

test('PDF de venta normal se identifica como comprobante interno y omite datos del cliente', async () => {
  const sale = {
    documentType: 'sale', number: 'INT-2026-0000043', at: '2026-10-17T18:00:00.000Z',
    customer: 'Consumidor final', customerPhone: '809-555-0999', customerIdNumber: '001-999',
    method: 'Efectivo', status: 'Confirmada', shop: { name: 'Librería Valencia' },
    items: [{ name: 'Lapicero', sku: 'LAP-001', quantity: 1000, unitCents: 1800, totalCents: 1800 }],
    totalCents: 1800, paidCents: 1800, changeCents: 0,
  };
  const bytes = await createReceiptPdfBytes(sale);
  const path = `${scratch}/internal-sale.pdf`;
  writeFileSync(path, bytes);
  const extracted = spawnSync(python, ['-c', "from pypdf import PdfReader; import json,sys; print(json.dumps([p.extract_text() or '' for p in PdfReader(sys.argv[1]).pages],ensure_ascii=True))", path], { encoding: 'utf8' });
  assert.equal(extracted.status, 0, extracted.stderr || 'PDF text extraction failed');
  const pdfText = JSON.parse(extracted.stdout).join('\n');
  assert.ok(pdfText.includes('COMPROBANTE INTERNO DE VENTA'));
  assert.ok(pdfText.includes(sale.number));
  assert.ok(pdfText.includes('Lapicero'));
  assert.ok(!pdfText.includes(sale.customerPhone));
  assert.ok(!pdfText.includes(sale.customerIdNumber));
  assert.ok(pdfText.includes('no incluye NCF, e-CF ni ITBIS'));
});
