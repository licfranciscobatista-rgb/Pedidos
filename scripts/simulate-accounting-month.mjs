import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { accountingSummary, applyOperation, initialState, validateState } from '../public/caja/domain.mjs';

const operation = (id, kind, data, at) => ({ id, kind, data, at, source: 'PC de prueba' });
const money = cents => `RD$ ${(cents / 100).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

let state = initialState();
state.shop.name = 'Librería Valencia · prueba aislada';
state = applyOperation(state, operation('opening-stock', 'product', {
  id: 'CUAD-01', sku: 'CUAD-01', name: 'Cuaderno rayado', unitCents: 4500,
  costCents: 3000, stock: 500_000, minStock: 10_000, active: true,
}, '2026-10-01T12:00:00.000Z'));

const openingStock = state.products[0].stock;
const daily = [];
for (let day = 1; day <= 30; day++) {
  const date = `2026-10-${String(day).padStart(2, '0')}`;
  const quantity = day === 2 ? 2000 : 1000;
  const sale = operation(`sale-${day}`, 'sale', {
    items: [{ productId: 'CUAD-01', quantity }],
    ...(day === 2 ? { paidCents: 4000 } : {}),
    customer: `Cliente ${String(day).padStart(2, '0')}`,
    method: 'Efectivo',
  }, `${date}T16:00:00.000Z`);
  state = applyOperation(state, sale);

  if (day === 3) state = applyOperation(state, operation('collection-day-3', 'collection', {
    saleId: 'sale-2', amountCents: 5000, method: 'Transferencia', note: 'Pago del saldo',
  }, `${date}T17:00:00.000Z`));

  if (day === 10) state = applyOperation(state, operation('refund-day-10', 'refund', {
    saleId: 'sale-10', items: [{ productId: 'CUAD-01', quantity: 500, restock: true }],
    method: 'Efectivo', note: 'Devolución parcial de media unidad',
  }, `${date}T18:00:00.000Z`));

  if (day === 20) state = applyOperation(state, operation('refund-day-20', 'refund', {
    saleId: 'sale-20', items: [{ productId: 'CUAD-01', quantity: 1000, restock: true }],
    method: 'Transferencia', note: 'Devolución total de la factura',
  }, `${date}T18:00:00.000Z`));

  validateState(state);
  const sold = state.sales.reduce((sum, invoice) => sum + invoice.items.reduce((units, item) => units + item.quantity, 0), 0);
  const restocked = state.refunds.flatMap(refund => refund.items).filter(item => item.restock).reduce((sum, item) => sum + item.quantity, 0);
  assert.equal(state.products[0].stock, openingStock - sold + restocked, `Stock no cuadra al cierre de ${date}`);
  daily.push({ date, summary: accountingSummary(state, date, date), stock: state.products[0].stock });
}

const summary = accountingSummary(state, '2026-10-01', '2026-10-30');
const returnedStock = state.refunds.flatMap(refund => refund.items).filter(item => item.restock).reduce((sum, item) => sum + item.quantity, 0);
assert.deepEqual({
  invoices: state.sales.length,
  gross: summary.grossSalesCents,
  refunds: summary.refundCents,
  netSales: summary.netSalesCents,
  collected: summary.cashReceivedCents,
  cashBack: summary.cashRefundedCents,
  netCash: summary.netCashCents,
  receivables: summary.receivableCents,
  netCost: summary.netCostOfGoodsCents,
  grossProfit: summary.grossProfitCents,
  endingStock: state.products[0].stock,
}, {
  invoices: 30,
  gross: 139500,
  refunds: 6750,
  netSales: 132750,
  collected: 139500,
  cashBack: 6750,
  netCash: 132750,
  receivables: 0,
  netCost: 88500,
  grossProfit: 44250,
  endingStock: openingStock - 31000 + returnedStock,
});
assert.equal(summary.netSalesCents, summary.netCashCents + summary.receivableCents);

const lines = [
  '# Simulación contable de 30 días · Librería Valencia',
  '',
  '**Resultado de prueba con datos artificiales; no contiene transacciones reales de la tienda.**',
  '',
  'Período: 1–30 de octubre de 2026. Una factura diaria; día 2 se registra un pago parcial y el día 3 se cobra el saldo. Día 10 se devuelve media unidad y día 20 se devuelve una factura completa. Las devoluciones vuelven al inventario.',
  '',
  '## Conciliación del mes',
  '',
  '| Concepto | Resultado |',
  '|---|---:|',
  `| Facturas emitidas | ${summary.saleCount} |`,
  `| Venta bruta | ${money(summary.grossSalesCents)} |`,
  `| Devoluciones | ${money(summary.refundCents)} |`,
  `| Venta neta | ${money(summary.netSalesCents)} |`,
  `| Cobros | ${money(summary.cashReceivedCents)} |`,
  `| Reembolsos en dinero | ${money(summary.cashRefundedCents)} |`,
  `| Caja neta | ${money(summary.netCashCents)} |`,
  `| Cuentas por cobrar al cierre | ${money(summary.receivableCents)} |`,
  `| Costo neto de mercancía | ${money(summary.netCostOfGoodsCents)} |`,
  `| Utilidad bruta estimada | ${money(summary.grossProfitCents)} |`,
  `| Existencia final | ${state.products[0].stock / 1000} unidades |`,
  '',
  '## Cierre diario',
  '',
  '| Día | Venta bruta | Devoluciones | Venta neta | Caja neta | Por cobrar | Existencia final |',
  '|---|---:|---:|---:|---:|---:|---:|',
  ...daily.map(row => `| ${row.date} | ${money(row.summary.grossSalesCents)} | ${money(row.summary.refundCents)} | ${money(row.summary.netSalesCents)} | ${money(row.summary.netCashCents)} | ${money(row.summary.receivableCents)} | ${(row.stock / 1000).toLocaleString('es-DO')} |`),
  '',
  'La conciliación comprobada fue: venta neta = caja neta + saldo por cobrar; existencia final = existencia inicial − cantidades vendidas + cantidades reingresadas. La utilidad bruta usa los costos unitarios guardados al emitir cada factura y resta solo el costo de artículos realmente reintegrados.',
  '',
  'Este reporte no simula ITBIS ni genera NCF/e-CF. No sustituye una conciliación bancaria, un cierre real de caja o la revisión de comprobantes fiscales.',
  '',
];
const reportPath = resolve('reports/contabilidad-simulada-30-dias.md');
mkdirSync(resolve('reports'), { recursive: true });
writeFileSync(reportPath, lines.join('\n'), 'utf8');
console.log(JSON.stringify({ report: reportPath, ...summary, endingStock: state.products[0].stock, dailyClosings: daily.length }, null, 2));
