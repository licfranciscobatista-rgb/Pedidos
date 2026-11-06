export const SCHEMA = 1;
export const money = n => `RD$ ${(n / 100).toLocaleString('es-DO', {minimumFractionDigits:2,maximumFractionDigits:2})}`;
export const quantity = n => (n / 1000).toLocaleString('es-DO',{maximumFractionDigits:3});
export function numberInput(value, scale=100) {
  const s=String(value??'').trim();
  const digits=scale===1000?3:2;
  if (!new RegExp(`^\\d+(?:[.,]\\d{1,${digits}})?$`).test(s)) throw Error('Escribe un número positivo, sin separadores de miles.');
  const n=Math.round(Number(s.replace(',','.'))*scale);
  if(!Number.isSafeInteger(n)||n>100000000000)throw Error('El valor es demasiado grande.');
  return n;
}
function integer(n,min=0,max=100000000000){if(!Number.isSafeInteger(n)||n<min||n>max)throw Error('Cantidad o importe inválido.');return n;}
function text(s,max=160){s=String(s??'').trim();if(s.length>max)throw Error(`El texto supera ${max} caracteres.`);return s;}
export function initialState(){return {schema:SCHEMA,version:0,shop:{name:'Mi tienda',rnc:'',phone:'',address:''},products:[],sales:[],movements:[],operations:[]};}
export function validateState(s){
 if(!s||s.schema!==SCHEMA)throw Error('Formato de inventario no compatible.');
 integer(s.version);if(!s.shop||!Array.isArray(s.products)||!Array.isArray(s.sales)||!Array.isArray(s.movements)||!Array.isArray(s.operations))throw Error('Inventario incompleto.');
 if(s.products.length>50000)throw Error('El catálogo supera el límite de esta versión.');
 const ids=new Set(),skus=new Set();for(const p of s.products){if(!p.id||ids.has(p.id)||!p.sku||skus.has(p.sku.toLowerCase()))throw Error('Códigos de artículos duplicados.');ids.add(p.id);skus.add(p.sku.toLowerCase());integer(p.stock);integer(p.minStock);integer(p.unitCents);integer(p.costCents);if(!p.name)throw Error('Artículo sin nombre.');}
 const sales=new Set();for(const sale of s.sales){if(!sale.id||sales.has(sale.id)||!Array.isArray(sale.items))throw Error('Venta inválida.');sales.add(sale.id);integer(sale.totalCents);}
 return s;
}
export function applyOperation(current,op){
 validateState(current);if(!op||typeof op.id!=='string'||!op.id||typeof op.at!=='string'||!Number.isFinite(Date.parse(op.at)))throw Error('Operación sin identificador o fecha válida.');
 if(current.operations.includes(op.id))return current;
 const s=structuredClone(current),data=op.data??{};
 const move=(p,delta,kind,note='',saleId='')=>{integer(p.stock+delta);p.stock+=delta;s.movements.push({id:`${op.id}:${p.id}`,productId:p.id,sku:p.sku,name:p.name,at:op.at,delta,stockAfter:p.stock,kind,note:text(note,1000),saleId});};
 if(op.kind==='product'){
   const name=text(data.name),sku=text(data.sku,80);if(!name||!sku)throw Error('Nombre y código son obligatorios.');
   const id=text(data.id||op.id,80),existing=s.products.find(p=>p.id===id);
   if(s.products.some(p=>p.id!==id&&p.sku.toLowerCase()===sku.toLowerCase()))throw Error('Ya existe un artículo con ese código.');
   const fields={id,sku,name,barcode:text(data.barcode,80),category:text(data.category,80),unitCents:integer(data.unitCents),costCents:integer(data.costCents??0),minStock:integer(data.minStock??0),active:data.active!==false};
   if(existing)Object.assign(existing,fields);
   else{const p={...fields,stock:0};s.products.push(p);const stock=integer(data.stock??0);if(stock)move(p,stock,'Inventario inicial');}
 }else if(op.kind==='movement'){
   const p=s.products.find(p=>p.id===data.productId);if(!p)throw Error('El artículo no existe.');
   const amount=integer(data.quantity,1),note=text(data.note,1000);
   if(!['Entrada','Salida / ajuste'].includes(data.type))throw Error('Movimiento inválido.');
   if(!note)throw Error('Indica el motivo o la referencia del movimiento.');
   if(data.type==='Salida / ajuste'&&amount>p.stock)throw Error('La salida supera la existencia disponible.');
   move(p,data.type==='Entrada'?amount:-amount,data.type,note);
 }else if(op.kind==='sale'){
   if(!Array.isArray(data.items)||!data.items.length||data.items.length>500)throw Error('Agrega artículos a la venta.');
   const grouped=new Map();for(const row of data.items)grouped.set(row.productId,integer((grouped.get(row.productId)||0)+integer(row.quantity,1)));
   const items=[];let total=0;
   for(const [id,amount] of grouped){const p=s.products.find(p=>p.id===id&&p.active);if(!p)throw Error('Un artículo ya no está disponible.');if(amount>p.stock)throw Error(`Existencia insuficiente: ${p.name}. Disponible: ${quantity(p.stock)}.`);if(data.expectedPrices&&data.expectedPrices[id]!==p.unitCents)throw Error(`Cambió el precio de ${p.name}. Actualiza la venta.`);const cents=Math.round(p.unitCents*amount/1000);integer(cents);total=integer(total+cents);items.push({productId:id,sku:p.sku,name:p.name,quantity:amount,unitCents:p.unitCents,totalCents:cents});}
   const paid=integer(data.paidCents??total);if(paid<total)throw Error('El importe recibido no cubre la venta.');
   const sale={id:op.id,number:`V-${String(s.sales.length+1).padStart(7,'0')}`,at:op.at,customer:text(data.customer||'Consumidor final'),method:text(data.method||'Efectivo',40),items,totalCents:total,paidCents:paid,changeCents:paid-total,status:'Confirmada',source:op.source||'PC',shop:structuredClone(s.shop),note:text(data.note,1000)};
   for(const row of items)move(s.products.find(p=>p.id===row.productId),-row.quantity,'Venta',sale.number,sale.id);
   s.sales.push(sale);
 }else if(op.kind==='void'){
   const sale=s.sales.find(x=>x.id===data.saleId);if(!sale||sale.status!=='Confirmada')throw Error('La venta no existe o ya fue anulada.');
   if(!text(data.note,1000))throw Error('Indica por qué se anula la venta.');
   for(const row of sale.items)move(s.products.find(p=>p.id===row.productId),row.quantity,'Anulación',data.note,sale.id);
   sale.status='Anulada';sale.voidAt=op.at;sale.voidReason=text(data.note,1000);
 }else if(op.kind==='settings'){
   s.shop={name:text(data.name),rnc:text(data.rnc,40),phone:text(data.phone,40),address:text(data.address,300)};if(!s.shop.name)throw Error('Escribe el nombre de la tienda.');
 }else if(op.kind==='import'){
   if(!Array.isArray(data.products)||!data.products.length||data.products.length>10000)throw Error('El archivo no contiene artículos válidos.');
   const importCodes=new Set();for(const p of data.products){const code=String(p.sku||'').toLowerCase();if(importCodes.has(code)||s.products.some(x=>x.sku.toLowerCase()===code))throw Error('La importación contiene códigos duplicados o ya registrados.');importCodes.add(code);}
   let interim=s;for(let i=0;i<data.products.length;i++)interim=applyOperation(interim,{id:`${op.id}-${i}`,kind:'product',at:op.at,data:data.products[i]});
   interim.version=current.version;Object.assign(s,interim);
 }else throw Error('Operación no compatible.');
 s.version++;s.operations.push(op.id);return validateState(s);
}
