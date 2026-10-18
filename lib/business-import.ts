import { createHash } from "node:crypto";
import type { Database, PreparedStatement } from "./db";
import type { BusinessData, Client, Quote, InvoiceDraft } from "./business-types";
import { parseBusinessImport } from "./business-validation";
import { ValidationError } from "./validation";

export const CLIENT_COLUMNS = `id,name,phone,email,address,notes,active,revision,created_at AS "createdAt",updated_at AS "updatedAt"`;
export const QUOTE_COLUMNS = `q.id,q.client_id AS "clientId",q.date,q.valid_until AS "validUntil",q.status,q.notes,q.revision,q.total_cents AS "totalCents",q.created_at AS "createdAt",q.updated_at AS "updatedAt",COALESCE((SELECT jsonb_agg(jsonb_build_object('id',i.id,'article',i.article,'variant',i.variant,'platform',i.platform,'quantity',i.quantity,'unitCents',i.unit_cents,'extraCents',i.extra_cents,'discountCents',i.discount_cents) ORDER BY position) FROM quote_items i WHERE i.owner_id=q.owner_id AND i.quote_id=q.id),'[]'::jsonb) AS items`;
export const DRAFT_COLUMNS = `d.id,d.client_id AS "clientId",d.date,d.business_name AS "businessName",d.notes,d.pricing_mode AS "pricingMode",d.manual_total_cents AS "manualTotalCents",d.show_amounts AS "showAmounts",d.revision,COALESCE(d.issued_invoice_id,'') AS "issuedInvoiceId",d.created_at AS "createdAt",d.updated_at AS "updatedAt",COALESCE((SELECT jsonb_agg(jsonb_build_object('orderId',i.order_id,'deliveryLabel',i.delivery_label) ORDER BY position) FROM invoice_draft_items i WHERE i.owner_id=d.owner_id AND i.draft_id=d.id),'[]'::jsonb) AS items`;
export function businessReadStatements(db: Database, ownerId: string) { return [db.prepare(`SELECT ${CLIENT_COLUMNS} FROM clients WHERE owner_id=$1 ORDER BY name,id`).bind(ownerId),db.prepare(`SELECT ${QUOTE_COLUMNS} FROM quotes q WHERE owner_id=$1 ORDER BY date DESC,id DESC`).bind(ownerId),db.prepare(`SELECT ${DRAFT_COLUMNS} FROM invoice_drafts d WHERE owner_id=$1 ORDER BY date DESC,id DESC`).bind(ownerId)]; }
export async function readBusinessData(db: Database, ownerId: string): Promise<BusinessData> { const data=await db.batch(businessReadStatements(db,ownerId));return {clients:data[0].results as Client[],quotes:data[1].results as Quote[],invoiceDrafts:data[2].results as InvoiceDraft[]}; }
type Kind=keyof BusinessData;
type Entity=Client|Quote|InvoiceDraft;
const tables={clients:"clients",quotes:"quotes",invoiceDrafts:"invoice_drafts"};
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;if(value&&typeof value==="object")return `{${Object.keys(value).sort().map(key=>JSON.stringify(key)+":"+canonical((value as Record<string,unknown>)[key])).join(",")}}`;return JSON.stringify(value); }
export function businessFingerprint(kind: Kind, value: Entity): string {
 const input=parseBusinessImport({[kind]:[{...value,revision:0}]})[kind][0];const clean={...input} as Record<string,unknown>;delete clean.revision;
 // Item IDs define membership. Excel may reuse physical gaps when a line is
 // replaced; row order alone does not change a quote's or draft's meaning.
 if(kind==="quotes")clean.items=[...(input as Quote).items].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
 if(kind==="invoiceDrafts")clean.items=[...(input as InvoiceDraft).items].sort((a,b)=>a.orderId<b.orderId?-1:a.orderId>b.orderId?1:0);
 return createHash("sha256").update(canonical(clean)).digest("hex");
}
function assertion(db: Database, condition: string, values: unknown[]) {return db.prepare(`SELECT (${condition}) AS ok`).bind(...values).asAssertion();}
export function businessWriteStatements(db: Database, ownerId: string, kind:Kind, item:Entity, expectedRevision:number|null):PreparedStatement[] {
  const now=new Date().toISOString(), table=tables[kind];
  const result=[assertion(db,expectedRevision===null?`NOT EXISTS(SELECT 1 FROM ${table} WHERE owner_id=$1 AND id=$2)`:`EXISTS(SELECT 1 FROM ${table} WHERE owner_id=$1 AND id=$2 AND revision=$3${kind==="invoiceDrafts"?" AND issued_invoice_id IS NULL":""})`,expectedRevision===null?[ownerId,item.id]:[ownerId,item.id,expectedRevision])];
  if(kind==="clients"){
    const c=item as Client;
    result.push(db.prepare(`INSERT INTO clients(owner_id,id,name,phone,email,address,notes,active,revision,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$9) ON CONFLICT(owner_id,id) DO UPDATE SET name=excluded.name,phone=excluded.phone,email=excluded.email,address=excluded.address,notes=excluded.notes,active=excluded.active,revision=clients.revision+1,updated_at=excluded.updated_at`).bind(ownerId,c.id,c.name,c.phone,c.email,c.address,c.notes,c.active,now));
  }else if(kind==="quotes"){
    const q=item as Quote;
    result.push(assertion(db,`EXISTS(SELECT 1 FROM clients WHERE owner_id=$1 AND id=$2)`,[ownerId,q.clientId]));
    result.push(db.prepare(`INSERT INTO quotes(owner_id,id,client_id,date,valid_until,status,notes,revision,total_cents,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$9) ON CONFLICT(owner_id,id) DO UPDATE SET client_id=excluded.client_id,date=excluded.date,valid_until=excluded.valid_until,status=excluded.status,notes=excluded.notes,total_cents=excluded.total_cents,revision=quotes.revision+1,updated_at=excluded.updated_at`).bind(ownerId,q.id,q.clientId,q.date,q.validUntil,q.status,q.notes,q.totalCents,now));
    result.push(db.prepare(`DELETE FROM quote_items WHERE owner_id=$1 AND quote_id=$2`).bind(ownerId,q.id));
    for(const [position,line]of q.items.entries())result.push(db.prepare(`INSERT INTO quote_items(owner_id,quote_id,id,position,article,variant,platform,quantity,unit_cents,extra_cents,discount_cents) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`).bind(ownerId,q.id,line.id,position,line.article,line.variant,line.platform,line.quantity,line.unitCents,line.extraCents,line.discountCents));
  }else{
    const d=item as InvoiceDraft;
    result.push(assertion(db,`EXISTS(SELECT 1 FROM clients WHERE owner_id=$1 AND id=$2) AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text($3::jsonb) i WHERE NOT EXISTS(SELECT 1 FROM orders o JOIN clients c ON c.owner_id=o.owner_id AND c.id=$2 WHERE o.owner_id=$1 AND o.id=i.value AND o.status<>'Cancelado' AND (o.client_id=c.id OR (o.client_id IS NULL AND lower(trim(o.client))=lower(trim(c.name)) AND regexp_replace(o.phone,'[^0-9]','','g')=regexp_replace(c.phone,'[^0-9]','','g') AND (SELECT count(*) FROM clients possible WHERE possible.owner_id=o.owner_id AND lower(trim(possible.name))=lower(trim(o.client)) AND regexp_replace(possible.phone,'[^0-9]','','g')=regexp_replace(o.phone,'[^0-9]','','g'))=1))))`,[ownerId,d.clientId,JSON.stringify(d.items.map(i=>i.orderId))]));
    result.push(db.prepare(`INSERT INTO invoice_drafts(owner_id,id,client_id,date,business_name,notes,pricing_mode,manual_total_cents,show_amounts,revision,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$10) ON CONFLICT(owner_id,id) DO UPDATE SET client_id=excluded.client_id,date=excluded.date,business_name=excluded.business_name,notes=excluded.notes,pricing_mode=excluded.pricing_mode,manual_total_cents=excluded.manual_total_cents,show_amounts=excluded.show_amounts,revision=invoice_drafts.revision+1,updated_at=excluded.updated_at`).bind(ownerId,d.id,d.clientId,d.date,d.businessName,d.notes,d.pricingMode,d.manualTotalCents,d.showAmounts,now));
    result.push(db.prepare(`DELETE FROM invoice_draft_items WHERE owner_id=$1 AND draft_id=$2`).bind(ownerId,d.id));
    for(const [position,line]of d.items.entries())result.push(db.prepare(`INSERT INTO invoice_draft_items(owner_id,draft_id,order_id,position,delivery_label) VALUES($1,$2,$3,$4,$5)`).bind(ownerId,d.id,line.orderId,position,line.deliveryLabel));
  }
  result.push(db.prepare(`INSERT INTO activities(owner_id,id,at,kind,client,summary,detail) VALUES($1,$2,$3,$4,$5,$6,$7)`).bind(ownerId,crypto.randomUUID(),now,kind==="clients"?"Cliente registrado":kind==="quotes"?"Cotización guardada":"Borrador guardado",kind==="clients"?(item as Client).name:"",`${expectedRevision===null?"Registro creado":"Registro actualizado"}: ${item.id}`,`Sección: ${kind}. ID: ${item.id}`));
  return result;
}
export async function prepareBusinessImport(db:Database,ownerId:string,value:unknown,options:{sourceFileId?:string}={}){
  const input=parseBusinessImport(value),current=await readBusinessData(db,ownerId),fileId=options.sourceFileId??"";
  const baselines=fileId?(await db.prepare(`SELECT kind,id,fingerprint,local_revision AS revision FROM business_baselines WHERE owner_id=$1 AND file_id=$2`).bind(ownerId,fileId).all<{kind:Kind;id:string;fingerprint:string;revision:number}>()).results:[];
  const statements:PreparedStatement[]=[];
  const clientStatements:PreparedStatement[]=[],documentStatements:PreparedStatement[]=[];
  const summary={createdClients:0,updatedClients:0,unchangedClients:0,createdQuotes:0,updatedQuotes:0,unchangedQuotes:0,createdInvoiceDrafts:0,updatedInvoiceDrafts:0,unchangedInvoiceDrafts:0};
  for(const kind of ["clients","quotes","invoiceDrafts"] as const)for(const item of input[kind]){
    const start=statements.length;
    const existing=current[kind].find(row=>row.id===item.id) as Entity|undefined,hash=businessFingerprint(kind,item),same=existing&&hash===businessFingerprint(kind,existing),baseline=baselines.find(row=>row.kind===kind&&row.id===item.id);
    const remoteUnchanged=Boolean(fileId&&baseline?.fingerprint===hash);
    const expected=existing?.revision??null,willWrite=!same&&!remoteUnchanged;
    if(existing&&willWrite){if(kind==="invoiceDrafts"&&(existing as InvoiceDraft).issuedInvoiceId)throw new ValidationError(`Borrador ${item.id}: ya fue emitido y no puede modificarse. Crea otro ID.`,409);if(baseline?.revision!==existing.revision&&item.revision!==existing.revision)throw new ValidationError(`${item.id}: hay cambios en la web y en Excel. Actualiza la revisión o conserva los datos actuales antes de sincronizar.`,409);}
    if(willWrite)statements.push(...businessWriteStatements(db,ownerId,kind,item,expected));
    else if(existing&&!remoteUnchanged)statements.push(assertion(db,`EXISTS(SELECT 1 FROM ${tables[kind]} WHERE owner_id=$1 AND id=$2 AND revision=$3)`,[ownerId,item.id,existing.revision]));
    const suffix=kind==="clients"?"Clients":kind==="quotes"?"Quotes":"InvoiceDrafts";
    const key=`${willWrite?(existing?"updated":"created"):"unchanged"}${suffix}` as keyof typeof summary;summary[key]++;
    if(fileId&&!remoteUnchanged){
      // Guard the baseline read too: two browser syncs cannot silently regress it.
      statements.push(assertion(db,baseline?`EXISTS(SELECT 1 FROM business_baselines WHERE owner_id=$1 AND file_id=$2 AND kind=$3 AND id=$4 AND fingerprint=$5 AND local_revision=$6)`:`NOT EXISTS(SELECT 1 FROM business_baselines WHERE owner_id=$1 AND file_id=$2 AND kind=$3 AND id=$4)`,baseline?[ownerId,fileId,kind,item.id,baseline.fingerprint,baseline.revision]:[ownerId,fileId,kind,item.id]));
      statements.push(db.prepare(`INSERT INTO business_baselines(owner_id,file_id,kind,id,fingerprint,local_revision) SELECT $1,$2,$3,$4,$5,revision FROM ${tables[kind]} WHERE owner_id=$1 AND id=$4 ON CONFLICT(owner_id,file_id,kind,id) DO UPDATE SET fingerprint=excluded.fingerprint,local_revision=excluded.local_revision`).bind(ownerId,fileId,kind,item.id,hash));
    }
    (kind==="clients"?clientStatements:documentStatements).push(...statements.slice(start));
  }
  return{statements,clientStatements,documentStatements,summary};
}
