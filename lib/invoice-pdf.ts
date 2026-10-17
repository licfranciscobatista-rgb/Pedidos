import type { Invoice } from "./types";

const money = (cents: number) => `RD$ ${(cents / 100).toLocaleString("es-DO", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fontError = "Este PDF incluye caracteres que la tipografía no puede representar. Usa el botón Imprimir y elige Guardar como PDF; así podrás conservar los nombres y las notas completos.";

/** Generate a PDF exclusively from the immutable invoice snapshot. */
export async function createInvoicePdf(invoice: Invoice): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const document = await PDFDocument.create();
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const showAmounts = invoice.showAmounts !== false;
  const itemPricing = invoice.pricingMode !== "manual";
  const withItemAmounts = showAmounts && itemPricing;
  const strings = [invoice.number, invoice.client, invoice.phone, invoice.businessName, invoice.notes, ...invoice.items.flatMap(item => [item.article, item.variant, item.platform, item.deliveryLabel || "Por confirmar"])];
  try { for (const value of strings) for (const line of (value || "").split(/\r?\n/)) regular.encodeText(line); }
  catch { throw new Error(fontError); }
  document.setTitle(`Factura ${invoice.number}`);
  document.setAuthor(invoice.businessName || "mi encargo");
  document.setSubject("Comprobante de pedido y entrega");
  const issued = new Date(invoice.issuedAt);
  const issuedLabel = Number.isFinite(issued.getTime()) ? issued.toLocaleDateString("es-DO", { day: "numeric", month: "long", year: "numeric" }) : invoice.issuedAt;
  const W = 595.28, H = 841.89, margin = 42, width = W - 2 * margin, bottom = 60;
  const ink = rgb(0.16, 0.24, 0.2), muted = rgb(0.36, 0.42, 0.39), green = rgb(0.14, 0.34, 0.27), pale = rgb(0.95, 0.97, 0.95), lineColor = rgb(0.86, 0.9, 0.87);
  let page = document.addPage([W, H]);
  let y = H - margin;
  const fontFor = (isBold = false) => isBold ? bold : regular;

  function wrap(value: string, maxWidth: number, size: number, isBold = false): string[] {
    const font = fontFor(isBold), result: string[] = [];
    for (const paragraph of value.split(/\r?\n/)) {
      if (!paragraph.trim()) { result.push(""); continue; }
      let current = "";
      for (const word of paragraph.trim().split(/\s+/)) {
        if (font.widthOfTextAtSize(word, size) > maxWidth) {
          if (current) { result.push(current); current = ""; }
          let piece = "";
          for (const char of word) {
            if (piece && font.widthOfTextAtSize(piece + char, size) > maxWidth) { result.push(piece); piece = ""; }
            piece += char;
          }
          current = piece;
        } else if (current && font.widthOfTextAtSize(`${current} ${word}`, size) > maxWidth) { result.push(current); current = word; }
        else current = current ? `${current} ${word}` : word;
      }
      if (current) result.push(current);
    }
    return result.length ? result : [""];
  }
  function draw(value: string, x: number, top: number, size = 10, isBold = false, color = ink) {
    if (value) page.drawText(value, { x, y: top - size, size, font: fontFor(isBold), color });
  }
  function heading(continuation = false) {
    y = H - margin;
    for (const value of wrap(invoice.businessName || "mi encargo.", width, continuation ? 12 : 17, true)) { draw(value, margin, y, continuation ? 12 : 17, true, green); y -= continuation ? 16 : 21; }
    y -= 9;
    for (const value of wrap(`Factura de pedido ${invoice.number}${continuation ? " - continuación" : ""}`, width, 11, true)) { draw(value, margin, y, 11, true); y -= 15; }
    draw(`Emitida el ${issuedLabel}${showAmounts ? " - Importes en RD$" : ""}`, margin, y, 9, false, muted); y -= 22;
    page.drawLine({ start: { x: margin, y }, end: { x: W - margin, y }, color: lineColor, thickness: 1 }); y -= 15;
    draw("CLIENTE", margin, y, 8, true, muted); y -= 13;
    for (const value of wrap(invoice.client, width, 11, true)) { draw(value, margin, y, 11, true); y -= 15; }
    if (invoice.phone) { for (const value of wrap(invoice.phone, width, 9)) { draw(value, margin, y, 9, false, muted); y -= 13; } }
    y -= 18;
  }
  function newPage() { page = document.addPage([W, H]); heading(true); }
  function ensure(height: number) { if (y - height < bottom) newPage(); }
  const widths = withItemAmounts ? [206, 32, 109, 79, width - 426] : [300, 40, width - 340];
  const columns = widths.map((_, i) => margin + widths.slice(0, i).reduce((sum, value) => sum + value, 0));
  function tableHeader() {
    ensure(34);
    page.drawRectangle({ x: margin, y: y - 30, width, height: 30, color: green });
    const labels = withItemAmounts ? ["Artículo / variante", "Ud.", "Esta entrega", "Precio unitario", "Importe"] : ["Artículo / variante", "Ud.", "Esta entrega"];
    labels.forEach((label, index) => { draw(label, columns[index] + 7, y - 9, 8, true, rgb(1, 1, 1)); });
    y -= 30;
  }
  function paragraph(value: string, size = 9, isBold = false, color = muted, gap = 7) {
    for (const valueLine of wrap(value, width, size, isBold)) { ensure(size + 5); draw(valueLine, margin, y, size, isBold, color); y -= size + 4; }
    y -= gap;
  }

  heading();
  tableHeader();
  if (!invoice.items.length) { ensure(30); draw("No hay artículos en esta factura.", margin + 7, y - 9, 9, false, muted); y -= 32; }
  for (let index = 0; index < invoice.items.length; index++) {
    const item = invoice.items[index];
    const article = wrap(item.article, widths[0] - 14, 9, true);
    const details = wrap(`${item.platform}${item.variant ? ` - ${item.variant}` : ""}`, widths[0] - 14, 8);
    if (withItemAmounts && (item.extraCents > 0 || item.discountCents > 0)) details.push(...wrap(`Cargo: ${money(item.extraCents)} - Descuento: ${money(item.discountCents)}`, widths[0] - 14, 8));
    const delivery = wrap(item.deliveryLabel || "Por confirmar", widths[2] - 14, 8);
    const rowHeight = Math.max(38, 14 + article.length * 12 + details.length * 11, 14 + delivery.length * 11);
    if (y - rowHeight < bottom) { newPage(); tableHeader(); }
    const available = Math.floor((y - bottom - 14) / 12);
    // Extremely long imported labels may exceed a page; stream their text in
    // chunks, preserving every line instead of clipping the rest of the row.
    const allArticle = [...article.map(text => ({ text, bold: true, size: 9 })), ...details.map(text => ({ text, bold: false, size: 8 }))];
    let offset = 0, firstPart = true;
    do {
      const room = Math.max(1, firstPart ? available : Math.floor((y - bottom - 14) / 12));
      const chunk = allArticle.slice(offset, offset + room);
      const linesInPart = Math.max(chunk.length, firstPart ? delivery.length : 0, 2);
      const height = Math.max(38, 14 + linesInPart * 12);
      if (index % 2 === 0) page.drawRectangle({ x: margin, y: y - height, width, height, color: pale });
      let textY = y - 7;
      for (const segment of chunk) { draw(segment.text, margin + 7, textY, segment.size, segment.bold); textY -= 12; }
      if (firstPart) {
        draw(String(item.quantity), columns[1] + 7, y - 7, 9);
        delivery.forEach((value, i) => draw(value, columns[2] + 7, y - 7 - 11 * i, 8));
        if (withItemAmounts) {
          const unit = money(item.unitCents), total = money(item.totalCents);
          draw(unit, columns[3] + widths[3] - 7 - regular.widthOfTextAtSize(unit, 8), y - 7, 8);
          draw(total, columns[4] + widths[4] - 7 - bold.widthOfTextAtSize(total, 8), y - 7, 8, true);
        }
      }
      y -= height;
      page.drawLine({ start: { x: margin, y }, end: { x: W - margin, y }, color: lineColor, thickness: 0.5 });
      offset += chunk.length; firstPart = false;
      if (offset < allArticle.length) { newPage(); tableHeader(); }
    } while (offset < allArticle.length);
  }
  y -= 22;
  if (showAmounts) {
    const entries: [string, number, boolean][] = [
      [itemPricing ? "Total de los artículos" : "Monto indicado para esta factura", invoice.totalCents, true],
      ["Pagado por cliente al emitir", invoice.paidCents, false],
      [invoice.balanceCents < 0 ? "Saldo a favor en esta factura" : "Saldo pendiente de esta factura", Math.abs(invoice.balanceCents), true],
    ];
    ensure(95);
    for (const [label, cents, emphasized] of entries) {
      const value = money(cents);
      draw(label, margin, y, 10, emphasized);
      draw(value, W - margin - fontFor(emphasized).widthOfTextAtSize(value, 11), y, 11, emphasized, green);
      y -= 25;
    }
    y -= 10;
  }
  if (invoice.notes) { ensure(30); paragraph("Notas", 10, true, ink, 2); paragraph(invoice.notes, 9, false, ink, 14); }
  paragraph("Esta factura conserva los artículos y la información de entrega indicados al emitirla.", 8);
  if (!itemPricing) paragraph("El monto manual de esta factura no modifica la cuenta del cliente.", 8);
  paragraph("Los pagos y cambios posteriores se consultan en Mis pedidos y en Historial.", 8);
  paragraph("Comprobante de pedidos y entrega.", 8);
  const pages = document.getPages();
  pages.forEach((current, index) => {
    current.drawLine({ start: { x: margin, y: 45 }, end: { x: W - margin, y: 45 }, color: lineColor, thickness: 0.5 });
    current.drawText("Comprobante de pedidos y entrega", { x: margin, y: 29, size: 8, font: regular, color: muted });
    const label = `Página ${index + 1} de ${pages.length}`;
    current.drawText(label, { x: W - margin - regular.widthOfTextAtSize(label, 8), y: 29, size: 8, font: regular, color: muted });
  });
  try { return await document.save(); }
  catch (error) { if (error instanceof Error && /encode|WinAnsi|character|code point/i.test(error.message)) throw new Error(fontError); throw error; }
}

export async function downloadInvoicePdf(invoice: Invoice): Promise<void> {
  const bytes = await createInvoicePdf(invoice);
  const blob = new Blob([new Uint8Array(bytes)], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = `${invoice.number.replace(/[^a-zA-Z0-9_-]/g, "_") || "factura"}.pdf`;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

