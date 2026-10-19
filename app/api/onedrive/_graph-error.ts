type GraphFailure = {
  error: string; microsoftStatus: number; microsoftCode?: string; microsoftInnerCode?: string; requestId?: string;
  retryable: boolean; retryAfterSeconds?: number; writePending?: boolean; requiresPull?: boolean;
};
const safeCode = (value: unknown) => typeof value === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(value) ? value : undefined;
const safeId = (value: unknown) => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value) ? value : undefined;
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

async function errorData(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) return {};
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 16 * 1024) { await reader.cancel(); return {}; }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return object(object(JSON.parse(new TextDecoder().decode(bytes))).error);
  } catch { return {}; }
  finally { reader.releaseLock(); }
}

/** Expose only identifiers: Graph messages can contain file paths or account data. */
export async function graphWriteFailure(response: Response, now = Date.now()): Promise<{ status: number; preserveJob: boolean; body: GraphFailure; retryAfter?: string }> {
  const codeData = await errorData(response), inner = object(codeData.innerError ?? codeData.innererror);
  const microsoftStatus = response.status, microsoftCode = safeCode(codeData.code);
  const microsoftInnerCode = safeCode(inner.code);
  const requestId = safeId(response.headers.get("request-id")) ?? safeId(inner["request-id"] ?? inner.requestId);
  const preserveJob = microsoftStatus >= 500 || microsoftStatus === 408 || microsoftStatus < 400;
  const temporary = preserveJob || microsoftStatus === 423 || microsoftStatus === 429;
  let retryable = temporary, retryAfterSeconds: number | undefined;
  const rawRetry = response.headers.get("retry-after");
  if (temporary) {
    if (rawRetry === null) retryAfterSeconds = preserveJob ? 120 : 60;
    else {
      const seconds = /^\d+$/.test(rawRetry) ? Number(rawRetry) : /^[A-Za-z]{3},/.test(rawRetry) ? Math.ceil((Date.parse(rawRetry) - now) / 1000) : NaN;
      if (!Number.isFinite(seconds) || seconds > 86400) retryable = false;
      else retryAfterSeconds = Math.max(60, seconds);
    }
  }
  const detail = `Microsoft ${microsoftStatus}${microsoftCode ? ` · ${microsoftCode}` : ""}${microsoftInnerCode ? ` · ${microsoftInnerCode}` : ""}`;
  let message: string;
  switch (microsoftStatus) {
    case 400: message = "Microsoft rechazó el archivo o la solicitud. Revisa el formato del libro y vuelve a comprobar la conexión; los cambios web siguen guardados."; break;
    case 401: case 403: message = "Microsoft no autorizó la escritura. Vuelve a activar el envío web → Excel y confirma el permiso."; break;
    case 404: message = "Microsoft no encontró el libro al enviarlo. Comprueba que sigue disponible en OneDrive y vuelve a seleccionarlo."; break;
    case 409: case 412: message = "El Excel cambió o existe un conflicto de edición. Microsoft rechazó la escritura; vuelve a leer la versión actual antes de enviar."; break;
    case 423: message = "El libro está bloqueado para edición. Guarda y cierra el Excel original; se volverá a comprobar después de la espera indicada."; break;
    case 429: message = "Microsoft limitó temporalmente las solicitudes. Espera el plazo indicado antes de volver a comprobar la sincronización."; break;
    default: message = preserveJob ? "Microsoft no confirmó el envío. Se conserva pendiente para verificar sus bytes antes de repetir cualquier escritura." : "Microsoft rechazó el envío. Los cambios web siguen guardados; revisa el código indicado antes de reintentar.";
  }
  if (temporary && !retryable) message += " Microsoft indicó una espera no válida o superior a 24 horas; la automática queda pausada para revisión.";
  const body: GraphFailure = { error: `${message} (${detail})`, microsoftStatus, ...(microsoftCode ? { microsoftCode } : {}), ...(microsoftInnerCode ? { microsoftInnerCode } : {}), ...(requestId ? { requestId } : {}), retryable, ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}), ...(preserveJob ? { writePending: true } : {}), ...(microsoftStatus === 412 ? { requiresPull: true } : {}) };
  return { status: microsoftStatus === 401 || microsoftStatus === 403 ? 403 : microsoftStatus === 412 ? 409 : microsoftStatus >= 400 && microsoftStatus < 500 ? microsoftStatus : 502, preserveJob, body, ...(retryAfterSeconds !== undefined ? { retryAfter: String(retryAfterSeconds) } : {}) };
}
