import { parsePhotoKey, ValidationError } from "@/lib/validation";
import { type KeyParams, photoContext, route } from "../../_shared";

export async function GET(request: Request, args: KeyParams) {
  return route(async () => {
    const { bucket, ownerId } = await photoContext(request);
    const key = parsePhotoKey((await args.params).key);
    if (!key) throw new ValidationError("No se encontró la foto.", 404);
    const object = await bucket.get(`${ownerId}/${key}`);
    if (!object) throw new ValidationError("No se encontró la foto.", 404);
    return new Response(new Uint8Array(object.body), { headers: { "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream", "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'" } });
  });
}
