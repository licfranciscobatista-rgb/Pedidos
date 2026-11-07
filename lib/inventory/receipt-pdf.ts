import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export type ReceiptPdfData = {
  id?: string;
  number?: string;
  at: string;
  customer?: string;
  method?: string;
  status?: string;
  shop?: { name?: string; rnc?: string; phone?: string; address?: string };
  items: Array<{ name?: string; sku?: string; quantity: number; unitCents: number; totalCents: number }>;
  totalCents: number;
  paidCents: number;
  changeCents: number;
};

const money = (cents: number) => `RD$ ${(cents / 100).toFixed(2)}`;
const dateText = (value: string) => new Intl.DateTimeFormat('es-DO', {
  timeZone: 'America/Santo_Domingo', dateStyle: 'medium', timeStyle: 'short',
}).format(new Date(value));

export async function createReceiptPdfBytes(sale: ReceiptPdfData): Promise<Uint8Array> {
  if (!Array.isArray(sale.items) || sale.items.length > 500) throw new Error('El comprobante no tiene un detalle válido.');
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pageSize: [number, number] = [595.28, 841.89];
  const black = rgb(0.13, 0.20, 0.17);
  const muted = rgb(0.43, 0.48, 0.45);
  const green = rgb(0.09, 0.24, 0.21);
  const margin = 48;
  const width = pageSize[0];
  let page = pdf.addPage(pageSize);
  let y = page.getHeight() - margin;
  const draw = (text: unknown, x: number, size = 11, font = regular, color = black) => {
    page.drawText(String(text ?? ''), { x, y, size, font, color, maxWidth: width - margin * 2 });
  };
  const right = (text: string, size: number, font: typeof regular, rightEdge: number) => {
    page.drawText(text, { x: rightEdge - font.widthOfTextAtSize(text, size), y, size, font, color: black });
  };
  const divider = () => page.drawLine({ start: { x: margin, y }, end: { x: width - margin, y }, thickness: .5, color: rgb(.88, .90, .87) });
  const tableHeader = () => {
    page.drawRectangle({ x: margin, y: y - 5, width: width - margin * 2, height: 21, color: rgb(.95, .96, .94) });
    draw('ARTÍCULO', margin + 7, 8, bold, muted);
    draw('CANT.', width - 190, 8, bold, muted);
    draw('PRECIO', width - 125, 8, bold, muted);
    right('IMPORTE', 8, bold, width - margin - 7);
    y -= 22;
  };
  const newPage = () => {
    page = pdf.addPage(pageSize); y = page.getHeight() - margin;
    draw(`Comprobante ${sale.number || ''} · continuación`, margin, 10, bold, green); y -= 24;
    tableHeader();
  };

  draw(sale.shop?.name || 'Tienda', margin, 19, bold, green); y -= 22;
  if (sale.shop?.rnc) { draw(`RNC: ${sale.shop.rnc}`, margin, 9, regular, muted); y -= 14; }
  if (sale.shop?.phone) { draw(`Teléfono: ${sale.shop.phone}`, margin, 9, regular, muted); y -= 14; }
  if (sale.shop?.address) { draw(String(sale.shop.address).slice(0, 120), margin, 9, regular, muted); y -= 14; }
  y -= 17;
  page.drawLine({ start: { x: margin, y }, end: { x: width - margin, y }, thickness: 1, color: rgb(.84, .87, .83) }); y -= 29;
  draw('COMPROBANTE INTERNO DE VENTA', margin, 12, bold, green); y -= 20;
  draw(`Número: ${sale.number || '—'}`, margin, 10, bold);
  right(dateText(sale.at), 10, regular, width - margin); y -= 18;
  draw(`Cliente: ${sale.customer || 'Consumidor final'}`, margin, 10); y -= 16;
  draw(`Pago: ${sale.method || 'Efectivo'} · ${sale.status || 'Confirmada'}`, margin, 10); y -= 25;
  tableHeader();

  for (const item of sale.items) {
    if (y < margin + 75) newPage();
    draw(String(item.name || 'Artículo').slice(0, 90), margin + 7, 9, regular);
    draw(String(Number(item.quantity) / 1000), width - 190, 9, regular);
    draw(money(Number(item.unitCents) || 0), width - 125, 9, regular);
    right(money(Number(item.totalCents) || 0), 9, regular, width - margin - 7);
    y -= 18;
    draw(String(item.sku || ''), margin + 7, 8, regular, muted); y -= 13;
    divider(); y -= 10;
  }
  if (y < margin + 95) newPage();
  y -= 10;
  for (const [label, amount] of [
    ['Total', sale.totalCents], ['Recibido', sale.paidCents], ['Cambio', sale.changeCents],
  ] as const) {
    draw(label, width - 190, 10, label === 'Total' ? bold : regular);
    right(money(Number(amount) || 0), 10, label === 'Total' ? bold : regular, width - margin);
    y -= 18;
  }
  y -= 15;
  page.drawLine({ start: { x: margin, y }, end: { x: width - margin, y }, thickness: 1, color: rgb(.84, .87, .83) }); y -= 24;
  draw('Sin validez fiscal. Este documento no incluye NCF ni e-CF.', margin, 9, regular, muted);
  return pdf.save();
}
