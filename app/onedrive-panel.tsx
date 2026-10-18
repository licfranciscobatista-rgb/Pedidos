"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Check, Cloud, ExternalLink, FileSpreadsheet, Link, LoaderCircle, Pause, Play, RefreshCw, Search, Unplug } from "lucide-react";
import { parseExcel } from "../lib/excel";

type DriveFile = { id: string; name: string; size?: number; lastModifiedAt?: string; parentPath?: string; webUrl?: string; etag?: string; syncedEtag?: string };
type PendingWrite = { fileId: string; sourceEtag: string; targetHash: string; preparedAt: string };
type DriveStatus = { configured: boolean; connected: boolean; canWrite?: boolean; writePending?: boolean; pendingWrite?: PendingWrite | null; lastWriteAt?: string; account?: string; selectedFile?: DriveFile; lastSyncAt?: string; lastSyncError?: string };
type Conflict = { orderId: string; client: string; article: string; reason: string };
type SyncResult = { changes?: Record<string, number>; lastSyncAt?: string; conflicts?: Conflict[]; error?: string; writePending?: boolean };
type PushResult = { written?: number; etag?: string; lastWriteAt?: string; recovered?: boolean; unchanged?: boolean; error?: string; readOnly?: boolean; requiresPull?: boolean; writePending?: boolean };
export type OneDriveNotice = { error: string; working: string; paused: boolean; conflict: boolean; writePending: boolean };
const timestamp = (value?: string) => value ? new Date(value).toLocaleString("es-DO", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "Todavía no se ha sincronizado";

async function driveRequest(path: string, options: RequestInit = {}) {
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 60000);
  try { return await fetch(path, { cache: "no-store", ...options, signal: controller.signal }); }
  catch (cause) { if (cause instanceof DOMException && cause.name === "AbortError") throw new Error("Microsoft tardó demasiado en responder. La sincronización automática se pausó; puedes reintentar cuando tengas conexión."); throw cause; }
  finally { clearTimeout(timeout); }
}
async function jsonRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await driveRequest(path, options), result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error || "No se pudo consultar la conexión con Microsoft.");
  return result;
}

export default function OneDrivePanel({ manualBusy, onSyncBusy, onSynced, onSyncStatus }: { manualBusy: boolean; onSyncBusy: (busy: boolean) => void; onSynced: () => void; onSyncStatus?: (notice: OneDriveNotice) => void }) {
  const [status, setStatus] = useState<DriveStatus | null>(null), [loading, setLoading] = useState(true), [working, setWorking] = useState("");
  const [error, setError] = useState(""), [message, setMessage] = useState(""), [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [conflictState, setConflictState] = useState(false), [searched, setSearched] = useState(false);
  const [files, setFiles] = useState<DriveFile[] | null>(null), [query, setQuery] = useState("PROGRAMA DE PEDIDOS.xlsx");
  const [automatic, setAutomatic] = useState(true), [halted, setHalted] = useState(false), [checkedAt, setCheckedAt] = useState("");
  const [reviewedJob, setReviewedJob] = useState("");
  const resetKey = status?.pendingWrite ? `${status.pendingWrite.targetHash}:${status.pendingWrite.preparedAt}` : "";
  const resetReviewed = Boolean(resetKey && reviewedJob === resetKey);
  const statusRef = useRef<DriveStatus | null>(null), busyRef = useRef(false), manualRef = useRef(manualBusy), autoRef = useRef(true), haltedRef = useRef(false);
  const etagRef = useRef({ fileId: "", etag: "" }), callbackRef = useRef({ onSyncBusy, onSynced, onSyncStatus });
  useEffect(() => { manualRef.current = manualBusy; callbackRef.current = { onSyncBusy, onSynced, onSyncStatus }; }, [manualBusy, onSyncBusy, onSynced, onSyncStatus]);
  useEffect(() => { callbackRef.current.onSyncStatus?.({ error, working, paused: halted, conflict: conflictState, writePending: Boolean(status?.writePending) }); }, [error, working, halted, conflictState, status?.writePending]);
  const readStatus = useCallback(async () => {
    const next = await jsonRequest<DriveStatus>("/api/onedrive/status");
    statusRef.current = next; setStatus(next);
    if (next.selectedFile?.id !== etagRef.current.fileId) etagRef.current = { fileId: next.selectedFile?.id || "", etag: next.selectedFile?.syncedEtag || "" };
    else if (next.selectedFile?.syncedEtag) etagRef.current.etag = next.selectedFile.syncedEtag;
    return next;
  }, []);
  const sendToExcel = useCallback(async (fileId: string, etag: string) => {
    setWorking("Comprobando los cambios de la web para enviarlos al Excel…");
    const response = await driveRequest("/api/onedrive/push", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fileId, etag }) });
    const result = await response.json() as PushResult;
    if (!response.ok) {
      if (result.readOnly) { const next = await readStatus(); setStatus(next); setMessage(result.error || "Activa el permiso de escritura para enviar cambios al Excel."); return; }
      if (result.requiresPull) etagRef.current = { fileId, etag: "" };
      if (response.status === 409) setConflictState(true);
      if (result.writePending && statusRef.current) {
        try { await readStatus(); }
        catch { statusRef.current = { ...statusRef.current!, writePending: true }; setStatus(statusRef.current); }
      }
      throw new Error(result.error || "No se pudo confirmar el envío al Excel. Revisa el estado antes de reintentar.");
    }
    if (result.etag) etagRef.current = { fileId, etag: result.etag };
    await readStatus();
    if (result.recovered) setMessage("Envío anterior verificado por sus bytes. El Excel y el registro de sincronización están confirmados.");
    else if (result.written) setMessage(`${result.written} registros de la web enviados al Excel original. Se conservaron sus hojas, fórmulas y fotos.`);
    return result;
  }, [readStatus]);
  const synchronize = useCallback(async (manual = false) => {
    const current = statusRef.current;
    if (!current?.configured || !current.connected || !current.selectedFile || busyRef.current || manualRef.current || (!manual && (!autoRef.current || haltedRef.current || document.visibilityState !== "visible"))) return;
    busyRef.current = true; callbackRef.current.onSyncBusy(true); setWorking("Comprobando tu libro en OneDrive…"); setConflicts([]); setConflictState(false);
    if (manual) { haltedRef.current = false; setHalted(false); }
    try {
      if (current.writePending) { await sendToExcel(current.selectedFile.id, etagRef.current.etag || current.selectedFile.syncedEtag || ""); setError(""); setCheckedAt(new Date().toISOString()); return; }
      const headers: Record<string, string> = {};
      if (etagRef.current.fileId === current.selectedFile.id && etagRef.current.etag) headers["If-None-Match"] = etagRef.current.etag;
      const response = await driveRequest("/api/onedrive/download", { headers });
      if (response.status === 304 || response.status === 204) { setError(""); setCheckedAt(new Date().toISOString()); if (manual) setMessage("El libro ya está al día. No se volvieron a importar sus registros."); if (current.canWrite) await sendToExcel(current.selectedFile.id, etagRef.current.etag); return; }
      if (!response.ok) { if (response.status === 409) setConflictState(true); const result = await response.json().catch(() => ({})) as { error?: string }; throw new Error(result.error || "No se pudo descargar el libro de OneDrive."); }
      const fileId = response.headers.get("X-OneDrive-File-Id"), etag = response.headers.get("X-OneDrive-Etag");
      if (!etag || fileId !== current.selectedFile.id) throw new Error("No se pudo verificar la versión del libro seleccionado. Actualiza la conexión y vuelve a intentar.");
      if (etagRef.current.fileId === fileId && etagRef.current.etag === etag) { await response.body?.cancel(); setError(""); setCheckedAt(new Date().toISOString()); if (manual) setMessage("El libro no cambió desde la última comprobación."); if (current.canWrite) await sendToExcel(fileId, etag); return; }
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > 5 * 1024 * 1024) throw new Error("El libro supera el límite de 5 MB. Reduce las fotos o divide los pedidos antes de sincronizar.");
      setWorking("Leyendo clientes, pedidos, pagos, cotizaciones y borradores…");
      const preview = await parseExcel(bytes, current.selectedFile.name);
      if (preview.errors.length) {
        setMessage(""); setCheckedAt(new Date().toISOString());
        setError(`Corrige el libro antes de sincronizar: ${preview.errors.slice(0, 5).join(" ")}${preview.errors.length > 5 ? ` Hay ${preview.errors.length - 5} errores adicionales.` : ""} No se guardó ningún cambio de este libro. Si la automática está activa, volverá a comprobarlo cada 60 segundos mientras esta página esté visible.`);
        return;
      }
      if (preview.generatedIds) throw new Error("La sincronización requiere un ID Pedido estable para cada artículo. Completa esos códigos en el Excel antes de reintentar.");
      setError("");
      if (!current.canWrite && !preview.orders.length && !preview.payments.length && !preview.exchanges.length && !preview.clients?.length && !preview.quotes?.length && !preview.invoiceDrafts?.length) { etagRef.current = { fileId, etag }; setCheckedAt(new Date().toISOString()); setMessage("El libro solo tiene encabezados. Agrega tus artículos o clientes y se leerán cuando guardes los cambios."); return; }
      const orders = preview.orders.map(order => ({ ...order }));
      for (let i = 0; i < preview.photos.length; i++) {
        const photo = preview.photos[i]; setWorking(`Preparando foto ${i + 1} de ${preview.photos.length}…`);
        const form = new FormData(); form.append("file", photo.blob, photo.name);
        const uploaded = await jsonRequest<{ photoKey: string }>("/api/photos", { method: "POST", body: form });
        if (!uploaded.photoKey) throw new Error(`No se pudo guardar la foto del artículo ${photo.orderId}.`);
        const order = orders.find(item => item.id === photo.orderId); if (order) order.photoKey = uploaded.photoKey;
      }
      setWorking("Guardando los cambios del libro…");
      const committed = await driveRequest("/api/onedrive/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orders, payments: preview.payments, exchanges: preview.exchanges, clients: preview.clients || [], quotes: preview.quotes || [], invoiceDrafts: preview.invoiceDrafts || [], fileId, etag, generatedIds: preview.generatedIds }) });
      const result = await committed.json() as SyncResult;
      if (!committed.ok) { if (committed.status === 409) { setConflictState(true); setConflicts(result.conflicts || []); } if (result.writePending && statusRef.current) { try { await readStatus(); } catch { statusRef.current = { ...statusRef.current!, writePending: true }; setStatus(statusRef.current); } } throw new Error(result.error || "Los datos cambiaron en Excel o en la web. Revisa el conflicto antes de volver a sincronizar."); }
      etagRef.current = { fileId, etag }; setCheckedAt(new Date().toISOString()); haltedRef.current = false; setHalted(false);
      await readStatus();
      callbackRef.current.onSynced();
      const changes = result.changes, count = changes ? Object.entries(changes).filter(([key]) => /created|updated/i.test(key)).reduce((sum, [, value]) => sum + (Number(value) || 0), 0) : undefined;
      setMessage(count === 0 ? "Libro sincronizado. Los registros que ya estaban guardados no se duplicaron." : count === undefined ? "Cambios del Excel guardados en la web." : `${count} ${count === 1 ? "registro actualizado" : "registros actualizados"} desde el Excel.`);
      if (current.canWrite) await sendToExcel(fileId, etag);
    } catch (cause) { haltedRef.current = true; setHalted(true); setMessage(""); setError(cause instanceof Error ? cause.message : "No se pudo sincronizar con OneDrive. Revisa la conexión y vuelve a intentar."); }
    finally { busyRef.current = false; callbackRef.current.onSyncBusy(false); setWorking(""); }
  }, [readStatus, sendToExcel]);
  useEffect(() => {
    let alive = true;
    const initial = setTimeout(() => { if (new URLSearchParams(window.location.search).get("onedrive") === "error") setError("Microsoft no completó la autorización. Puedes intentarlo de nuevo con el botón Autorizar mi OneDrive."); void readStatus().then(next => { if (!alive) return; if (next.lastSyncError) { haltedRef.current = true; setHalted(true); setError(next.lastSyncError); setConflictState(/conflict/i.test(next.lastSyncError)); } else void synchronize(); }).catch(cause => { if (alive) { setError(cause instanceof Error ? cause.message : "No se pudo comprobar la conexión con Microsoft."); haltedRef.current = true; setHalted(true); } }).finally(() => { if (alive) setLoading(false); }); }, 0);
    const interval = setInterval(() => { if (document.visibilityState === "visible") void synchronize(); }, 60000);
    const visible = () => { if (document.visibilityState === "visible") void synchronize(); };
    document.addEventListener("visibilitychange", visible);
    return () => { alive = false; clearTimeout(initial); clearInterval(interval); document.removeEventListener("visibilitychange", visible); };
  }, [readStatus, synchronize]);
  async function refreshConnection() {
    if (busyRef.current) return;
    setLoading(true); setError("");
    try { const next = await readStatus(); haltedRef.current = !!next.lastSyncError; setHalted(!!next.lastSyncError); setError(next.lastSyncError || ""); setConflictState(/conflict/i.test(next.lastSyncError || "")); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo comprobar la conexión."); }
    finally { setLoading(false); }
  }
  async function findFiles() {
    if (busyRef.current || manualBusy) return;
    busyRef.current = true; callbackRef.current.onSyncBusy(true); setWorking("Buscando libros en tu OneDrive…"); setError("");
    try { const result = await jsonRequest<{ files: DriveFile[] }>(`/api/onedrive/files?query=${encodeURIComponent(query.trim() || "PROGRAMA")}`); setFiles(result.files); setSearched(true); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudieron buscar los libros."); }
    finally { busyRef.current = false; callbackRef.current.onSyncBusy(false); setWorking(""); }
  }
  async function selectFile(file: DriveFile) {
    if (busyRef.current || manualBusy) return;
    busyRef.current = true; callbackRef.current.onSyncBusy(true); setWorking("Seleccionando tu libro…"); setError(""); setMessage(""); setConflicts([]);
    let ready = false;
    try { await jsonRequest("/api/onedrive/select", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fileId: file.id }) }); await readStatus(); etagRef.current = { fileId: file.id, etag: "" }; setFiles(null); setSearched(false); setConflictState(false); haltedRef.current = false; setHalted(false); autoRef.current = true; setAutomatic(true); ready = true; }
    catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo seleccionar este libro."); }
    finally { busyRef.current = false; callbackRef.current.onSyncBusy(false); setWorking(""); }
    if (ready) void synchronize(true);
  }
  async function disconnect() {
    if (busyRef.current || manualBusy || !window.confirm("¿Desconectar OneDrive? La sincronización se detendrá. Los pedidos que ya están en la web se conservarán.")) return;
    busyRef.current = true; callbackRef.current.onSyncBusy(true); setWorking("Desconectando OneDrive…"); setError("");
    try { await jsonRequest("/api/onedrive/disconnect", { method: "POST" }); await readStatus(); setFiles(null); setSearched(false); setConflictState(false); setConflicts([]); setMessage("OneDrive desconectado. Tus pedidos guardados siguen disponibles."); haltedRef.current = false; setHalted(false); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo desconectar OneDrive."); }
    finally { busyRef.current = false; callbackRef.current.onSyncBusy(false); setWorking(""); }
  }
  async function resetPendingWrite() {
    const pending = statusRef.current?.pendingWrite;
    if (!pending || !resetReviewed || busyRef.current || manualBusy) return;
    busyRef.current = true; callbackRef.current.onSyncBusy(true); setWorking("Registrando tu revisión del envío pendiente…"); setError("");
    try {
      const result = await jsonRequest<{ message: string }>("/api/onedrive/write-reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedTargetHash: pending.targetHash, preparedAt: pending.preparedAt, reviewed: true }) });
      const next = await readStatus(); etagRef.current = { fileId: next.selectedFile?.id || "", etag: "" }; haltedRef.current = false; setHalted(false); setConflictState(false); setConflicts([]); setReviewedJob(""); setMessage(result.message);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo registrar la revisión. Actualiza el estado y vuelve a intentarlo."); }
    finally { busyRef.current = false; callbackRef.current.onSyncBusy(false); setWorking(""); }
  }
  const disabled = !!working || manualBusy;
  const stateLabel = loading ? "Comprobando conexión" : !status ? "No disponible" : !status.configured ? "Sin configurar" : !status.connected ? "Por autorizar" : conflictState || conflicts.length ? "Conflicto" : halted ? "Automática pausada" : status.selectedFile ? "Conectado" : "Elige tu libro";
  return <section className="onedrive-panel" aria-labelledby="onedrive-title"><div className="onedrive-heading"><span className="onedrive-icon"><Cloud size={25}/></span><div><h3 id="onedrive-title">Conexión con Excel online</h3><p>Sincroniza los registros del libro con Mi encargo y revisa los conflictos antes de sobrescribir.</p></div><span className={`onedrive-state ${status?.connected && !halted ? "connected" : ""}`}>{loading ? <LoaderCircle size={13} className="spin"/> : status?.connected && !halted ? <Check size={13}/> : <AlertCircle size={13}/>} {stateLabel}</span></div><div className="onedrive-target"><FileSpreadsheet size={20}/><div><span>Libro de trabajo</span><strong>{status?.selectedFile?.name || "PROGRAMA DE PEDIDOS.xlsx"}</strong>{status?.selectedFile?.webUrl?.startsWith("https://") && <a href={status.selectedFile.webUrl} target="_blank" rel="noopener noreferrer">Abrir el Excel original <ExternalLink size={12}/></a>}</div></div>{!loading && !status && <button className="button button-secondary onedrive-retry" onClick={() => void refreshConnection()} disabled={disabled}><RefreshCw size={15}/> Volver a comprobar conexión</button>}{!loading && status && !status.configured && <div className="onedrive-configuration"><strong>Falta configurar la conexión Microsoft</strong><p>La app necesita el registro de Microsoft y sus credenciales de servidor para autorizar tu OneDrive. Cuando esa configuración esté lista, podrás conectar tu cuenta y elegir el libro. Mientras tanto, puedes subir el archivo manualmente abajo.</p></div>}{!loading && status?.configured && !status.connected && <div className="onedrive-authorize"><p>Autoriza tu cuenta Microsoft para leer el archivo guardado en tu OneDrive. Los cambios de esta conexión van de Excel hacia la web.</p><a className="button button-primary" href="/api/onedrive/start"><Link size={16}/> Autorizar mi OneDrive</a></div>}{status?.connected && <><div className="onedrive-account"><span>Cuenta: {status.account || "Microsoft autorizada"}</span><button className="text-button" onClick={() => void disconnect()} disabled={disabled}><Unplug size={13}/> Desconectar</button></div>{!status.canWrite && <div className="onedrive-configuration"><strong>Conexión actual: solo lectura de Excel</strong><p>Para enviar también los registros de la web al libro original, autoriza el permiso de escritura de Microsoft. Se conservarán las hojas, las fotos y las fórmulas; los cambios simultáneos requieren revisión.</p><a className="button button-secondary" href="/api/onedrive/start?mode=write"><Link size={15}/> Activar envío web → Excel</a></div>}{status.selectedFile && <><div className="onedrive-sync-info"><p><strong>Última sincronización:</strong> {timestamp(status.lastSyncAt)}</p>{checkedAt && <p>Última comprobación: {timestamp(checkedAt)}</p>}{status.canWrite && <p><strong>Modo:</strong> Excel ↔ web. Último envío: {timestamp(status.lastWriteAt)}</p>}{status.writePending && <p><strong>Envío pendiente:</strong> pulsa Reintentar sincronización para verificarlo antes de repetir la escritura.</p>}<p>{halted ? "La sincronización automática se detuvo por un error. Revisa el mensaje y reintenta." : automatic ? "Automática al abrir la app y cada 60 segundos mientras esta página esté visible." : "La sincronización automática está pausada en esta sesión."}</p></div><div className="onedrive-actions"><button className="button button-primary" onClick={() => void synchronize(true)} disabled={disabled}><RefreshCw size={16} className={working ? "spin" : ""}/>{halted ? "Reintentar sincronización" : "Sincronizar ahora"}</button><button className="button button-secondary" disabled={disabled || halted} onClick={() => { autoRef.current = !automatic; setAutomatic(!automatic); if (!automatic) void synchronize(); }}>{automatic ? <Pause size={15}/> : <Play size={15}/>} {automatic ? "Pausar automática" : "Activar automática"}</button><button className="text-button" onClick={() => { setFiles([]); setSearched(false); }} disabled={disabled}>Cambiar libro</button></div></>}{(!status.selectedFile || files !== null) && <div className="onedrive-file-picker"><label className="field">Busca tu libro en OneDrive<div className="onedrive-search"><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Nombre del libro o Documents/Pedidos.xlsx" maxLength={300} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void findFiles(); } }}/><button className="button button-secondary" onClick={() => void findFiles()} disabled={disabled}><Search size={15}/> Buscar</button></div></label><p>Busca por nombre o escribe la ruta de carpetas, por ejemplo <code>Documents/Pedidos.xlsx</code>.</p><p>Al seleccionar un libro, comenzará su lectura y la sincronización automática. Mantén los ID Pedido y los ID Pago para evitar duplicados.</p>{files !== null && files.length === 0 && <p className="onedrive-no-files">{searched ? "No encontramos el libro. Prueba su nombre o la ruta de carpetas y revisa que esté en este OneDrive." : "Busca el nombre del archivo para ver los libros disponibles de tu OneDrive."}</p>}{files?.map(file => <div className="onedrive-file" key={file.id}><FileSpreadsheet size={19}/><div><strong>{file.name}</strong><small>{file.parentPath || "OneDrive"}{file.size ? ` · ${(file.size / 1024 / 1024).toFixed(2)} MB` : ""}</small></div><button className="button button-secondary" onClick={() => void selectFile(file)} disabled={disabled || !!file.size && file.size > 5 * 1024 * 1024}>Usar este libro</button></div>)}</div>}</>}{status?.pendingWrite && <div className="onedrive-configuration"><strong>Revisar un envío pendiente</strong><p>Preparado: {timestamp(status.pendingWrite.preparedAt)}. Libro: {status.selectedFile?.id === status.pendingWrite.fileId ? status.selectedFile.name : "un libro de una conexión anterior"}.</p><p>Primero intenta verificarlo con Reintentar sincronización. Si la cuenta cambió o las versiones no coinciden, revisa el Excel original y los registros de la web. Descartar la confirmación no cancela ni revierte un envío que Microsoft pudiera haber recibido.</p><details><summary>Datos del envío para revisar</summary><p>Archivo: <code style={{ overflowWrap: "anywhere" }}>{status.pendingWrite.fileId}</code></p><p>Versión de origen: <code style={{ overflowWrap: "anywhere" }}>{status.pendingWrite.sourceEtag}</code></p><p>Identificador del contenido preparado: <code style={{ overflowWrap: "anywhere" }}>{status.pendingWrite.targetHash}</code></p></details><label className="field" style={{ marginTop: 12 }}><span><input type="checkbox" style={{ width: 18, height: 18, marginRight: 8 }} checked={resetReviewed} onChange={event => setReviewedJob(event.target.checked ? resetKey : "")} disabled={disabled}/> Revisé el Excel original y los registros de la web; entiendo que solo se descartará la confirmación pendiente.</span></label><button className="button button-secondary" onClick={() => void resetPendingWrite()} disabled={disabled || !resetReviewed}>Descartar confirmación después de revisar</button><p>Esta acción está disponible dos minutos después de preparar el envío. Conserva pedidos, pagos, documentos y versiones de referencia; la siguiente sincronización volverá a leer el Excel.</p></div>}{working && <div className="alert onedrive-notice" role="status"><LoaderCircle size={16} className="spin"/> {working}</div>}{error && <div className="inline-error" role="alert"><strong>{conflictState || conflicts.length ? "Revisa estos cambios antes de sincronizar" : "No se completó la conexión o sincronización"}</strong><p>{error}</p>{conflicts.length > 0 && <ul>{conflicts.slice(0, 15).map(conflict => <li key={conflict.orderId}><strong>{conflict.client} · {conflict.article}</strong><span>{conflict.orderId}: {conflict.reason}</span></li>)}</ul>}{halted && <p>Revisa el Excel y los datos actuales de la web. No se fuerza la sobrescritura de los registros en conflicto.</p>}</div>}{message && <div className="alert" role="status"><Check size={15}/> {message}</div>}<p className="onedrive-limits">{status?.canWrite ? "Excel ↔ web · Escritura con control de versión y recuperación de envíos" : "Excel → web · Activa el permiso de escritura para enviar cambios al libro"} · Archivo .xlsx de hasta 5 MB · Las filas eliminadas no borran registros automáticamente.</p></section>;
}
