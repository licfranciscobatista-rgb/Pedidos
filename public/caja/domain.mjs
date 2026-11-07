export const SCHEMA = 1;
const MAX_INTEGER = 100_000_000_000;

export const money = n => `RD$ ${(n / 100).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const quantity = n => (n / 1000).toLocaleString('es-DO', { maximumFractionDigits: 3 });

export function numberInput(value, scale = 100) {
  const source = String(value ?? '').trim();
  const digits = scale === 1000 ? 3 : 2;
  if (!new RegExp(`^\\d+(?:[.,]\\d{1,${digits}})?$`).test(source)) {
    throw Error('Escribe un número positivo, sin separadores de miles.');
  }
  const parsed = Math.round(Number(source.replace(',', '.')) * scale);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_INTEGER) throw Error('El valor es demasiado grande.');
  return parsed;
}

function integer(value, min = 0, max = MAX_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw Error('Cantidad o importe inválido.');
  return value;
}

function text(value, max = 160) {
  const result = String(value ?? '').trim();
  if (result.length > max) throw Error(`El texto supera ${max} caracteres.`);
  return result;
}

const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const allowedPaymentMethods = new Set(['Efectivo', 'Transferencia', 'Tarjeta', 'Otro']);
const dateKey = value => /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santo_Domingo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
const ledgerIndexes = new WeakMap();

function ledgerIndex(state) {
  let index = ledgerIndexes.get(state);
  if (index) return index;
  const salesById = new Map(state.sales.map(sale => [sale.id, sale]));
  const refundsBySale = new Map(), collectionsBySale = new Map();
  for (const refund of state.refunds || []) {
    const rows = refundsBySale.get(refund.saleId) || [];
    rows.push(refund); refundsBySale.set(refund.saleId, rows);
  }
  for (const collection of state.collections || []) {
    const rows = collectionsBySale.get(collection.saleId) || [];
    rows.push(collection); collectionsBySale.set(collection.saleId, rows);
  }
  index = { salesById, refundsBySale, collectionsBySale };
  ledgerIndexes.set(state, index);
  return index;
}

export function initialState() {
  return {
    schema: SCHEMA,
    version: 0,
    shop: { name: 'Mi tienda', rnc: '', phone: '', address: '' },
    products: [], sales: [], refunds: [], collections: [], movements: [], operations: [],
  };
}

function saleRefundRecords(state, saleId) {
  const records = ledgerIndex(state).refundsBySale.get(saleId) || [];
  // Older installations restored stock on void but did not record the money returned.
  // Treat those legacy voids as fully refunded so historic totals remain honest.
  if (!records.length) {
    const sale = ledgerIndex(state).salesById.get(saleId);
    if (sale?.status === 'Anulada') return [{ legacy: true, at: sale.voidAt || sale.at, note: sale.voidReason || 'Anulación registrada en versión anterior', method: sale.method || 'Efectivo', amountCents: sale.totalCents, cashRefundCents: sale.paidCents - sale.changeCents, items: sale.items.map(item => ({ productId: item.productId, quantity: item.quantity, amountCents: item.totalCents, restock: true })) }];
  }
  return records;
}

export function saleRefundSummary(sale, state) {
  const refunds = saleRefundRecords(state, sale.id);
  const refundedByProduct = new Map();
  let amountCents = 0, cashRefundCents = 0;
  for (const refund of refunds) {
    amountCents += refund.amountCents;
    cashRefundCents += refund.cashRefundCents || 0;
    for (const item of refund.items) refundedByProduct.set(item.productId, (refundedByProduct.get(item.productId) || 0) + item.quantity);
  }
  const returnedAll = sale.items.every(item => (refundedByProduct.get(item.productId) || 0) >= item.quantity);
  return { refunds, refundedByProduct, amountCents, cashRefundCents, returnedAll, refundableCents: sale.totalCents - amountCents };
}

export function saleAccounting(sale, state) {
  const refund = saleRefundSummary(sale, state);
  const collections = ledgerIndex(state).collectionsBySale.get(sale.id) || [];
  const receivedInitially = sale.paidCents - sale.changeCents;
  const collectedLaterCents = collections.reduce((sum, item) => sum + item.amountCents, 0);
  const netRevenueCents = sale.totalCents - refund.amountCents;
  const netCashReceivedCents = receivedInitially + collectedLaterCents - refund.cashRefundCents;
  const balanceCents = netRevenueCents - netCashReceivedCents;
  const status = refund.returnedAll ? 'Devuelta' : refund.amountCents ? 'Parcialmente devuelta' : balanceCents > 0 ? 'Pendiente de pago' : 'Pagada';
  return { ...refund, receivedInitiallyCents: receivedInitially, collectedLaterCents, netRevenueCents, netCashReceivedCents, balanceCents, status };
}

export function accountingSummary(state, from = '', to = '') {
  const within = value => {
    const key = dateKey(value);
    return (!from || key >= from) && (!to || key <= to);
  };
  const salesInRange = state.sales.filter(sale => within(sale.at));
  const issuedByEnd = state.sales.filter(sale => !to || dateKey(sale.at) <= to);
  let grossSalesCents = 0, refundCents = 0, cashReceivedCents = 0, cashRefundedCents = 0, receivableCents = 0;
  let costOfGoodsCents = 0, returnedStockCostCents = 0;
  for (const sale of salesInRange) {
    grossSalesCents += sale.totalCents;
    cashReceivedCents += sale.paidCents - sale.changeCents;
    for (const item of sale.items) costOfGoodsCents += item.costTotalCents ?? Math.round((item.costCents || 0) * item.quantity / 1000);
  }
  for (const collection of state.collections || []) if (within(collection.at)) cashReceivedCents += collection.amountCents;
  for (const refund of state.refunds || []) if (within(refund.at)) {
    refundCents += refund.amountCents;
    cashRefundedCents += refund.cashRefundCents;
    for (const item of refund.items) if (item.restock) returnedStockCostCents += item.costRestoredCents || 0;
  }
  // Legacy annulments have no refund ledger; their reversal is dated on the original receipt.
  const refundSaleIds = new Set((state.refunds || []).map(refund => refund.saleId));
  for (const sale of state.sales) if (sale.status === 'Anulada' && !refundSaleIds.has(sale.id) && within(sale.voidAt || sale.at)) {
    refundCents += sale.totalCents;
    cashRefundedCents += sale.paidCents - sale.changeCents;
    returnedStockCostCents += sale.items.reduce((sum, item) => sum + (item.costTotalCents ?? Math.round((item.costCents || 0) * item.quantity / 1000)), 0);
  }
  for (const sale of issuedByEnd) receivableCents += Math.max(0, saleAccounting(sale, state).balanceCents);
  // Receivables are an ending balance, whereas sales/refunds/collections are period flows.
  // Transactions after the requested end date are excluded from that balance.
  if (to) {
    const asOf = { ...state, sales: issuedByEnd.map(sale => sale.voidAt && dateKey(sale.voidAt) > to ? { ...sale, status: 'Confirmada' } : sale), refunds: (state.refunds || []).filter(refund => dateKey(refund.at) <= to), collections: (state.collections || []).filter(payment => dateKey(payment.at) <= to) };
    receivableCents = issuedByEnd.reduce((sum, sale) => sum + Math.max(0, saleAccounting(sale, asOf).balanceCents), 0);
  }
  const netSalesCents = grossSalesCents - refundCents;
  const netCashCents = cashReceivedCents - cashRefundedCents;
  const netCostOfGoodsCents = costOfGoodsCents - returnedStockCostCents;
  return {
    saleCount: salesInRange.length,
    grossSalesCents, refundCents, netSalesCents,
    cashReceivedCents, cashRefundedCents, netCashCents,
    receivableCents, costOfGoodsCents, returnedStockCostCents, netCostOfGoodsCents,
    grossProfitCents: netSalesCents - netCostOfGoodsCents,
  };
}

export function validateState(state) {
  if (!state || state.schema !== SCHEMA) throw Error('Formato de inventario no compatible.');
  integer(state.version);
  if (!state.shop || !Array.isArray(state.products) || !Array.isArray(state.sales) || !Array.isArray(state.movements) || !Array.isArray(state.operations)) throw Error('Inventario incompleto.');
  if (state.products.length > 50_000) throw Error('El catálogo supera el límite de esta versión.');
  const products = new Map(), skus = new Set();
  for (const product of state.products) {
    const sku = String(product.sku || '').toLocaleLowerCase('es');
    if (!product.id || products.has(product.id) || !sku || skus.has(sku)) throw Error('Códigos de artículos duplicados.');
    if (!product.name) throw Error('Artículo sin nombre.');
    integer(product.stock); integer(product.minStock); integer(product.unitCents); integer(product.costCents);
    if (typeof product.active !== 'boolean') throw Error('Estado de artículo inválido.');
    products.set(product.id, product); skus.add(sku);
  }

  const saleIds = new Set(), saleNumbers = new Set(), salesById = new Map();
  for (const sale of state.sales) {
    if (!sale.id || saleIds.has(sale.id) || !Array.isArray(sale.items) || !sale.items.length || sale.items.length > 500) throw Error('Venta inválida.');
    if (!sale.number || saleNumbers.has(sale.number) || !validDate(sale.at)) throw Error('Número o fecha de venta inválidos.');
    if (!['Confirmada', 'Anulada'].includes(sale.status)) throw Error('Estado de venta inválido.');
    if (!sale.shop || typeof sale.shop !== 'object') throw Error('La factura no conserva los datos de la tienda.');
    integer(sale.totalCents); integer(sale.paidCents); integer(sale.changeCents);
    if (sale.changeCents !== Math.max(0, sale.paidCents - sale.totalCents)) throw Error('El cambio no coincide con el dinero recibido.');
    if (sale.paidCents < sale.changeCents) throw Error('Importe recibido inválido.');
    const seenItems = new Set(); let total = 0;
    for (const item of sale.items) {
      if (!item.productId || seenItems.has(item.productId) || !products.has(item.productId)) throw Error('La factura contiene artículos duplicados o inexistentes.');
      seenItems.add(item.productId); integer(item.quantity, 1); integer(item.unitCents); integer(item.totalCents);
      if (item.totalCents !== Math.round(item.unitCents * item.quantity / 1000)) throw Error('El importe de una línea de factura no coincide con cantidad y precio.');
      if (item.costCents !== undefined) integer(item.costCents);
      if (item.costTotalCents !== undefined) integer(item.costTotalCents);
      total = integer(total + item.totalCents);
    }
    if (total !== sale.totalCents) throw Error('El total de la factura no coincide con sus líneas.');
    saleIds.add(sale.id); saleNumbers.add(sale.number); salesById.set(sale.id, sale);
  }

  const operations = new Set();
  for (const id of state.operations) {
    if (typeof id !== 'string' || !id || operations.has(id)) throw Error('Historial de operaciones inválido.');
    operations.add(id);
  }

  const collections = state.collections || [], refunds = state.refunds || [];
  if (!Array.isArray(collections) || !Array.isArray(refunds)) throw Error('Registro de cobros o devoluciones inválido.');
  const eventIds = new Set(), collectionIds = new Set(), refundIds = new Set();
  const collectedBySale = new Map(), refundedQty = new Map(), refundedBySale = new Map(), refundedCashBySale = new Map(), refundsBySale = new Map();
  const operationOrder = new Map(state.operations.map((id, index) => [id, index]));
  const events = [
    ...collections.map(event => ({ ...event, eventKind: 'collection' })),
    ...refunds.map(event => ({ ...event, eventKind: 'refund' })),
  ].sort((a, b) => {
    const orderA = operationOrder.get(a.id) ?? -1, orderB = operationOrder.get(b.id) ?? -1;
    return orderA >= 0 && orderB >= 0 ? orderA - orderB : a.at.localeCompare(b.at) || a.id.localeCompare(b.id);
  });
  for (const event of events) {
    if (!event.id || eventIds.has(event.id) || !saleIds.has(event.saleId) || !validDate(event.at)) throw Error(event.eventKind === 'collection' ? 'Cobro inválido.' : 'Devolución inválida.');
    eventIds.add(event.id);
    const sale = salesById.get(event.saleId);
    if (event.eventKind === 'collection') {
      integer(event.amountCents, 1); if (!allowedPaymentMethods.has(event.method)) throw Error('Forma de pago inválida.');
      const previousRefund = refundedBySale.get(sale.id) || 0;
      const previousCashRefund = refundedCashBySale.get(sale.id) || 0;
      const receivedBefore = sale.paidCents - sale.changeCents + (collectedBySale.get(sale.id) || 0);
      const balanceBefore = sale.totalCents - previousRefund - receivedBefore + previousCashRefund;
      if (event.amountCents > balanceBefore) throw Error('Los cobros exceden el saldo pendiente de la factura.');
      collectionIds.add(event.id);
      collectedBySale.set(sale.id, (collectedBySale.get(sale.id) || 0) + event.amountCents);
      continue;
    }
    if (!Array.isArray(event.items) || !event.items.length || event.items.length > 500) throw Error('Devolución inválida.');
    if (!allowedPaymentMethods.has(event.method) || !String(event.note || '').trim()) throw Error('Falta la forma o el motivo de la devolución.');
    integer(event.amountCents); integer(event.cashRefundCents);
    let amount = 0; const seen = new Set();
    for (const line of event.items) {
      const original = sale.items.find(item => item.productId === line.productId);
      if (!original || seen.has(line.productId)) throw Error('La devolución contiene artículos que no aparecen en la factura.');
      seen.add(line.productId); integer(line.quantity, 1); integer(line.amountCents); integer(line.costRestoredCents || 0);
      if (typeof line.restock !== 'boolean') throw Error('Decisión de reintegro de existencias inválida.');
      const key = `${sale.id}:${line.productId}`, previous = refundedQty.get(key) || 0;
      if (previous + line.quantity > original.quantity) throw Error('Se devolvió más cantidad de la facturada.');
      const expectedValue = Math.round(original.totalCents * (previous + line.quantity) / original.quantity) - Math.round(original.totalCents * previous / original.quantity);
      if (line.amountCents !== expectedValue) throw Error('El importe devuelto no coincide con la cantidad facturada.');
      const expectedCost = line.restock ? Math.round((original.costTotalCents ?? Math.round((original.costCents || 0) * original.quantity / 1000)) * (previous + line.quantity) / original.quantity) - Math.round((original.costTotalCents ?? Math.round((original.costCents || 0) * original.quantity / 1000)) * previous / original.quantity) : 0;
      if (line.costRestoredCents !== expectedCost) throw Error('El costo de la mercancía devuelta no coincide.');
      refundedQty.set(key, previous + line.quantity); amount = integer(amount + line.amountCents);
    }
    if (amount !== event.amountCents) throw Error('El total devuelto no coincide con sus artículos.');
    const previousRefund = refundedBySale.get(sale.id) || 0;
    if (previousRefund + amount > sale.totalCents) throw Error('La devolución excede el total facturado.');
    const previousCollected = sale.paidCents - sale.changeCents + (collectedBySale.get(sale.id) || 0);
    const previousCashRefund = refundedCashBySale.get(sale.id) || 0;
    const balanceBefore = sale.totalCents - previousRefund - previousCollected + previousCashRefund;
    const expectedCash = Math.max(0, amount - balanceBefore);
    if (event.cashRefundCents !== expectedCash) throw Error('El dinero reembolsado no coincide con el saldo y los cobros registrados.');
    refundedBySale.set(sale.id, previousRefund + amount);
    refundedCashBySale.set(sale.id, previousCashRefund + event.cashRefundCents);
    refundIds.add(event.id);
    const saleRefunds = refundsBySale.get(sale.id) || [];
    saleRefunds.push(event); refundsBySale.set(sale.id, saleRefunds);
  }
  for (const sale of state.sales) {
    const collected = sale.paidCents - sale.changeCents + (collectedBySale.get(sale.id) || 0);
    if (collected > sale.totalCents + (refundedBySale.get(sale.id) || 0)) throw Error('Los cobros exceden el monto permitido de la factura.');
    if (sale.status === 'Anulada' && !refundsBySale.has(sale.id) && !saleRefundRecords(state, sale.id)[0]?.legacy) throw Error('Una factura anulada debe conservar la devolución de dinero y mercancía.');
    if (sale.status === 'Anulada' && refundsBySale.has(sale.id) && (refundedBySale.get(sale.id) !== sale.totalCents || sale.items.some(item => (refundedQty.get(`${sale.id}:${item.productId}`) || 0) !== item.quantity))) throw Error('La anulación debe devolver el importe y las cantidades completas de la factura.');
  }

  const movementsByProduct = new Map(), latestStock = new Map(), movementsBySale = new Map(), movementIds = new Set();
  for (const movement of state.movements) {
    if (!movement.id || movementIds.has(movement.id) || !products.has(movement.productId) || !validDate(movement.at)) throw Error('Movimiento de inventario inválido.');
    integer(movement.delta, -MAX_INTEGER, MAX_INTEGER); integer(movement.stockAfter);
    if (!movement.delta || movement.stockAfter !== (latestStock.get(movement.productId) || 0) + movement.delta) throw Error('El historial de existencias no se puede conciliar.');
    latestStock.set(movement.productId, movement.stockAfter);
    movementsByProduct.set(movement.productId, (movementsByProduct.get(movement.productId) || 0) + movement.delta);
    movementIds.add(movement.id);
    if (movement.saleId) {
      if (!saleIds.has(movement.saleId)) throw Error('El movimiento referencia una factura inexistente.');
      const rows = movementsBySale.get(movement.saleId) || [];
      rows.push(movement); movementsBySale.set(movement.saleId, rows);
    }
  }
  for (const product of state.products) {
    if ((movementsByProduct.get(product.id) || 0) !== product.stock) throw Error('La existencia no coincide con sus movimientos registrados.');
  }
  for (const sale of state.sales) {
    const movements = movementsBySale.get(sale.id) || [];
    const saleRefunds = refundsBySale.get(sale.id) || [];
    const restockedByProduct = new Map();
    for (const refund of saleRefunds) for (const line of refund.items) if (line.restock) restockedByProduct.set(line.productId, (restockedByProduct.get(line.productId) || 0) + line.quantity);
    for (const item of sale.items) {
      const sold = movements.filter(movement => movement.kind === 'Venta' && movement.productId === item.productId).reduce((sum, movement) => sum - movement.delta, 0);
      if (sold !== item.quantity) throw Error('La cantidad facturada no coincide con la salida del inventario.');
      let returned = restockedByProduct.get(item.productId) || 0;
      if (sale.status === 'Anulada' && !saleRefunds.length) {
        returned = movements.filter(movement => movement.kind === 'Anulación' && movement.productId === item.productId).reduce((sum, movement) => sum + movement.delta, 0);
        if (returned !== item.quantity) throw Error('La anulación histórica no coincide con la devolución de existencias.');
      } else {
        const restocked = movements.filter(movement => movement.kind === 'Devolución' && movement.productId === item.productId).reduce((sum, movement) => sum + movement.delta, 0);
        if (restocked !== returned) throw Error('La devolución de mercancía no coincide con el historial de existencias.');
      }
    }
  }
  return state;
}

export function applyOperation(current, operation) {
  validateState(current);
  if (!operation || typeof operation.id !== 'string' || !operation.id || !validDate(operation.at)) throw Error('Operación sin identificador o fecha válida.');
  if (current.operations.includes(operation.id)) return current;

  const next = structuredClone(current);
  next.refunds ||= [];
  next.collections ||= [];
  const data = operation.data ?? {};
  const move = (product, delta, kind, note = '', saleId = '') => {
    integer(product.stock + delta);
    product.stock += delta;
    next.movements.push({ id: `${operation.id}:${product.id}`, productId: product.id, sku: product.sku, name: product.name, at: operation.at, delta, stockAfter: product.stock, kind, note: text(note, 1000), saleId });
  };

  const recordRefund = (sale, rows, note, method, source) => {
    const previous = saleRefundSummary(sale, next);
    const requested = new Map();
    for (const row of rows) {
      if (!row || typeof row.productId !== 'string' || requested.has(row.productId)) throw Error('La devolución contiene un artículo repetido o inválido.');
      const original = sale.items.find(item => item.productId === row.productId);
      if (!original) throw Error('El artículo no aparece en esta factura.');
      const quantityReturned = integer(row.quantity, 1);
      const previouslyReturned = previous.refundedByProduct.get(row.productId) || 0;
      if (quantityReturned > original.quantity - previouslyReturned) throw Error(`La cantidad supera lo que queda por devolver de ${original.name}.`);
      if (typeof row.restock !== 'boolean') throw Error('Indica si la mercancía devuelta vuelve a las existencias.');
      const amountCents = Math.round(original.totalCents * (previouslyReturned + quantityReturned) / original.quantity) - Math.round(original.totalCents * previouslyReturned / original.quantity);
      const originalCost = original.costTotalCents ?? Math.round((original.costCents || 0) * original.quantity / 1000);
      const costRestoredCents = row.restock ? Math.round(originalCost * (previouslyReturned + quantityReturned) / original.quantity) - Math.round(originalCost * previouslyReturned / original.quantity) : 0;
      requested.set(row.productId, { productId: row.productId, name: original.name, quantity: quantityReturned, amountCents, restock: row.restock, costRestoredCents });
    }
    if (!requested.size) throw Error('Selecciona al menos un artículo y una cantidad para devolver.');
    const items = [...requested.values()];
    const amountCents = integer(items.reduce((sum, item) => sum + item.amountCents, 0));
    const financials = saleAccounting(sale, next);
    const cashRefundCents = Math.max(0, amountCents - financials.balanceCents);
    const methodName = text(method || 'Efectivo', 40);
    if (!allowedPaymentMethods.has(methodName)) throw Error('Selecciona una forma de devolución válida.');
    const reason = text(note, 1000);
    if (!reason) throw Error('Indica el motivo de la devolución.');
    for (const item of items) {
      if (item.restock) move(next.products.find(product => product.id === item.productId), item.quantity, 'Devolución', `${sale.number} · ${reason}`, sale.id);
    }
    next.refunds.push({ id: operation.id, saleId: sale.id, at: operation.at, amountCents, cashRefundCents, method: methodName, note: reason, source: text(source || operation.source || 'PC', 40), items });
    ledgerIndexes.delete(next);
    return next.refunds.at(-1);
  };

  if (operation.kind === 'product') {
    const name = text(data.name), sku = text(data.sku, 80);
    if (!name || !sku) throw Error('Nombre y código son obligatorios.');
    const id = text(data.id || operation.id, 80), existing = next.products.find(product => product.id === id);
    if (next.products.some(product => product.id !== id && product.sku.toLowerCase() === sku.toLowerCase())) throw Error('Ya existe un artículo con ese código.');
    const fields = { id, sku, name, barcode: text(data.barcode, 80), category: text(data.category, 80), unitCents: integer(data.unitCents), costCents: integer(data.costCents ?? 0), minStock: integer(data.minStock ?? 0), active: data.active !== false };
    if (existing) Object.assign(existing, fields);
    else {
      const product = { ...fields, stock: 0 };
      next.products.push(product);
      const stock = integer(data.stock ?? 0);
      if (stock) move(product, stock, 'Inventario inicial');
    }
  } else if (operation.kind === 'movement') {
    const product = next.products.find(item => item.id === data.productId);
    if (!product) throw Error('El artículo no existe.');
    const amount = integer(data.quantity, 1), note = text(data.note, 1000);
    if (!['Entrada', 'Salida / ajuste'].includes(data.type)) throw Error('Movimiento inválido.');
    if (!note) throw Error('Indica el motivo o la referencia del movimiento.');
    if (data.type === 'Salida / ajuste' && amount > product.stock) throw Error('La salida supera la existencia disponible.');
    move(product, data.type === 'Entrada' ? amount : -amount, data.type, note);
  } else if (operation.kind === 'sale') {
    if (!Array.isArray(data.items) || !data.items.length || data.items.length > 500) throw Error('Agrega artículos a la venta.');
    const grouped = new Map();
    for (const row of data.items) grouped.set(row.productId, integer((grouped.get(row.productId) || 0) + integer(row.quantity, 1)));
    const items = []; let total = 0;
    for (const [id, amount] of grouped) {
      const product = next.products.find(item => item.id === id && item.active);
      if (!product) throw Error('Un artículo ya no está disponible.');
      if (amount > product.stock) throw Error(`Existencia insuficiente: ${product.name}. Disponible: ${quantity(product.stock)}.`);
      if (data.expectedPrices && data.expectedPrices[id] !== product.unitCents) throw Error(`Cambió el precio de ${product.name}. Actualiza la venta.`);
      const cents = integer(Math.round(product.unitCents * amount / 1000));
      const costCents = product.costCents;
      const costTotalCents = integer(Math.round(costCents * amount / 1000));
      total = integer(total + cents);
      items.push({ productId: id, sku: product.sku, name: product.name, quantity: amount, unitCents: product.unitCents, totalCents: cents, costCents, costTotalCents });
    }
    const paid = integer(data.paidCents ?? total);
    if (paid > MAX_INTEGER) throw Error('El importe recibido es demasiado grande.');
    const customer = text(data.customer || 'Consumidor final');
    const method = text(data.method || 'Efectivo', 40);
    if (!allowedPaymentMethods.has(method)) throw Error('Selecciona una forma de pago válida.');
    const sale = {
      id: operation.id,
      number: `INT-${operation.at.slice(0, 4)}-${String(next.sales.length + 1).padStart(7, '0')}`,
      at: operation.at,
      customer,
      customerPhone: text(data.customerPhone, 40),
      customerIdNumber: text(data.customerIdNumber, 40),
      method,
      items,
      totalCents: total,
      paidCents: paid,
      changeCents: Math.max(0, paid - total),
      status: 'Confirmada',
      source: text(operation.source || 'PC', 40),
      shop: structuredClone(next.shop),
      note: text(data.note, 1000),
    };
    for (const item of items) move(next.products.find(product => product.id === item.productId), -item.quantity, 'Venta', sale.number, sale.id);
    next.sales.push(sale);
  } else if (operation.kind === 'collection') {
    const sale = next.sales.find(item => item.id === data.saleId && item.status === 'Confirmada');
    if (!sale) throw Error('La factura no existe o ya está devuelta.');
    const amountCents = integer(data.amountCents, 1);
    const financials = saleAccounting(sale, next);
    if (amountCents > financials.balanceCents) throw Error(`El cobro supera el saldo pendiente de ${money(financials.balanceCents)}.`);
    const method = text(data.method || 'Efectivo', 40);
    if (!allowedPaymentMethods.has(method)) throw Error('Selecciona una forma de pago válida.');
    const note = text(data.note, 500);
    next.collections.push({ id: operation.id, saleId: sale.id, at: operation.at, amountCents, method, note, source: text(operation.source || 'PC', 40) });
    ledgerIndexes.delete(next);
  } else if (operation.kind === 'refund') {
    const sale = next.sales.find(item => item.id === data.saleId && item.status === 'Confirmada');
    if (!sale) throw Error('La factura no existe o ya está anulada.');
    recordRefund(sale, data.items, data.note, data.method, operation.source);
  } else if (operation.kind === 'void') {
    const sale = next.sales.find(item => item.id === data.saleId && item.status === 'Confirmada');
    if (!sale) throw Error('La factura no existe o ya fue anulada.');
    const note = text(data.note, 1000);
    if (!note) throw Error('Indica por qué se anula la factura.');
    const rows = sale.items.map(item => ({ productId: item.productId, quantity: item.quantity - (saleRefundSummary(sale, next).refundedByProduct.get(item.productId) || 0), restock: true })).filter(item => item.quantity > 0);
    if (!rows.length) throw Error('La factura ya fue devuelta completamente.');
    recordRefund(sale, rows, note, data.method || 'Efectivo', operation.source);
    sale.status = 'Anulada'; sale.voidAt = operation.at; sale.voidReason = note;
  } else if (operation.kind === 'settings') {
    next.shop = { name: text(data.name), rnc: text(data.rnc, 40), phone: text(data.phone, 40), address: text(data.address, 300) };
    if (!next.shop.name) throw Error('Escribe el nombre de la tienda.');
  } else if (operation.kind === 'import') {
    if (!Array.isArray(data.products) || !data.products.length || data.products.length > 10_000) throw Error('El archivo no contiene artículos válidos.');
    const importCodes = new Set();
    for (const product of data.products) {
      const code = String(product.sku || '').toLowerCase();
      if (importCodes.has(code) || next.products.some(item => item.sku.toLowerCase() === code)) throw Error('La importación contiene códigos duplicados o ya registrados.');
      importCodes.add(code);
    }
    let interim = next;
    for (let i = 0; i < data.products.length; i++) interim = applyOperation(interim, { id: `${operation.id}-${i}`, kind: 'product', at: operation.at, data: data.products[i] });
    interim.version = current.version;
    Object.assign(next, interim);
  } else throw Error('Operación no compatible.');

  next.version++;
  next.operations.push(operation.id);
  return validateState(next);
}
