import { parseText, ValidationError } from "@/lib/validation";
import { context, json, route } from "../../_shared";
import { type DriveFile, graph, requireConfig } from "../_core";

export async function GET(request: Request) {
  return route(async () => {
    const { db, ownerId } = await context(request);
    const config = requireConfig(request);
    const query = parseText(new URL(request.url).searchParams.get("query") ?? "PROGRAMA", "Búsqueda o ruta", 300, true);
    if (query.includes("\\")) throw new ValidationError("La ruta de OneDrive debe usar / entre carpetas, sin barras invertidas.");
    const select = "id,name,size,lastModifiedDateTime,webUrl,parentReference,file,remoteItem";
    let items: DriveFile[];
    if (query.includes("/")) {
      const segments = (query.startsWith("/") ? query.slice(1) : query).split("/");
      if (segments.some(segment => !segment.trim() || segment === "." || segment === "..")) throw new ValidationError("Escribe la ruta desde Mis archivos, sin carpetas vacías ni segmentos «.» o «..».");
      const path = segments.map(segment => encodeURIComponent(segment)).join("/");
      const response = await graph(db, ownerId, config, `/me/drive/root:/${path}?$select=${select}`);
      items = [await response.json() as DriveFile];
    } else {
      const encoded = encodeURIComponent(query.replace(/'/g, "''"));
      const response = await graph(db, ownerId, config, `/me/drive/root/search(q='${encoded}')?$select=${select}&$top=50`);
      const data = await response.json() as { value?: DriveFile[] };
      items = data.value ?? [];
    }
    const files = items.filter(item => item.file && !item.remoteItem && item.name?.toLowerCase().endsWith(".xlsx")).map(item => ({ id: item.id, name: item.name, size: item.size ?? 0, lastModifiedAt: item.lastModifiedDateTime ?? "", webUrl: item.webUrl ?? "", parentPath: item.parentReference?.path ?? "" }));
    return json({ files });
  });
}
