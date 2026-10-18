import type{Database}from"./db";
import type{Client}from"./business-types";
import type{Order}from"./types";
import{ValidationError}from"./validation";
const name=(value:string)=>value.trim().toLowerCase();
const phone=(value:string)=>value.replace(/[^0-9]/g,"");
/** Normalize identity before planning; SQL re-reads the master in its transaction. */
export async function normalizeOrdersWithClients(db:Database,ownerId:string,orders:Order[],incomingClients:Client[]=[]):Promise<Order[]>{
 const result=await db.batch([db.prepare(`SELECT id,name,phone FROM clients WHERE owner_id=$1`).bind(ownerId),db.prepare(`SELECT id,client_id AS "clientId" FROM orders WHERE owner_id=$1`).bind(ownerId)]);
 const clients=new Map((result[0].results as {id:string;name:string;phone:string}[]).map(item=>[item.id,item]));
 for(const item of incomingClients)clients.set(item.id,item);
 const links=new Map((result[1].results as {id:string;clientId:string|null}[]).map(item=>[item.id,item.clientId]));
 return orders.map(order=>{
  let clientId=order.clientId||links.get(order.id)||"";
  if(!clientId){const matches=[...clients.values()].filter(c=>name(c.name)===name(order.client)&&phone(c.phone)===phone(order.phone));if(matches.length>1)throw new ValidationError(`${order.id}: hay varios clientes con ese nombre y teléfono. Selecciona un ID Cliente.`,409);clientId=matches[0]?.id||"";}
  if(!clientId)return order;
  const client=clients.get(clientId);if(!client)throw new ValidationError(`${order.id}: el ID Cliente ${clientId} no existe.`,409);
  return{...order,clientId,client:client.name,phone:client.phone};
 });
}
