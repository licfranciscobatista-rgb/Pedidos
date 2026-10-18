import JSZip from "jszip";
import { createHash } from "node:crypto";
import { getPhotoBucket, type PhotoBucket } from "@/lib/photos";
import type { Order } from "./types";
import { parseId, parsePhotoKey, ValidationError } from "./validation";

export type OrderPhoto = { orderId: string; bytes: Uint8Array; contentType: string; remove?: false } | {orderId:string;remove:true};
const NS_DRAWING = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing";
const NS_MAIN = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_PACKAGE = "http://schemas.openxmlformats.org/package/2006/relationships";
const MAX_BYTES = 5 * 1024 * 1024;
const escape = (value: string) => value.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
const decode = (value: string) => value.replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&amp;/g,"&");
const attr = (xml:string,name:string) => decode(new RegExp(`(?:^|\\s)${name}=["']([^"']*)["']`).exec(xml)?.[1]||"");
const normalized = (value:string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/\s+/g,"");
const cells = (xml:string) => [...xml.matchAll(/<(?:\w+:)?c\b[^>]*?(?:\/>|>[\s\S]*?<\/(?:\w+:)?c>)/g)].map(match=>match[0]);
const number = (ref:string) => [...ref.replace(/\d/g,"")].reduce((total,char)=>total*26+char.charCodeAt(0)-64,0);
const letters = (value:number):string => value?letters(Math.floor((value-1)/26))+String.fromCharCode(65+(value-1)%26):"";
function resolve(base:string,target:string){if(/^(?:[a-z]+:|\/\/)/i.test(target))throw new ValidationError("El Excel tiene una referencia externa de dibujo no compatible.");const parts=(target.startsWith("/")?target.slice(1):`${base.slice(0,base.lastIndexOf("/")+1)}${target}`).split("/"),out:string[]=[];for(const part of parts){if(part==="..")out.pop();else if(part&&part!==".")out.push(part);}return out.join("/");}
function relationships(xml:string){return [...xml.matchAll(/<(?:\w+:)?Relationship\b[^>]*\/>/g)].map(match=>({id:attr(match[0],"Id"),target:attr(match[0],"Target"),type:attr(match[0],"Type"),external:attr(match[0],"TargetMode")==="External"}));}
function addRelationship(xml:string,id:string,type:string,target:string){return xml.replace(/<\/(?:\w+:)?Relationships>/,`<Relationship Id="${escape(id)}" Type="${escape(type)}" Target="${escape(target)}"/></Relationships>`);}
function namespaces(xml:string,tag:string){return xml.replace(new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>`),open=>{let result=open.slice(0,-1);for(const[key,value]of[["xdr",NS_DRAWING],["a",NS_MAIN],["r",NS_REL]])if(!new RegExp(`\\bxmlns:${key}=`).test(open))result+=` xmlns:${key}="${value}"`;return result+">";});}
const emptyRels = () => `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${NS_PACKAGE}"></Relationships>`;

/** Only the explicit order's Foto cell is replaced. All unrelated ZIP parts,
 * drawings and images survive byte-for-byte, including rich image metadata. */
export async function embedOrderPhotos(source:Uint8Array|ArrayBuffer,photos:OrderPhoto[]):Promise<Uint8Array>{
 const original=source instanceof Uint8Array?source:new Uint8Array(source);
 if(!photos.length)return original;
 if(original.byteLength>MAX_BYTES)throw new ValidationError("El Excel supera 5 MB. Divide el libro antes de añadir fotos.",413);
 if(photos.length>1500||new Set(photos.map(photo=>photo.orderId)).size!==photos.length)throw new ValidationError("Envía una sola foto por ID Pedido.");
 if(photos.reduce((sum,photo)=>sum+(photo.remove?0:photo.bytes.byteLength),0)>MAX_BYTES)throw new ValidationError("Las fotos juntas superan 5 MB. Envíalas en libros más pequeños.",413);
 for(const photo of photos){parseId(photo.orderId,"ID Pedido de foto");if(photo.remove)continue;const png=photo.bytes.length>=8&&[137,80,78,71,13,10,26,10].every((value,index)=>photo.bytes[index]===value),jpg=photo.bytes.length>=3&&photo.bytes[0]===255&&photo.bytes[1]===216&&photo.bytes[2]===255;if(!photo.bytes.length||photo.bytes.length>MAX_BYTES)throw new ValidationError(`${photo.orderId}: la foto supera 5 MB.`,413);if(!((png&&photo.contentType==="image/png")||(jpg&&photo.contentType==="image/jpeg")))throw new ValidationError(`${photo.orderId}: para enviar fotos a Excel usa JPG o PNG. Convierte la foto WebP antes de sincronizar.`);}
 const zip=await JSZip.loadAsync(original);
 if(Object.keys(zip.files).length>5000)throw new ValidationError("El libro contiene demasiados elementos internos.");
 const read=async(path:string,required=true)=>{const entry=zip.file(path);if(!entry){if(required)throw new ValidationError(`Falta una parte del libro: ${path}.`);return"";}const text=await entry.async("string");if(text.length>8*1024*1024||/<!DOCTYPE|<!ENTITY/i.test(text))throw new ValidationError("El libro contiene XML no compatible.");return text;};
 const workbook=await read("xl/workbook.xml"),wbRels=relationships(await read("xl/_rels/workbook.xml.rels"));
 const sheet=[...workbook.matchAll(/<(?:\w+:)?sheet\b[^>]*\/>/g)].find(match=>normalized(attr(match[0],"name"))==="pedidos")?.[0];
 const sheetRel=sheet&&wbRels.find(rel=>rel.id===attr(sheet,"r:id"));if(!sheetRel||sheetRel.external)throw new ValidationError("No se encuentra la hoja Pedidos para guardar las fotos.");
 const sheetPath=resolve("xl/workbook.xml",sheetRel.target),sheetRelsPath=sheetPath.replace(/([^/]+)$/, "_rels/$1.rels");
 let sheetXml=await read(sheetPath),sheetRels=await read(sheetRelsPath,false)||emptyRels();
 const shared=await read("xl/sharedStrings.xml",false);
 const richText=(xml:string)=>[...xml.matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g)].map(match=>decode(match[1])).join("");
 const strings=[...shared.matchAll(/<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/g)].map(match=>richText(match[1]));
 const text=(cell:string)=>attr(cell,"t")==="s"?strings[Number(/<(?:\w+:)?v\b[^>]*>([^<]*)</.exec(cell)?.[1]||"-1")]||"":attr(cell,"t")==="inlineStr"?richText(cell):decode(/<(?:\w+:)?v\b[^>]*>([^<]*)</.exec(cell)?.[1]||"");
 const rows=[...sheetXml.matchAll(/<(?:\w+:)?row\b[^>]*?(?:\/>|>[\s\S]*?<\/(?:\w+:)?row>)/g)].map(match=>match[0]);
 let header=0,idColumn=0,photoColumn=0;
 for(const row of rows){const rowNumber=Number(attr(row,"r"));if(rowNumber>30)continue;const rowCells=cells(row);const id=rowCells.find(cell=>normalized(text(cell))==="idpedido"),photo=rowCells.find(cell=>normalized(text(cell))==="foto");if(id&&photo){header=rowNumber;idColumn=number(attr(id,"r"));photoColumn=number(attr(photo,"r"));break;}}
 if(!header)throw new ValidationError("Pedidos necesita las columnas ID Pedido y Foto.");
 const targets=new Map<string,{row:number;xml:string}>();
 for(const row of rows){const rowNumber=Number(attr(row,"r"));if(rowNumber<=header)continue;const id=text(cells(row).find(cell=>number(attr(cell,"r"))===idColumn)||"");if(!id)continue;if(targets.has(id))throw new ValidationError(`Pedidos: ID duplicado ${id}.`);targets.set(id,{row:rowNumber,xml:row});}
 const drawingTag=/<(?:\w+:)?drawing\b[^>]*\/>/.exec(sheetXml)?.[0];
 const existingDrawingRel=drawingTag&&relationships(sheetRels).find(rel=>rel.id===attr(drawingTag,"r:id"));
 if(drawingTag&&(!existingDrawingRel||existingDrawingRel.external))throw new ValidationError("No se puede conservar la referencia de dibujo de Pedidos.");
 let drawingPath=existingDrawingRel?resolve(sheetPath,existingDrawingRel.target):"";
 if(!drawingPath){let index=1;while(zip.file(`xl/drawings/miEncargoPhotos${index}.xml`))index++;drawingPath=`xl/drawings/miEncargoPhotos${index}.xml`;}
 let drawing=existingDrawingRel?await read(drawingPath):`<?xml version="1.0" encoding="UTF-8"?><xdr:wsDr xmlns:xdr="${NS_DRAWING}" xmlns:a="${NS_MAIN}" xmlns:r="${NS_REL}"></xdr:wsDr>`;
 const drawingRelsPath=drawingPath.replace(/([^/]+)$/,"_rels/$1.rels");let drawingRels=await read(drawingRelsPath,false)||emptyRels();
 const mediaByHash=new Map<string,string>();
 if(photos.some(photo=>!photo.remove))for(const path of Object.keys(zip.files).filter(path=>/^xl\/media\/[a-zA-Z0-9]+\.(?:png|jpe?g)$/i.test(path))){const data=await zip.file(path)!.async("uint8array");if(data.byteLength>MAX_BYTES)continue;mediaByHash.set(createHash("sha256").update(data).digest("hex"),path);}
 let modified=false;
 for(const photo of photos){
  const target=targets.get(photo.orderId);if(!target)throw new ValidationError(`${photo.orderId}: no se encuentra la fila del pedido para insertar su foto.`);
  const marker=`mi-encargo:${photo.orderId}`;
  const anchors=[...drawing.matchAll(/<(?:\w+:)?(?:twoCellAnchor|oneCellAnchor|absoluteAnchor)\b[^>]*>[\s\S]*?<\/(?:\w+:)?(?:twoCellAnchor|oneCellAnchor|absoluteAnchor)>/g)].map(match=>match[0]);
  const position=(anchor:string)=>{const from=/<(?:\w+:)?from\b[^>]*>([\s\S]*?)<\/(?:\w+:)?from>/.exec(anchor)?.[1]||"";return{row:Number(/<(?:\w+:)?row>(\d+)</.exec(from)?.[1]??-1),column:Number(/<(?:\w+:)?col>(\d+)</.exec(from)?.[1]??-1)};};
  for(const anchor of anchors){const at=position(anchor),nv=/<(?:\w+:)?cNvPr\b[^>]*\/>/.exec(anchor)?.[0]||"",name=attr(nv,"name");if(at.row===target.row-1&&at.column===photoColumn-1&&name.startsWith("mi-encargo:")&&name!==marker)throw new ValidationError(`${photo.orderId}: hay una foto identificada como otro pedido en esa celda. Reubica las fotos en Excel antes de sincronizar.`,409);}
  if(photo.remove){
   let changed=false;
   for(const anchor of anchors){const location=position(anchor),nv=/<(?:\w+:)?cNvPr\b[^>]*\/>/.exec(anchor)?.[0]||"";if(attr(nv,"name")===marker||(location.row===target.row-1&&location.column===photoColumn-1)){drawing=drawing.replace(anchor,"");changed=true;}}
   const ref=`${letters(photoColumn)}${target.row}`,oldCell=cells(target.xml).find(cell=>attr(cell,"r")===ref);
   if(oldCell&&(text(oldCell)||/\s(?:vm|cm)=|<(?:\w+:)?f\b/.test(oldCell))){const prefix=/<(\w+:)?worksheet\b/.exec(sheetXml)?.[1]||"",attributes=(/<(?:\w+:)?c\b([^>]*?)(?:\/?>)/.exec(oldCell)?.[1]||` r="${ref}"`).replace(/\s(?:vm|cm|t)=["'][^"']*["']/g,"");const row=target.xml.replace(oldCell,`<${prefix}c${attributes}/>`);sheetXml=sheetXml.replace(target.xml,row);target.xml=row;changed=true;}
   if(changed)modified=true;
   continue;
  }
  const hash=createHash("sha256").update(photo.bytes).digest("hex");
  const owned=anchors.find(anchor=>{const nv=/<(?:\w+:)?cNvPr\b[^>]*\/>/.exec(anchor)?.[0]||"";const location=position(anchor);return attr(nv,"name")===marker&&attr(nv,"descr")===hash&&location.row===target.row-1&&location.column===photoColumn-1;});
  if(owned&&mediaByHash.has(hash))continue;
  // Replace the target cell's own photo; keep all other anchors/media intact.
  for(const anchor of anchors){const location=position(anchor),nv=/<(?:\w+:)?cNvPr\b[^>]*\/>/.exec(anchor)?.[0]||"";if(attr(nv,"name")===marker||(location.row===target.row-1&&location.column===photoColumn-1))drawing=drawing.replace(anchor,"");}
  const extension=photo.contentType==="image/png"?"png":"jpeg",mediaPath=mediaByHash.get(hash)||`xl/media/miEncargo${hash}.${extension}`;
  if(!zip.file(mediaPath)){zip.file(mediaPath,photo.bytes);mediaByHash.set(hash,mediaPath);}
  let relation=relationships(drawingRels).find(rel=>!rel.external&&resolve(drawingPath,rel.target)===mediaPath)?.id;
  if(!relation){let index=1;while(relationships(drawingRels).some(rel=>rel.id===`rIdMiEncargoImage${index}`))index++;relation=`rIdMiEncargoImage${index}`;drawingRels=addRelationship(drawingRels,relation,`${NS_REL}/image`,`../media/${mediaPath.slice(mediaPath.lastIndexOf("/")+1)}`);}
  const ids=[...drawing.matchAll(/<(?:\w+:)?cNvPr\b[^>]*\/>/g)].map(match=>Number(attr(match[0],"id")));const id=Math.max(0,...ids)+1;
  const anchor=`<xdr:twoCellAnchor editAs="oneCell"><xdr:from><xdr:col>${photoColumn-1}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${target.row-1}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>${photoColumn}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${target.row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${id}" name="${escape(marker)}" descr="${hash}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="${relation}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:twoCellAnchor>`;
  drawing=namespaces(drawing,"wsDr").replace(/<\/(?:\w+:)?wsDr>/,`${anchor}$&`);
  // A rich in-cell photo is superseded only for this explicitly changed order.
  const ref=`${letters(photoColumn)}${target.row}`;let row=target.xml;
  const oldCell=cells(row).find(cell=>attr(cell,"r")===ref);
  const uuidBytes=Buffer.from(hash,"hex").subarray(0,16);uuidBytes[6]=(uuidBytes[6]&0x0f)|0x80;uuidBytes[8]=(uuidBytes[8]&0x3f)|0x80;const h=uuidBytes.toString("hex"),photoKey=`${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
  const oldKey=oldCell?text(oldCell):"";
  const storedKey=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(oldKey)?oldKey:photoKey;
  const prefix=/<(\w+:)?worksheet\b/.exec(sheetXml)?.[1]||"";
  const attributes=oldCell?(/<(?:\w+:)?c\b([^>]*?)(?:\/?>)/.exec(oldCell)?.[1]||` r="${ref}"`).replace(/\s(?:vm|cm|t)=["'][^"']*["']/g,""):` r="${ref}"`;
  const replacement=`<${prefix}c${attributes} t="inlineStr"><${prefix}is><${prefix}t>${storedKey}</${prefix}t></${prefix}is></${prefix}c>`;
  if(oldCell)row=row.replace(oldCell,replacement);else{const rowCells=cells(row),body=[...rowCells,replacement].sort((a,b)=>number(attr(a,"r"))-number(attr(b,"r"))).join(""),open=/^<(?:\w+:)?row\b[^>]*>/.exec(row)?.[0]||`<${prefix}row r="${target.row}">`;const other=row.replace(/^<(?:\w+:)?row\b[^>]*>/,"").replace(/<\/(?:\w+:)?row>$/,"").replace(/<(?:\w+:)?c\b[^>]*?(?:\/>|>[\s\S]*?<\/(?:\w+:)?c>)/g,"");row=open+body+other+`</${prefix}row>`;}
  const open=/^<(?:\w+:)?row\b[^>]*>/.exec(row)?.[0];if(open){const newOpen=open.replace(/\s(?:ht|customHeight)=["'][^"']*["']/g,"").replace(/>$/,' ht="80" customHeight="1">');row=row.replace(open,newOpen);}
  sheetXml=sheetXml.replace(target.xml,row);target.xml=row;modified=true;
 }
 if(!modified)return original;
 const hasDrawing=Boolean(existingDrawingRel)||/<(?:\w+:)?(?:twoCellAnchor|oneCellAnchor|absoluteAnchor)\b/.test(drawing);
 if(!existingDrawingRel&&hasDrawing){let index=1;while(relationships(sheetRels).some(rel=>rel.id===`rIdMiEncargoDrawing${index}`))index++;const relation=`rIdMiEncargoDrawing${index}`;sheetRels=addRelationship(sheetRels,relation,`${NS_REL}/drawing`,`../drawings/${drawingPath.slice(drawingPath.lastIndexOf("/")+1)}`);const prefix=/<(\w+:)?worksheet\b/.exec(sheetXml)?.[1]||"";sheetXml=namespaces(sheetXml,"worksheet").replace(/<\/(?:\w+:)?worksheet>/,`<${prefix}drawing r:id="${relation}"/>$&`);}
 let contentTypes=await read("[Content_Types].xml");
 if(hasDrawing&&!contentTypes.includes(`PartName="/${drawingPath}"`))contentTypes=contentTypes.replace(/<\/(?:\w+:)?Types>/,`<Override PartName="/${drawingPath}" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>$&`);
 for(const extension of new Set(photos.flatMap(photo=>photo.remove?[]:[photo.contentType==="image/png"?"png":"jpeg"])))if(!new RegExp(`Extension=["']${extension}["']`).test(contentTypes))contentTypes=contentTypes.replace(/<\/(?:\w+:)?Types>/,`<Default Extension="${extension}" ContentType="image/${extension}"/>$&`);
 zip.file(sheetPath,sheetXml);if(hasDrawing){zip.file(sheetRelsPath,sheetRels);zip.file(drawingPath,drawing);zip.file(drawingRelsPath,drawingRels);}zip.file("[Content_Types].xml",contentTypes);
 const output=await zip.generateAsync({type:"uint8array",compression:"DEFLATE"});if(output.byteLength>MAX_BYTES)throw new ValidationError("Las fotos harían que el Excel supere 5 MB. Reduce su tamaño o divide el libro.",413);return output;
}

/** Server-only wrapper: storage keys always retain the authenticated owner. */
export async function embedStoredOrderPhotos(source:Uint8Array|ArrayBuffer,ownerId:string,orders:Order[],providedBucket?:PhotoBucket):Promise<Uint8Array>{
 if(!orders.length)return source instanceof Uint8Array?source:new Uint8Array(source);
 if(!/^[a-zA-Z0-9_-]{1,100}$/.test(ownerId))throw new ValidationError("El propietario de las fotos no es válido.");
 const bucket=providedBucket??(orders.some(order=>order.photoKey)?await getPhotoBucket():undefined),photos:OrderPhoto[]=[];
 let size=0;
 for(const order of orders){if(!order.photoKey){photos.push({orderId:order.id,remove:true});continue;}const key=parsePhotoKey(order.photoKey),photo=await bucket!.get(`${ownerId}/${key}`);if(!photo)throw new ValidationError(`${order.id}: no se encontró su foto privada. Vuelve a subirla antes de enviar el Excel.`,409);if(!["image/jpeg","image/png"].includes(photo.httpMetadata.contentType))throw new ValidationError(`${order.id}: Excel necesita una foto JPG o PNG. Convierte y vuelve a subir esta foto antes de sincronizar.`,409);size+=photo.body.byteLength;if(size>MAX_BYTES)throw new ValidationError("Las fotos juntas superan 5 MB. Divide el libro o reduce las imágenes.",413);photos.push({orderId:order.id,bytes:photo.body,contentType:photo.httpMetadata.contentType});}
 return embedOrderPhotos(source,photos);
}



