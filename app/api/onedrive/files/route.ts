import { parseText } from "@/lib/validation";
import { context, json, route } from "../../_shared";
import { type DriveFile, graph, requireConfig } from "../_core";

export async function GET(request: Request) {
  return route(async () => {
    const { db, ownerId } = await context(request);
    const config = requireConfig(request);
    const query = parseText(new URL(request.url).searchParams.get("query") ?? "PROGRAMA", "Búsqueda", 80, true);
    const encoded = encodeURIComponent(query.replace(/'/g, "''"));
    const response = await graph(db, ownerId, config, `/me/drive/root/search(q='${encoded}')?$select=id,name,size,lastModifiedDateTime,webUrl,parentReference,file,remoteItem&$top=50`);
    const data = await response.json() as { value?: DriveFile[] };
    const files = (data.value ?? []).filter(item => item.file && !item.remoteItem && item.name?.toLowerCase().endsWith(".xlsx")).map(item => ({ id: item.id, name: item.name, size: item.size ?? 0, lastModifiedAt: item.lastModifiedDateTime ?? "", webUrl: item.webUrl ?? "", parentPath: item.parentReference?.path ?? "" }));
    return json({ files });
  });
}
