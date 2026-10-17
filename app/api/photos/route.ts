import { ValidationError } from "@/lib/validation";
import { boundedBody, json, photoContext, route } from "../_shared";

function imageType(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((v, i) => bytes[i] === v)) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0,4)) === "RIFF" && String.fromCharCode(...bytes.slice(8,12)) === "WEBP") return "image/webp";
  return null;
}

export async function POST(request: Request) {
  return route(async () => {
    const { bucket, ownerId } = await photoContext(request, true);
    const encodedForm = await boundedBody(request, 6 * 1024 * 1024, "La foto debe pesar como máximo 5 MB.");
    let form: FormData;
    try { form = await new Response(encodedForm, { headers: { "Content-Type": request.headers.get("content-type") ?? "" } }).formData(); } catch { throw new ValidationError("No se pudo leer la foto seleccionada."); }
    const file = form.get("file");
    if (!file || typeof file === "string" || typeof file.arrayBuffer !== "function") throw new ValidationError("Selecciona una foto para subir.");
    if (file.size <= 0 || file.size > 5 * 1024 * 1024) throw new ValidationError("La foto debe pesar entre 1 byte y 5 MB.", 413);
    const data = await file.arrayBuffer();
    const contentType = imageType(new Uint8Array(data));
    if (!contentType || (file.type && file.type !== contentType && file.type !== "application/octet-stream")) throw new ValidationError("Selecciona una imagen JPEG, PNG o WebP válida.");
    // Content-based UUID keeps repeat Excel imports idempotent. The owner
    // prefix in R2 remains the access boundary even when images are identical.
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
    const uuidBytes = digest.slice(0, 16);
    uuidBytes[6] = (uuidBytes[6] & 0x0f) | 0x80;
    uuidBytes[8] = (uuidBytes[8] & 0x3f) | 0x80;
    const hex = Array.from(uuidBytes, byte => byte.toString(16).padStart(2, "0")).join("");
    const photoKey = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    await bucket.put(`${ownerId}/${photoKey}`, data, { httpMetadata: { contentType }, customMetadata: { owner: ownerId } });
    return json({ photoKey }, 201);
  });
}
