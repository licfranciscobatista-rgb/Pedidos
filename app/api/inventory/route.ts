import { createHash } from 'node:crypto';
import { getPool } from '@/lib/db';
import { context, body, json, route } from '../_shared';
import { ValidationError } from '@/lib/validation';
import { validateState } from '@/public/caja/domain.mjs';
import { defaultStoreId, inventoryNamespace } from '@/public/caja/profiles.mjs';

export const dynamic='force-dynamic';
const validId=(v:unknown)=>typeof v==='string'&&/^[0-9a-f-]{36}$/i.test(v);
function storeOwnerId(ownerId:string,storeId:unknown){
 if(typeof storeId!=='string')throw new ValidationError('Selecciona un perfil de tienda válido.',400);
 // Keep existing Librería Valencia data under its original key; use a separate
 // owner namespace for every additional independent store profile.
 const namespace=inventoryNamespace(ownerId,storeId||defaultStoreId);
 if(!namespace)throw new ValidationError('Selecciona un perfil de tienda válido.',400);
 return namespace;
}
export async function GET(request:Request){return route(async()=>{
 const {ownerId:accountOwnerId}=await context(request);
 const db=getPool(),query=new URL(request.url).searchParams;
 const ownerId=storeOwnerId(accountOwnerId,query.get('storeId')||defaultStoreId);
 if(query.has('command')){await db.query("UPDATE inventory_commands SET status='expired',result_json=$3::jsonb WHERE owner_id=$1 AND id=$2 AND status='pending' AND expires_at<now()",[ownerId,query.get('command'),JSON.stringify({error:'La PC no confirmó a tiempo. La venta no se realizó.'})]);const r=await db.query('SELECT status,result_json AS result FROM inventory_commands WHERE owner_id=$1 AND id=$2',[ownerId,query.get('command')]);return json(r.rows[0]||{status:'missing'});}
 const r=await db.query('SELECT device_id AS "deviceId",version,state_json AS state,last_seen AS "lastSeen",updated_at AS "updatedAt",COALESCE(last_seen > now()-interval \'8 seconds\',false) AS available FROM inventory_primary WHERE owner_id=$1',[ownerId]);
 const row=r.rows[0];
 // Avoid transferring the full catalog for unchanged mobile polling.
 if(row&&query.get('version')===String(row.version))delete row.state;
 return json({ownerId:accountOwnerId,storeId:query.get('storeId')||defaultStoreId,primary:row||null});
});}
export async function POST(request:Request){return route(async()=>{
 const {ownerId:accountOwnerId}=await context(request,true),raw=await body(request) as Record<string,unknown>;
 const ownerId=storeOwnerId(accountOwnerId,raw.storeId||defaultStoreId);
 const db=getPool(),client=await db.connect();
 try{
 await client.query('BEGIN');await client.query("SET LOCAL lock_timeout='10s'");await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`inventory:${ownerId}`]);
 let result:unknown;
 const r=await client.query('SELECT * FROM inventory_primary WHERE owner_id=$1 FOR UPDATE',[ownerId]);const p=r.rows[0];
 if(raw.action==='register'){
   if(!validId(raw.deviceId))throw new ValidationError('Identificador del equipo inválido.');
   if(p&&p.device_id!==raw.deviceId)throw new ValidationError('Ya existe una PC principal. Abre esta instalación como celular / consulta o recupera el respaldo de la PC original.',409);
   await client.query('INSERT INTO inventory_primary(owner_id,device_id) VALUES($1,$2) ON CONFLICT(owner_id) DO NOTHING',[ownerId,raw.deviceId]);result={registered:true};
 }else if(raw.action==='sync'){
   if(!p||p.device_id!==raw.deviceId)throw new ValidationError('Este equipo no es la PC principal.',403);
   const s=raw.state as Record<string,unknown>|undefined;
   if(s){
     if(s.schema!==1||!Number.isSafeInteger(s.version)||!Array.isArray(s.products)||!Array.isArray(s.sales)||!Array.isArray(s.movements)||!Array.isArray(s.operations)||!s.shop)throw new ValidationError('El inventario enviado está incompleto.');
     try{validateState(s);}catch(e){throw new ValidationError(e instanceof Error?e.message:'Inventario inválido.');}
     const hash=createHash('sha256').update(JSON.stringify(s)).digest('hex');
     if(Number(s.version)<Number(p.version)||(Number(s.version)===Number(p.version)&&hash!==p.state_hash))throw new ValidationError('La copia de la nube es distinta. Conserva un respaldo y revisa antes de sincronizar.',409);
     if(p.state_json){const old=p.state_json;const ids=new Set((s.sales as {id:string}[]).map(x=>x.id));if(old.sales.some((x:{id:string})=>!ids.has(x.id))||old.operations.some((id:string)=>!(s.operations as string[]).includes(id)))throw new ValidationError('La sincronización no puede eliminar ventas ni movimientos anteriores.',409);}
     await client.query('UPDATE inventory_primary SET version=$2,state_json=$3::jsonb,state_hash=$4,updated_at=now(),last_seen=now() WHERE owner_id=$1',[ownerId,s.version,JSON.stringify(s),hash]);
   }else await client.query('UPDATE inventory_primary SET last_seen=now() WHERE owner_id=$1',[ownerId]);
   await client.query("UPDATE inventory_commands SET status='expired',result_json=$2::jsonb WHERE owner_id=$1 AND status='pending' AND expires_at<now()",[ownerId,JSON.stringify({error:'La PC no confirmó a tiempo. La venta no se realizó.'})]);
   if(raw.poll!==false)await client.query("UPDATE inventory_commands SET status='processing' WHERE owner_id=$1 AND NOT EXISTS(SELECT 1 FROM inventory_commands WHERE owner_id=$1 AND status='processing') AND id IN(SELECT id FROM inventory_commands WHERE owner_id=$1 AND status='pending' AND expires_at>=now() ORDER BY created_at LIMIT 1)",[ownerId]);
   const waiting=await client.query("SELECT id,payload_json AS payload FROM inventory_commands WHERE owner_id=$1 AND status='processing' ORDER BY created_at LIMIT 1",[ownerId]);
   result={version:s?.version??p.version,syncedAt:new Date().toISOString(),commands:raw.poll===false?[]:waiting.rows};
 }else if(raw.action==='sale'){
   const id=raw.id;if(!validId(id))throw new ValidationError('Identificador de venta inválido.');
   const old=await client.query('SELECT status,result_json AS result FROM inventory_commands WHERE owner_id=$1 AND id=$2',[ownerId,id]);
   if(old.rowCount)result=old.rows[0];else{
     const available=p&&p.last_seen&&Date.now()-new Date(p.last_seen).getTime()<8000;
     if(!available||!p.state_json)throw new ValidationError('La PC principal está desconectada. Puedes consultar; las ventas del celular están bloqueadas.',409);
     const data=raw.data as {items?:unknown[]};if(!data||!Array.isArray(data.items)||!data.items.length||data.items.length>500)throw new ValidationError('La venta está vacía.');
     await client.query('INSERT INTO inventory_commands(owner_id,id,payload_json) VALUES($1,$2,$3::jsonb)',[ownerId,id,JSON.stringify({id,at:new Date().toISOString(),kind:'sale',source:'Celular',data})]);result={status:'pending'};
   }
 }else if(raw.action==='ack'){
   if(!p||p.device_id!==raw.deviceId)throw new ValidationError('Solo la PC principal puede confirmar ventas.',403);
   if(!validId(raw.id))throw new ValidationError('Venta inválida.');
   const sale=p.state_json?.sales?.find((x:{id:unknown})=>x.id===raw.id);
   if(raw.error&&sale)throw new ValidationError('Esta venta ya está registrada. Debe confirmarse.',409);
   if(!raw.error&&!sale)throw new ValidationError('Primero sincroniza el comprobante antes de confirmar.',409);
   const safeResult=raw.error?{error:String(raw.error).slice(0,500)}:{sale};
   await client.query("UPDATE inventory_commands SET status=$3,result_json=$4::jsonb WHERE owner_id=$1 AND id=$2 AND status='processing'",[ownerId,raw.id,raw.error?'rejected':'completed',JSON.stringify(safeResult)]);result={acknowledged:true};
 }else throw new ValidationError('Operación no compatible.');
 await client.query('COMMIT');return json(result);
 }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
});}
