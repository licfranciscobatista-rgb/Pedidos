import {test} from "node:test";
import assert from "node:assert/strict";
import{createTestDatabase,hasTestDatabase}from"./postgres-harness.mjs";
const clients=await import("../app/api/clients/route.ts"),quotes=await import("../app/api/quotes/route.ts"),drafts=await import("../app/api/invoice-drafts/route.ts"),invoices=await import("../app/api/invoices/route.ts"),orders=await import("../app/api/orders/route.ts"),data=await import("../app/api/data/route.ts");
const{prepareBusinessImport,businessFingerprint}=await import("../lib/business-import.ts");
const invoiceById=await import("../app/api/invoices/[id]/route.ts");
const req=(path,method="GET",value)=>new Request(`https://site.example${path}`,{method,headers:{Origin:"https://site.example","Content-Type":"application/json"},body:value===undefined?undefined:JSON.stringify(value)});
async function reply(promise,status){const response=await promise,value=await response.json();assert.equal(response.status,status,JSON.stringify(value));return value;}
const client=(id="C-1",extra={})=>({id,name:"Ana",phone:"809-555-1111",email:"",address:"",notes:"",active:true,revision:0,...extra});
const quote=(id="Q-1",extra={})=>({id,clientId:"C-1",date:"2026-10-18",validUntil:"2026-10-30",status:"Borrador",notes:"",revision:0,items:[{id:"line-1",article:"Bolso",variant:"Azul",platform:"Temu",quantity:2,unitCents:10001,extraCents:9,discountCents:11}],...extra});
const article=(id="P-1",extra={})=>({id,platform:"Temu",client:"Ana",phone:"8095551111",batch:"",article:"Bolso",variant:"Azul",quantity:2,unitCents:10001,extraCents:9,discountCents:11,storeCents:12000,status:"En camino",date:"2026-10-17",deliveryDate:"2026-10-20",notes:"",photoKey:"",...extra});
const draft=(id="F-1",extra={})=>({id,clientId:"C-1",date:"2026-10-18",businessName:"",notes:"Aviso de entrega",pricingMode:"manual",manualTotalCents:25000,showAmounts:true,revision:0,items:[{orderId:"P-1",deliveryLabel:"Sigue pendiente"}],...extra});
test("business fingerprints compare item membership without reordering presented lines",()=>{
 const q=quote(),line={...q.items[0],id:"line-2",article:"Otra línea"};q.items.push(line);const original=q.items.map(i=>i.id);
 assert.equal(businessFingerprint("quotes",q),businessFingerprint("quotes",{...q,items:[...q.items].reverse()}));assert.deepEqual(q.items.map(i=>i.id),original);
 const d=draft();d.items.push({orderId:"P-2",deliveryLabel:"Por confirmar"});assert.equal(businessFingerprint("invoiceDrafts",d),businessFingerprint("invoiceDrafts",{...d,items:[...d.items].reverse()}));assert.notEqual(businessFingerprint("invoiceDrafts",d),businessFingerprint("invoiceDrafts",{...d,items:[{...d.items[0],deliveryLabel:"Ya entregado"},d.items[1]]}));
});
test("Business PostgreSQL: relaciones, conflictos Excel/web y emisión explícita inmutable",{skip:!hasTestDatabase},async t=>{
const fixture=await createTestDatabase(),db=fixture.database("owner-A");
try{
await t.test("cliente y cotización relacional, centavos calculados y referencias owner",async()=>{
const c=(await reply(clients.POST(req("/api/clients","POST",{client:client()})),201)).client;assert.equal(c.revision,1);assert.match(c.createdAt,/T/);
const q=(await reply(quotes.POST(req("/api/quotes","POST",{quote:quote()})),201)).quote;assert.equal(q.totalCents,20000);assert.equal(q.items[0].unitCents,10001);
await reply(quotes.POST(req("/api/quotes","POST",{quote:quote("bad",{clientId:"missing"})})),409);
globalThis.__postgresTestUser={userId:"owner-B"};assert.equal((await reply(clients.GET(req("/api/clients")),200)).clients.length,0);await reply(quotes.POST(req("/api/quotes","POST",{quote:quote()})),409);globalThis.__postgresTestUser={userId:"owner-A"};
const concurrent=await Promise.all(["Uno","Dos"].map(notes=>clients.PUT(req("/api/clients","PUT",{client:{...c,notes}}))));assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,409]);
});
await t.test("borrador valida pertenencia sin emitir, dos clics distintos emiten una sola factura",async()=>{
await reply(orders.POST(req("/api/orders","POST",{order:article()})),201);
await reply(drafts.POST(req("/api/invoice-drafts","POST",{draft:draft()})),201);
await reply(orders.POST(req("/api/orders","POST",{order:article("other",{client:"Otra"})})),201);
await reply(drafts.POST(req("/api/invoice-drafts","POST",{draft:draft("bad",{items:[{orderId:"other",deliveryLabel:"Por confirmar"}]})})),409);
assert.equal((await fixture.pool.query("SELECT count(*)::int n FROM invoices")).rows[0].n,0);
const replies=await Promise.all([1,2].map(()=>invoices.POST(req("/api/invoices","POST",{sourceDraftId:"F-1",sourceDraftRevision:1,requestId:crypto.randomUUID()}))));assert.deepEqual(replies.map(r=>r.status).sort(),[200,201]);
const saved=await Promise.all(replies.map(r=>r.json()));assert.deepEqual(saved[0].invoice,saved[1].invoice);assert.equal(saved[0].invoice.totalCents,25000);assert.equal(saved[0].invoice.businessName,"Mi encargo");assert.equal(saved[0].invoice.items[0].orderDate,"2026-10-17");assert.equal(saved[0].invoice.items[0].deliveryDate,"2026-10-20");
const d=(await reply(drafts.GET(req("/api/invoice-drafts")),200)).invoiceDrafts[0];assert.equal(d.issuedInvoiceId,saved[0].invoice.id);await reply(drafts.PUT(req("/api/invoice-drafts","PUT",{draft:{...d,notes:"No debe cambiar"}})),409);assert.equal((await fixture.pool.query("SELECT count(*)::int n FROM activities WHERE kind='Factura emitida'")).rows[0].n,1);
});
await t.test("sin importes permite negocio vacío y no requiere monto; límites nuevos no alteran antiguas",async()=>{
const base={orderIds:["P-1"],requestId:crypto.randomUUID(),businessName:"",notes:"",pricingMode:"manual",showAmounts:false,deliveryLabels:{}};
const hidden=(await reply(invoices.POST(req("/api/invoices","POST",base)),201)).invoice;assert.equal(hidden.showAmounts,false);assert.equal(hidden.totalCents,20000);
await reply(invoices.POST(req("/api/invoices","POST",{...base,requestId:crypto.randomUUID(),showAmounts:true,manualTotalCents:100000001})),400);
await fixture.pool.query(`INSERT INTO invoices(owner_id,id,sequence,number,issued_at,client,phone,business_name,notes,pricing_mode,show_amounts,registered_total_cents,order_ids_json,items_json,total_cents,paid_cents,balance_cents) SELECT owner_id,'legacy-large',999999,'FAC-LEGACY',issued_at,client,phone,business_name,notes,'manual',1,registered_total_cents,order_ids_json,items_json,100000000000,0,100000000000 FROM invoices WHERE owner_id='owner-A' AND id=$1`,[hidden.id]);
const legacy=(await reply(invoiceById.GET(req("/api/invoices/legacy-large"),{params:Promise.resolve({id:"legacy-large"})}),200)).invoice;assert.equal(legacy.totalCents,100000000000);
});
await t.test("OneDrive auxiliares idempotentes, edición web preservada y conflictos atómicos",async()=>{
const input={clients:[client("C-EX")],quotes:[quote("Q-EX",{clientId:"C-EX"})],invoiceDrafts:[]};
let prepared=await prepareBusinessImport(db,"owner-A",input,{sourceFileId:"book"});await db.batch(prepared.statements);assert.equal(prepared.summary.createdClients,1);
prepared=await prepareBusinessImport(db,"owner-A",input,{sourceFileId:"book"});await db.batch(prepared.statements);assert.equal(prepared.summary.unchangedClients,1);
const c=(await reply(clients.GET(req("/api/clients")),200)).clients.find(c=>c.id==="C-EX");await reply(clients.PUT(req("/api/clients","PUT",{client:{...c,notes:"Cambio en la web"}})),200);
prepared=await prepareBusinessImport(db,"owner-A",input,{sourceFileId:"book"});await db.batch(prepared.statements);assert.equal((await fixture.pool.query("SELECT notes FROM clients WHERE id='C-EX'")).rows[0].notes,"Cambio en la web");
await assert.rejects(prepareBusinessImport(db,"owner-A",{...input,clients:[{...input.clients[0],notes:"Cambio en Excel"}]},{sourceFileId:"book"}),/cambios en la web y en Excel/);
prepared=await prepareBusinessImport(db,"owner-A",{...input,clients:[{...input.clients[0],notes:"Resuelto después de revisar",revision:c.revision+1}]},{sourceFileId:"book"});await db.batch(prepared.statements);assert.equal((await fixture.pool.query("SELECT notes FROM clients WHERE id='C-EX'")).rows[0].notes,"Resuelto después de revisar");
prepared=await prepareBusinessImport(db,"owner-A",{clients:[client("must-rollback")],quotes:[quote("invalid-ref",{clientId:"missing"})],invoiceDrafts:[]},{sourceFileId:"book"});await assert.rejects(db.batch(prepared.statements),/transaction_conflict/);assert.equal((await fixture.pool.query("SELECT count(*)::int n FROM clients WHERE id='must-rollback'")).rows[0].n,0);
const issued=(await reply(drafts.GET(req("/api/invoice-drafts")),200)).invoiceDrafts[0];prepared=await prepareBusinessImport(db,"owner-A",{invoiceDrafts:[issued]},{sourceFileId:"book"});await db.batch(prepared.statements);await assert.rejects(prepareBusinessImport(db,"owner-A",{invoiceDrafts:[{...issued,notes:"Alterado"}]},{sourceFileId:"book"}),/ya fue emitido/);
});
await t.test("api/data retorna listas nuevas sin mezclar clientes ni crear deuda desde cotizaciones",async()=>{const all=await reply(data.GET(req("/api/data")),200);assert.ok(all.clients.length>=2);assert.ok(all.quotes.length>=2);assert.equal(all.invoiceDrafts.length,1);assert.equal(all.payments.length,0);assert.equal(all.orders.length,2);});
await t.test("ID Cliente conserva vínculos al renombrar y separa homónimos; legado ambiguo se rechaza",async()=>{
 const first=(await reply(clients.POST(req("/api/clients","POST",{client:client("H-1",{name:"Homónima",phone:""})})),201)).client;
 await reply(clients.POST(req("/api/clients","POST",{client:client("H-2",{name:"Homónima",phone:""})})),201);
 const linked=(await reply(orders.POST(req("/api/orders","POST",{order:article("H-P",{clientId:"H-1",client:"Nombre falso",phone:"000"})})),201)).order;
 assert.equal(linked.clientId,"H-1");assert.equal(linked.client,"Homónima");assert.equal(linked.phone,"");
 await reply(orders.POST(req("/api/orders","POST",{order:article("ambiguous-new",{client:"Homónima",phone:""})})),409);
 await reply(drafts.POST(req("/api/invoice-drafts","POST",{draft:draft("H-wrong",{clientId:"H-2",items:[{orderId:"H-P",deliveryLabel:"Por confirmar"}]})})),409);
 await fixture.pool.query(`INSERT INTO orders(owner_id,id,platform,client,phone,article,quantity,unit_cents,status,date) VALUES('owner-A','H-legacy','Temu','Homónima','','Legado',1,100,'Pedido','2026-10-18')`);
 await reply(drafts.POST(req("/api/invoice-drafts","POST",{draft:draft("H-ambiguous",{clientId:"H-1",items:[{orderId:"H-legacy",deliveryLabel:"Por confirmar"}]})})),409);
 const makeDraft=id=>draft(id,{clientId:"H-1",items:[{orderId:"H-P",deliveryLabel:"Sigue pendiente"}]});
 await reply(drafts.POST(req("/api/invoice-drafts","POST",{draft:makeDraft("H-F-old")})),201);
 const old=(await reply(invoices.POST(req("/api/invoices","POST",{sourceDraftId:"H-F-old",sourceDraftRevision:1,requestId:crypto.randomUUID()})),201)).invoice;
 await reply(clients.PUT(req("/api/clients","PUT",{client:{...first,name:"Nombre nuevo",phone:"8099998888"}})),200);
 await reply(drafts.POST(req("/api/invoice-drafts","POST",{draft:makeDraft("H-F-new")})),201);
 const fresh=(await reply(invoices.POST(req("/api/invoices","POST",{sourceDraftId:"H-F-new",sourceDraftRevision:1,requestId:crypto.randomUUID()})),201)).invoice;
 assert.equal(fresh.client,"Nombre nuevo");assert.equal(fresh.phone,"8099998888");
 const retained=(await reply(invoiceById.GET(req(`/api/invoices/${old.id}`),{params:Promise.resolve({id:old.id})}),200)).invoice;assert.equal(retained.client,"Homónima");assert.equal(retained.phone,"");
 const row=(await fixture.pool.query(`SELECT client_id,client FROM orders WHERE owner_id='owner-A' AND id='H-P'`)).rows[0];assert.equal(row.client_id,"H-1");assert.equal(row.client,"Homónima");
 for(const id of ["H-race-1","H-race-2"])await reply(drafts.POST(req("/api/invoice-drafts","POST",{draft:makeDraft(id)})),201);
 const reusedRequest=crypto.randomUUID();const race=await Promise.all(["H-race-1","H-race-2"].map(sourceDraftId=>invoices.POST(req("/api/invoices","POST",{sourceDraftId,sourceDraftRevision:1,requestId:reusedRequest}))));assert.deepEqual(race.map(r=>r.status).sort(),[201,409]);
 assert.equal((await fixture.pool.query(`SELECT count(*)::int n FROM invoice_drafts WHERE owner_id='owner-A' AND id IN('H-race-1','H-race-2') AND issued_invoice_id IS NOT NULL`)).rows[0].n,1);
 await reply(orders.POST(req("/api/orders","POST",{order:article("missing-client",{clientId:"not-owned"})})),409);
});
}finally{await fixture.cleanup();}
});
