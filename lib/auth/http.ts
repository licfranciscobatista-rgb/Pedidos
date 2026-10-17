import { AuthError } from "./session";
import { authConfiguration, type AuthConfiguration } from "./config";

export function requireAuthConfig(request: Request): AuthConfiguration {
  const config = authConfiguration(process.env);
  if (!config) throw new AuthError("El acceso está pendiente de configuración.", 503);
  if (request.headers.get("origin") !== config.appOrigin) throw new AuthError("Abre esta acción desde Mi encargo.", 403);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new AuthError("Revisa los datos de acceso.", 415);
  return config;
}
export async function authBody(request: Request): Promise<Record<string, unknown>> {
  if (Number(request.headers.get("content-length") ?? 0) > 8192) throw new AuthError("La solicitud es demasiado grande.", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new AuthError("Completa los datos de acceso.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 8192) { await reader.cancel(); throw new AuthError("La solicitud es demasiado grande.", 413); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid_body");
    return parsed as Record<string, unknown>;
  } catch { throw new AuthError("Revisa los datos de acceso."); }
}
export function authJson(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", ...headers } });
}
export async function authRoute(action: () => Promise<Response>): Promise<Response> {
  try { return await action(); }
  catch (error) {
    if (error instanceof AuthError) return authJson({ error: error.message }, error.status, error.retryAfter ? { "Retry-After": String(error.retryAfter) } : {});
    // Never include request bodies, password hashes or installation/session tokens in logs.
    return authJson({ error: "No pudimos completar el acceso. Inténtalo nuevamente." }, 503);
  }
}
