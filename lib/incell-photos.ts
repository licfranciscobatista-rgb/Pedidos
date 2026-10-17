import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";

type Node = Record<string, any>;
export type InCellPhoto = { row: number; column: number; name: string; blob: Blob };
const many = (value: any): any[] => value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, parseAttributeValue: false, processEntities: false });
const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
function parse(xml: string): Node {
  if (xml.length > 8 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("El Excel contiene metadatos de imagen no compatibles.");
  return parser.parse(xml);
}
function resolve(base: string, target: string): string {
  if (/^(?:[a-z]+:|\/\/)/i.test(target)) throw new Error("La foto debe estar guardada dentro del Excel, no enlazada desde Internet.");
  const parts = (target.startsWith("/") ? target.slice(1) : `${base.slice(0, base.lastIndexOf("/") + 1)}${target}`).split("/");
  const result: string[] = [];
  for (const p of parts) { if (p === "..") result.pop(); else if (p && p !== ".") result.push(p); }
  return result.join("/");
}
function findDeep(node: any, name: string): any {
  if (!node || typeof node !== "object") return undefined;
  if (node[name] !== undefined) return node[name];
  for (const value of Object.values(node)) { for (const child of many(value)) { const match = findDeep(child, name); if (match !== undefined) return match; } }
}
function imageType(bytes: Uint8Array): string {
  if (bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP") return "image/webp";
  throw new Error("Una foto dentro de celda no está en formato PNG, JPG o WebP. Conviértela antes de subir el Excel.");
}

/** Resolve Microsoft's local in-cell images through metadata, rich values and package relationships. */
export async function readInCellPhotos(bytes: ArrayBuffer, sheetName: string): Promise<InCellPhoto[]> {
  const zip = await JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files);
  if (names.some(n => /^xl\/cellimages\.xml$/i.test(n))) throw new Error("Las imágenes de WPS no son compatibles todavía. Guarda una copia en Excel con las fotos insertadas dentro de las celdas o sobre ellas.");
  const valuePath = names.find(n => /\/rdrichvalue\.xml$/i.test(n));
  if (!valuePath) return [];
  const get = async (path: string) => {
    const file = zip.file(path);
    if (!file) throw new Error("Falta una referencia interna de una foto. Vuelve a guardar el archivo desde Excel.");
    return parse(await file.async("string"));
  };
  const structurePath = names.find(n => /\/rdrichvaluestructure\.xml$/i.test(n));
  if (!structurePath) throw new Error("No se puede leer la estructura de las fotos en celda.");
  const structures = many((await get(structurePath)).rvStructures?.s);
  if (!structures.some(s => s["@_t"] === "_localImage")) {
    if (structures.some(s => s["@_t"] === "_webimage")) throw new Error("Hay fotos enlazadas desde Internet. Inserta las imágenes en el archivo antes de subirlo.");
    return [];
  }
  const relPath = names.find(n => /\/richValueRel\.xml$/i.test(n));
  if (!relPath) throw new Error("El Excel no conserva las referencias de las imágenes en celda.");
  const relationsPath = `${relPath.slice(0, relPath.lastIndexOf("/"))}/_rels/${relPath.slice(relPath.lastIndexOf("/") + 1)}.rels`;
  const rels = many((await get(relPath)).richValueRels?.rel);
  const imageRelations = many((await get(relationsPath)).Relationships?.Relationship);
  const values = many((await get(valuePath)).rvData?.rv);
  const metadata = (await get("xl/metadata.xml")).metadata;
  const types = many(metadata?.metadataTypes?.metadataType);
  const richType = types.findIndex(t => t["@_name"] === "XLRICHVALUE") + 1;
  const future = many(metadata?.futureMetadata).find(f => f["@_name"] === "XLRICHVALUE");
  const futureBlocks = many(future?.bk);
  const valueBlocks = many(metadata?.valueMetadata?.bk);
  const workbook = (await get("xl/workbook.xml")).workbook;
  const sheet = many(workbook?.sheets?.sheet).find(s => decode(String(s["@_name"])) === sheetName);
  if (!sheet) return [];
  const workbookRels = many((await get("xl/_rels/workbook.xml.rels")).Relationships?.Relationship);
  const sheetRelation = workbookRels.find(r => r["@_Id"] === sheet["@_id"]);
  if (!sheetRelation || sheetRelation["@_TargetMode"] === "External") throw new Error("No se puede leer la hoja de las fotografías.");
  const cells = many((await get(resolve("xl/workbook.xml", sheetRelation["@_Target"]))).worksheet?.sheetData?.row).flatMap(r => many(r.c));
  const result: InCellPhoto[] = [];
  for (const cell of cells) {
    if (!cell["@_vm"]) continue;
    const rc = many(valueBlocks[Number(cell["@_vm"]) - 1]?.rc).find(r => Number(r["@_t"]) === richType);
    if (!rc) continue;
    const block = findDeep(futureBlocks[Number(rc["@_v"])], "rvb");
    const rv = values[Number(block?.["@_i"])];
    const structure = structures[Number(rv?.["@_s"])];
    if (structure?.["@_t"] !== "_localImage") throw new Error("La celda Foto contiene una imagen enlazada u otro dato enriquecido. Inserta la imagen directamente en Excel.");
    const keyIndex = many(structure.k).findIndex(k => k["@_n"] === "_rvRel:LocalImageIdentifier");
    const relationIndex = Number(many(rv.v)[keyIndex]);
    const relationship = imageRelations.find(r => r["@_Id"] === rels[relationIndex]?.["@_id"]);
    if (!relationship || relationship["@_TargetMode"] === "External") throw new Error("No se encuentra una foto dentro del Excel.");
    const imagePath = resolve(relPath, relationship["@_Target"]);
    const image = zip.file(imagePath);
    if (!image) throw new Error("Una foto está referenciada pero falta en el archivo.");
    const imageBytes = await image.async("uint8array");
    if (imageBytes.byteLength > 5 * 1024 * 1024) throw new Error("Una foto supera 5 MB.");
    const address = /^([A-Z]+)(\d+)$/.exec(String(cell["@_r"]));
    if (!address) throw new Error("La foto no tiene una celda de origen válida.");
    const column = [...address[1]].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
    const copy = new Uint8Array(imageBytes).buffer;
    result.push({ row: Number(address[2]), column, name: imagePath.split("/").pop()!, blob: new Blob([copy], { type: imageType(imageBytes) }) });
  }
  return result;
}
