export function buildSaleData({ form, cart, products, total, numberInput }) {
  const documentType = form.documentType === 'invoice' ? 'invoice' : 'sale';
  const invoiceCustomer = String(form.customer || '').trim();
  if (documentType === 'invoice' && !invoiceCustomer) {
    throw Error('Escribe el nombre del cliente para emitir la factura a su nombre.');
  }

  const paidCents = form.paid?.trim() ? numberInput(form.paid) : total;
  if (documentType === 'sale' && paidCents < total) {
    throw Error('La venta normal debe quedar pagada. Elige “Factura a nombre de cliente” para dejar saldo pendiente.');
  }

  return {
    documentType,
    items: structuredClone(cart),
    expectedPrices: Object.fromEntries(cart.map(item => [
      item.productId,
      products.find(product => product.id === item.productId)?.unitCents,
    ])),
    customer: documentType === 'invoice' ? invoiceCustomer : 'Consumidor final',
    customerPhone: documentType === 'invoice' ? form.customerPhone || '' : '',
    customerIdNumber: documentType === 'invoice' ? form.customerIdNumber || '' : '',
    method: form.method,
    paidCents,
  };
}
