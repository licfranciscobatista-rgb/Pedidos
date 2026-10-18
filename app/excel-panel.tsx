"use client";

import { useEffect, useRef, useState } from "react";
import { Download, FileSpreadsheet, Upload, Check, AlertCircle, X } from "lucide-react";
import { exportExcel, parseExcel, type ExcelPreview, type ExcelBusinessData } from "@/lib/excel";
import { orderTotal, type Exchange, type Order, type Payment } from "@/lib/types";
import OneDrivePanel, { type OneDriveNotice } from "./onedrive-panel";

const currency = (cents: number) => `RD$ ${(cents / 100).toLocaleString("es-DO", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function PhotoPreview({ blob, article }: { blob: Blob; article: string }) {
  const image = useRef<HTMLImageElement>(null);
  useEffect(() => { const url = URL.createObjectURL(blob); if (image.current) image.current.src = url; return () => URL.revokeObjectURL(url); }, [blob]);
  // Local object URLs are managed and released here; they cannot use an image optimizer.
  // eslint-disable-next-line @next/next/no-img-element
  return <img ref={image} alt={`Foto de ${article}`} width={56} height={56} style={{ width: 56, height: 56, objectFit: "cover", borderRadius: 8 }} />;
}

export default function ExcelPanel({ orders, onImported, onSynced, onSyncStatus }: { orders: Order[]; payments: Payment[]; exchanges?: Exchange[]; onImported: () => void; onSynced?: () => void; onSyncStatus?: (notice: OneDriveNotice) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<ExcelPreview | null>(null);
  const [busy, setBusy] = useState("");
  const [syncBusy, setSyncBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const existing = new Set(orders.map(order => order.id));
  const updates = preview?.orders.filter(order => existing.has(order.id)).length || 0;
  const unknownReferences = preview ? [
    ...[...preview.payments, ...preview.exchanges].filter(record => !existing.has(record.orderId) && !preview.orders.some(order => order.id === record.orderId)).map(record => `El registro ${record.id} apunta al pedido ${record.orderId}, que no existe en la app ni en este archivo.`),
    ...preview.invoiceDrafts.flatMap(draft => draft.items.filter(item => !existing.has(item.orderId) && !preview.orders.some(order => order.id === item.orderId)).map(item => `El borrador ${draft.id} apunta al pedido ${item.orderId}, que no existe en la app ni en este archivo.`)),
  ] : [];
  const previewErrors = [...(preview?.errors || []), ...unknownReferences];
  const canImport = preview && !previewErrors.length && (preview.orders.length || preview.payments.length || preview.exchanges.length || preview.clients.length || preview.quotes.length || preview.invoiceDrafts.length);

  async function choose(file?: File) {
    if (!file || syncBusy || busy) return;
    setError(""); setSuccess(""); setPreview(null);
    if (!/\.xlsx$/i.test(file.name)) { setError("Selecciona un archivo Excel .xlsx."); return; }
    if (file.size > 5 * 1024 * 1024) { setError("El archivo debe pesar 5 MB o menos."); return; }
    setBusy("Leyendo el Excel y sus fotos…");
    try { setPreview(await parseExcel(await file.arrayBuffer(), file.name)); }
    catch (err) { setError(err instanceof Error ? err.message : "No pude leer este archivo. Comprueba que sea un Excel .xlsx válido."); }
    finally { setBusy(""); if (input.current) input.current.value = ""; }
  }

  async function confirmImport() {
    if (!preview || !canImport || busy || syncBusy) return;
    setError(""); setSuccess("");
    try {
      const nextOrders = preview.orders.map(order => ({ ...order }));
      for (let i = 0; i < preview.photos.length; i++) {
        const photo = preview.photos[i]; setBusy(`Guardando foto ${i + 1} de ${preview.photos.length}…`);
        const form = new FormData(); form.append("file", photo.blob, photo.name);
        const response = await fetch("/api/photos", { method: "POST", body: form });
        const result = await response.json() as { error?: string; photoKey?: string };
        if (!response.ok || !result.photoKey) throw new Error(result.error || `No pude guardar la foto del pedido ${photo.orderId}. Ningún pedido de este archivo se ha importado.`);
        const order = nextOrders.find(item => item.id === photo.orderId); if (order) order.photoKey = result.photoKey;
      }
      setBusy("Guardando clientes, pedidos, pagos y documentos…");
      const response = await fetch("/api/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orders: nextOrders, payments: preview.payments, exchanges: preview.exchanges, clients: preview.clients, quotes: preview.quotes, invoiceDrafts: preview.invoiceDrafts }) });
      const result = await response.json() as { error?: string; changes?: Record<string, number> };
      if (!response.ok) throw new Error(result.error || (response.status === 409 ? "Estos datos cambiaron desde la última exportación. Descarga el Excel actualizado y aplica tus cambios sobre ese archivo." : "No pude importar el archivo. Los datos no se guardaron."));
      const changes = result.changes;
      const changed = changes ? Object.entries(changes).filter(([key]) => /^(created|updated)/.test(key)).reduce((total, [, count]) => total + (Number(count) || 0), 0) : 0;
      const unchanged = changes ? Object.entries(changes).filter(([key]) => /^unchanged/.test(key)).reduce((total, [, count]) => total + (Number(count) || 0), 0) : 0;
      setSuccess(changes ? `Archivo procesado: ${changed} registros creados o actualizados. ${unchanged} registros ya estaban guardados y no se duplicaron. Las facturas de Excel permanecen como borradores hasta emitirlas en la web.` : "Archivo importado. Revisa los registros en cada sección.");
      setPreview(null); onImported();
    } catch (err) { setError(err instanceof Error ? err.message : "La importación falló. Revisa la conexión y vuelve a intentar."); }
    finally { setBusy(""); }
  }

  async function download() {
    if (busy || syncBusy) return;
    setError(""); setSuccess(""); setBusy("Preparando el Excel con tus fotos…");
    try {
      const response = await fetch("/api/data", { cache: "no-store" });
      const snapshot = await response.json() as ExcelBusinessData & { orders: Order[]; payments: Payment[]; exchanges: Exchange[]; error?: string };
      if (!response.ok) throw new Error(snapshot.error || "No pude consultar los registros actuales para exportarlos.");
      if (![snapshot.orders, snapshot.payments, snapshot.exchanges, snapshot.clients, snapshot.quotes, snapshot.invoiceDrafts].every(Array.isArray)) throw new Error("La exportación recibió datos incompletos. Actualiza la página y vuelve a intentarlo.");
      const blob = await exportExcel(snapshot.orders, snapshot.payments, snapshot.exchanges, async key => {
        const response = await fetch(`/api/photos/${encodeURIComponent(key)}`);
        if (!response.ok) throw new Error("No pude descargar una foto. La exportación se detuvo para evitar un archivo incompleto.");
        return response.blob();
      }, snapshot);
      const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = `mis-pedidos-${new Date().toISOString().slice(0, 10)}.xlsx`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (err) { setError(err instanceof Error ? err.message : "No pude exportar el Excel."); }
    finally { setBusy(""); }
  }

  return <section className="excel-panel"><OneDrivePanel manualBusy={!!busy} onSyncBusy={setSyncBusy} onSynced={onSynced || onImported} onSyncStatus={onSyncStatus}/><div className="excel-manual-heading"><span>También puedes trabajar con archivos</span></div>
    <div className="section-heading"><div><h2>Tu Excel, conectado a Mi encargo</h2><p>Clientes, pedidos, precios, pagos, cotizaciones y borradores de factura en hojas relacionadas.</p></div><FileSpreadsheet size={28} aria-hidden="true" /></div>
    <div className="excel-actions">
      <button className="button button-primary" onClick={() => input.current?.click()} disabled={!!busy || syncBusy}><Upload size={18} /> Subir Excel</button>
      <a className="button button-secondary" href="/plantilla-pedidos.xlsx" download><Download size={18} /> Descargar plantilla</a>
      <button className="button button-secondary" onClick={download} disabled={!!busy || syncBusy}><Download size={18} /> Exportar todos mis registros</button>
      <input ref={input} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={event => choose(event.target.files?.[0])} aria-label="Seleccionar Excel de pedidos" style={{ display: "none" }} />
    </div>
    <div className="excel-guide" style={{ marginTop: 20, lineHeight: 1.65 }}>
      <p><strong>1.</strong> Registra cada persona en <strong>Clientes</strong> y conserva su ID Cliente. En <strong>Pedidos</strong> elige ese ID y escribe una fila por artículo; usa las listas de Estado y Plataforma.</p>
      <p><strong>2.</strong> En la plantilla nueva, anota el precio al cliente y lo pagado a la tienda en <strong>Precios</strong>, con el mismo ID Pedido. También se aceptan los archivos anteriores con el precio dentro de Pedidos.</p>
      <p><strong>3.</strong> Inserta una foto JPG o PNG en la columna <strong>Foto</strong>. Puedes usar <strong>Colocar en celda</strong> o <strong>Colocar sobre celdas</strong>. En esta última opción, ajusta la foto dentro de la fila de su artículo.</p>
      <p><strong>4.</strong> Anota abonos y devoluciones en <strong>Pagos</strong>. Prepara cotizaciones con sus líneas en <strong>DetalleCotizaciones</strong>, y borradores en <strong>Facturas</strong> y <strong>DetalleFacturas</strong>. Una cotización no crea deuda; una factura solo se emite cuando lo confirmas en la web.</p>
      <p><strong>5.</strong> Guarda el libro conectado en OneDrive y mantén abierta esta sección para sincronizar. También puedes descargarlo como <strong>.xlsx</strong> y usar <strong>Subir Excel</strong> para revisar y confirmar manualmente.</p>
      <p style={{ fontSize: 13, color: "var(--muted-foreground)" }}>Máximo 5 MB por archivo, 1,500 artículos, 3,000 pagos y 1,500 registros por cada hoja de clientes o documentos. Conserva IDs y revisiones. Una importación agrega o actualiza registros; las filas que falten no se eliminan. Con permiso de escritura, la conexión envía también los cambios de la web al libro y detiene los conflictos para revisión.</p>
    </div>
    {busy && <p role="status" className="alert">{busy}</p>}
    {error && <div role="alert" className="inline-error"><AlertCircle size={18} /> {error}</div>}
    {success && <div role="status" className="alert"><Check size={18} /> {success}</div>}
    {preview && <div className="excel-preview" style={{ marginTop: 24 }}>
      <div className="section-heading"><div><h3>Revisar: {preview.fileName}</h3><p>{preview.clients.length} clientes · {preview.orders.length} artículos · {preview.photos.length} fotos · {preview.payments.length} pagos · {preview.quotes.length} cotizaciones · {preview.invoiceDrafts.length} borradores · {preview.exchanges.length} cambios</p></div><button type="button" className="text-button" onClick={() => setPreview(null)} disabled={!!busy || syncBusy} aria-label="Cerrar vista previa"><X size={20} /></button></div>
      <p>{preview.orders.length - updates} artículos nuevos y {updates} con un ID que ya existe. Las actualizaciones requieren la revisión de la última exportación.</p>
      {preview.warnings.map((warning, index) => <p className="alert" key={index}>{warning}</p>)}
      {!!previewErrors.length && <div role="alert" className="inline-error" style={{ display: "block" }}><strong>Corrige el Excel antes de importar:</strong><ul>{previewErrors.slice(0, 30).map((issue, index) => <li key={index}>{issue}</li>)}</ul>{previewErrors.length > 30 && <p>Hay {previewErrors.length - 30} errores adicionales.</p>}</div>}
      {!!preview.orders.length && <div style={{ overflowX: "auto", margin: "16px 0" }}><table className="preview-table"><thead><tr><th>Foto</th><th>Cliente</th><th>Artículo</th><th>Plataforma</th><th>Total a cobrar</th><th>Acción</th></tr></thead><tbody>{preview.orders.slice(0, 30).map(order => { const photo = preview.photos.find(item => item.orderId === order.id); return <tr key={order.id}><td>{photo ? <PhotoPreview blob={photo.blob} article={order.article} /> : order.photoKey ? "Foto guardada" : "Sin foto"}</td><td>{order.client}</td><td>{order.article}<small style={{ display: "block" }}>{order.id}</small></td><td>{order.platform}</td><td>{currency(orderTotal(order))}</td><td>{existing.has(order.id) ? "Revisar actualización" : "Nuevo"}</td></tr>; })}</tbody></table>{preview.orders.length > 30 && <p>Mostrando los primeros 30 de {preview.orders.length} artículos.</p>}</div>}
      {!!preview.payments.length && <div style={{ overflowX: "auto", margin: "16px 0" }}><table className="preview-table"><thead><tr><th>ID Pedido</th><th>Tipo</th><th>Monto</th><th>Fecha</th><th>Medio</th></tr></thead><tbody>{preview.payments.slice(0, 15).map(payment => <tr key={payment.id}><td>{payment.orderId}</td><td>{payment.kind}</td><td>{currency(payment.amountCents)}</td><td>{payment.date}</td><td>{payment.method}</td></tr>)}</tbody></table>{preview.payments.length > 15 && <p>Mostrando los primeros 15 de {preview.payments.length} pagos.</p>}</div>}
      {!!preview.clients.length && <div style={{ overflowX: "auto", margin: "16px 0" }}><h4>Clientes</h4><table className="preview-table"><thead><tr><th>ID Cliente</th><th>Nombre</th><th>Teléfono</th><th>Activo</th></tr></thead><tbody>{preview.clients.slice(0, 15).map(client => <tr key={client.id}><td>{client.id}</td><td>{client.name}</td><td>{client.phone || "—"}</td><td>{client.active ? "Sí" : "No"}</td></tr>)}</tbody></table></div>}
      {!!preview.quotes.length && <div style={{ overflowX: "auto", margin: "16px 0" }}><h4>Cotizaciones</h4><table className="preview-table"><thead><tr><th>ID Cotización</th><th>ID Cliente</th><th>Fecha</th><th>Estado</th><th>Artículos</th><th>Total</th></tr></thead><tbody>{preview.quotes.slice(0, 15).map(quote => <tr key={quote.id}><td>{quote.id}</td><td>{quote.clientId}</td><td>{quote.date}</td><td>{quote.status}</td><td>{quote.items.length}</td><td>{currency(quote.totalCents)}</td></tr>)}</tbody></table><p>Cotizar no registra pagos ni aumenta la deuda del cliente.</p></div>}
      {!!preview.invoiceDrafts.length && <div style={{ overflowX: "auto", margin: "16px 0" }}><h4>Borradores de factura</h4><table className="preview-table"><thead><tr><th>ID Borrador</th><th>ID Cliente</th><th>Fecha</th><th>Artículos</th><th>Importes</th></tr></thead><tbody>{preview.invoiceDrafts.slice(0, 15).map(draft => <tr key={draft.id}><td>{draft.id}</td><td>{draft.clientId}</td><td>{draft.date}</td><td>{draft.items.length}</td><td>{!draft.showAmounts ? "Sin importes" : draft.pricingMode === "manual" ? currency(draft.manualTotalCents) : "Precios registrados"}</td></tr>)}</tbody></table><p>Importar guarda el borrador. La factura requiere revisión y emisión en la web.</p></div>}
      <button className="button button-primary" disabled={!canImport || !!busy || syncBusy} onClick={confirmImport}><Check size={18} /> Confirmar importación</button>
    </div>}
  </section>;
}
