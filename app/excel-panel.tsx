"use client";

import { useEffect, useRef, useState } from "react";
import { Download, FileSpreadsheet, Upload, Check, AlertCircle, X } from "lucide-react";
import { exportExcel, parseExcel, type ExcelPreview } from "@/lib/excel";
import { orderTotal, type Exchange, type Order, type Payment } from "@/lib/types";
import OneDrivePanel from "./onedrive-panel";

const currency = (cents: number) => `RD$ ${(cents / 100).toLocaleString("es-DO", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function PhotoPreview({ blob, article }: { blob: Blob; article: string }) {
  const image = useRef<HTMLImageElement>(null);
  useEffect(() => { const url = URL.createObjectURL(blob); if (image.current) image.current.src = url; return () => URL.revokeObjectURL(url); }, [blob]);
  // Local object URLs are managed and released here; they cannot use an image optimizer.
  // eslint-disable-next-line @next/next/no-img-element
  return <img ref={image} alt={`Foto de ${article}`} width={56} height={56} style={{ width: 56, height: 56, objectFit: "cover", borderRadius: 8 }} />;
}

export default function ExcelPanel({ orders, payments, exchanges = [], onImported, onSynced }: { orders: Order[]; payments: Payment[]; exchanges?: Exchange[]; onImported: () => void; onSynced?: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<ExcelPreview | null>(null);
  const [busy, setBusy] = useState("");
  const [syncBusy, setSyncBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const existing = new Set(orders.map(order => order.id));
  const updates = preview?.orders.filter(order => existing.has(order.id)).length || 0;
  const unknownReferences = preview ? [...preview.payments, ...preview.exchanges].filter(record => !existing.has(record.orderId) && !preview.orders.some(order => order.id === record.orderId)).map(record => `El registro ${record.id} apunta al pedido ${record.orderId}, que no existe en la app ni en este archivo.`) : [];
  const previewErrors = [...(preview?.errors || []), ...unknownReferences];
  const canImport = preview && !previewErrors.length && (preview.orders.length || preview.payments.length || preview.exchanges.length);

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
      setBusy("Guardando los pedidos y los pagos…");
      const response = await fetch("/api/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orders: nextOrders, payments: preview.payments, exchanges: preview.exchanges }) });
      const result = await response.json() as { error?: string; changes?: { createdOrders: number; updatedOrders: number; createdPayments: number; createdExchanges: number; unchangedOrders: number; unchangedPayments: number; unchangedExchanges: number } };
      if (!response.ok) throw new Error(result.error || (response.status === 409 ? "Estos datos cambiaron desde la última exportación. Descarga el Excel actualizado y aplica tus cambios sobre ese archivo." : "No pude importar el archivo. Los datos no se guardaron."));
      setSuccess(result.changes ? `Archivo procesado: ${result.changes.createdOrders} artículos nuevos, ${result.changes.updatedOrders} actualizados, ${result.changes.createdPayments} pagos nuevos y ${result.changes.createdExchanges} cambios nuevos. ${result.changes.unchangedOrders + result.changes.unchangedPayments + result.changes.unchangedExchanges} registros ya estaban guardados y no se duplicaron.` : `Archivo importado: ${preview.orders.length} artículos y ${preview.payments.length} pagos revisados.`);
      setPreview(null); onImported();
    } catch (err) { setError(err instanceof Error ? err.message : "La importación falló. Revisa la conexión y vuelve a intentar."); }
    finally { setBusy(""); }
  }

  async function download() {
    if (busy || syncBusy) return;
    setError(""); setSuccess(""); setBusy("Preparando el Excel con tus fotos…");
    try {
      const blob = await exportExcel(orders, payments, exchanges, async key => {
        const response = await fetch(`/api/photos/${encodeURIComponent(key)}`);
        if (!response.ok) throw new Error("No pude descargar una foto. La exportación se detuvo para evitar un archivo incompleto.");
        return response.blob();
      });
      const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = `mis-pedidos-${new Date().toISOString().slice(0, 10)}.xlsx`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (err) { setError(err instanceof Error ? err.message : "No pude exportar el Excel."); }
    finally { setBusy(""); }
  }

  return <section className="excel-panel"><OneDrivePanel manualBusy={!!busy} onSyncBusy={setSyncBusy} onSynced={onSynced || onImported}/><div className="excel-manual-heading"><span>También puedes trabajar con archivos</span></div>
    <div className="section-heading"><div><h2>Tu Excel, con sus fotos</h2><p>Sube los artículos y revisa lo que se guardará antes de confirmar.</p></div><FileSpreadsheet size={28} aria-hidden="true" /></div>
    <div className="excel-actions">
      <button className="button button-primary" onClick={() => input.current?.click()} disabled={!!busy || syncBusy}><Upload size={18} /> Subir Excel</button>
      <a className="button button-secondary" href="/plantilla-pedidos.xlsx" download><Download size={18} /> Descargar plantilla</a>
      <button className="button button-secondary" onClick={download} disabled={!!busy || syncBusy || (!orders.length && !payments.length)}><Download size={18} /> Exportar mis pedidos</button>
      <input ref={input} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={event => choose(event.target.files?.[0])} aria-label="Seleccionar Excel de pedidos" style={{ display: "none" }} />
    </div>
    <div className="excel-guide" style={{ marginTop: 20, lineHeight: 1.65 }}>
      <p><strong>1.</strong> Rellena una fila por artículo en la hoja <strong>Pedidos</strong>. Incluye ID Pedido, cliente, fecha, artículo y precio en RD$.</p>
      <p><strong>2.</strong> Inserta una foto JPG o PNG en la columna <strong>Foto</strong>. Puedes usar <strong>Colocar en celda</strong> o <strong>Colocar sobre celdas</strong>. En esta última opción, ajusta la foto dentro de la fila de su artículo.</p>
      <p><strong>3.</strong> Anota los abonos y devoluciones en <strong>Pagos</strong>, con un ID Pago único y el ID del pedido. «Pagado a tienda» es lo que tú pagaste a Temu o SHEIN.</p>
      <p><strong>4.</strong> Guarda como <strong>.xlsx</strong> y pulsa <strong>Subir Excel</strong>. Si trabajas en Excel online, descarga una copia para subirla aquí.</p>
      <p style={{ fontSize: 13, color: "var(--muted-foreground)" }}>Máximo 5 MB por archivo, 1,500 artículos y 3,000 pagos. Para editar pedidos existentes, exporta desde esta app y conserva los IDs y las revisiones. El archivo agrega o actualiza registros; las filas que falten no se eliminan.</p>
    </div>
    {busy && <p role="status" className="alert">{busy}</p>}
    {error && <div role="alert" className="inline-error"><AlertCircle size={18} /> {error}</div>}
    {success && <div role="status" className="alert"><Check size={18} /> {success}</div>}
    {preview && <div className="excel-preview" style={{ marginTop: 24 }}>
      <div className="section-heading"><div><h3>Revisar: {preview.fileName}</h3><p>{preview.orders.length} artículos · {preview.photos.length} fotos · {preview.payments.length} pagos · {preview.exchanges.length} cambios</p></div><button type="button" className="text-button" onClick={() => setPreview(null)} disabled={!!busy || syncBusy} aria-label="Cerrar vista previa"><X size={20} /></button></div>
      <p>{preview.orders.length - updates} artículos nuevos y {updates} con un ID que ya existe. Las actualizaciones requieren la revisión de la última exportación.</p>
      {preview.warnings.map((warning, index) => <p className="alert" key={index}>{warning}</p>)}
      {!!previewErrors.length && <div role="alert" className="inline-error" style={{ display: "block" }}><strong>Corrige el Excel antes de importar:</strong><ul>{previewErrors.slice(0, 30).map((issue, index) => <li key={index}>{issue}</li>)}</ul>{previewErrors.length > 30 && <p>Hay {previewErrors.length - 30} errores adicionales.</p>}</div>}
      {!!preview.orders.length && <div style={{ overflowX: "auto", margin: "16px 0" }}><table className="preview-table"><thead><tr><th>Foto</th><th>Cliente</th><th>Artículo</th><th>Plataforma</th><th>Total a cobrar</th><th>Acción</th></tr></thead><tbody>{preview.orders.slice(0, 30).map(order => { const photo = preview.photos.find(item => item.orderId === order.id); return <tr key={order.id}><td>{photo ? <PhotoPreview blob={photo.blob} article={order.article} /> : order.photoKey ? "Foto guardada" : "Sin foto"}</td><td>{order.client}</td><td>{order.article}<small style={{ display: "block" }}>{order.id}</small></td><td>{order.platform}</td><td>{currency(orderTotal(order))}</td><td>{existing.has(order.id) ? "Revisar actualización" : "Nuevo"}</td></tr>; })}</tbody></table>{preview.orders.length > 30 && <p>Mostrando los primeros 30 de {preview.orders.length} artículos.</p>}</div>}
      {!!preview.payments.length && <div style={{ overflowX: "auto", margin: "16px 0" }}><table className="preview-table"><thead><tr><th>ID Pedido</th><th>Tipo</th><th>Monto</th><th>Fecha</th><th>Medio</th></tr></thead><tbody>{preview.payments.slice(0, 15).map(payment => <tr key={payment.id}><td>{payment.orderId}</td><td>{payment.kind}</td><td>{currency(payment.amountCents)}</td><td>{payment.date}</td><td>{payment.method}</td></tr>)}</tbody></table>{preview.payments.length > 15 && <p>Mostrando los primeros 15 de {preview.payments.length} pagos.</p>}</div>}
      <button className="button button-primary" disabled={!canImport || !!busy || syncBusy} onClick={confirmImport}><Check size={18} /> Confirmar importación</button>
    </div>}
  </section>;
}
