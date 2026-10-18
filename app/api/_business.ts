import { businessWriteStatements, readBusinessData } from "@/lib/business-import";
import { parseClient, parseInvoiceDraft, parseQuote } from "@/lib/business-validation";
import type { BusinessData } from "@/lib/business-types";
import { record, ValidationError } from "@/lib/validation";
import { body, context, isTransactionConflict, json, route } from "./_shared";

export function businessGet(request:Request,kind:keyof BusinessData){return route(async()=>{const{db,ownerId}=await context(request);return json({[kind]:(await readBusinessData(db,ownerId))[kind]});});}
export function businessSave(request:Request,kind:keyof BusinessData,create:boolean){return route(async()=>{
 const{db,ownerId}=await context(request,true),source=record(await body(request));
 const key=kind==="clients"?"client":kind==="quotes"?"quote":"draft";
 const parser=kind==="clients"?parseClient:kind==="quotes"?parseQuote:parseInvoiceDraft;
 const item=parser(source[key],create?"create":"update");
 try{await db.batch(businessWriteStatements(db,ownerId,kind,item,create?null:item.revision));}
 catch(error){if(isTransactionConflict(error))throw new ValidationError("El registro cambió, el ID ya existe o alguna referencia no es válida. Recarga y comprueba cliente y artículos. Un borrador emitido no puede modificarse.",409);throw error;}
 const data=await readBusinessData(db,ownerId);
 return json({[key]:data[kind].find(row=>row.id===item.id)},create?201:200);
});}
