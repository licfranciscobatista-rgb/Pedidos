import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestDatabase, hasTestDatabase } from "./postgres-harness.mjs";
const imports = await import("../app/api/import/route.ts");
const sync = await import("../app/api/onedrive/sync/route.ts");
const download = await import("../app/api/onedrive/download/route.ts");
const clients = await import("../app/api/clients/route.ts");
const data = await import("../app/api/data/route.ts");
const { encrypt } = await import("../app/api/onedrive/_core.ts");
const { exportExcel, parseExcel } = await import("../lib/excel.ts");
const req = (path, value) => new Request(`https://site.example${path}`, { method: value === undefined ? "GET" : "POST", headers: { Origin:"https://site.example", "Content-Type":"application/json" }, body: value === undefined ? undefined : JSON.stringify(value) });
const client = (id, extra={}) => ({id,name:"Ana",phone:"8095550101",email:"",address:"",notes:"",active:true,revision:0,...extra});
const order = (id, extra={}) => ({id,client:"Ana",phone:"8095550101",article:"Organizador",platform:"Temu",quantity:2,unitCents:65000,extraCents:10000,discountCents:5000,storeCents:80000,status:"En camino",date:"2026-10-18",deliveryDate:"",batch:"",variant:"Azul",notes:"",photoKey:"",revision:0,...extra});
const quote = (id, clientId, extra={}) => ({id,clientId,date:"2026-10-18",validUntil:"2026-10-25",status:"Borrador",notes:"",revision:0,totalCents:92500,items:[{id:`${id}-L1`,article:"Camisa",variant:"M",platform:"SHEIN",quantity:2,unitCents:45000,extraCents:5000,discountCents:2500}],...extra});
const draft = (id, clientId, orderId, extra={}) => ({id,clientId,date:"2026-10-18",businessName:"",notes:"Aviso",pricingMode:"manual",manualTotalCents:0,showAmounts:false,revision:0,items:[{orderId,deliveryLabel:"Sigue pendiente"}],...extra});
const payload = (prefix="A") => ({orders:[order(`${prefix}-P1`)],payments:[],exchanges:[],clients:[client(`${prefix}-C1`)],quotes:[quote(`${prefix}-Q1`,`${prefix}-C1`)],invoiceDrafts:[draft(`${prefix}-F1`,`${prefix}-C1`,`${prefix}-P1`)]});
async function response(promise, status) {const result=await promise,value=await result.json();assert.equal(result.status,status,JSON.stringify(value));return value;}

test("Excel manual: importa todas las colecciones, evita duplicados y revierte pedidos ante un borrador inválido", {skip:!hasTestDatabase}, async () => {
  const fixture=await createTestDatabase();
  try {
    const source=payload();
    const xlsx=await exportExcel(source.orders,source.payments,[],undefined,source);
    const preview=await parseExcel(await xlsx.arrayBuffer());
    assert.deepEqual(preview.errors,[]);
    const first=await response(imports.POST(req("/api/import",preview)),200);
    assert.equal(first.changes.createdOrders,1);assert.equal(first.changes.createdClients,1);assert.equal(first.changes.createdQuotes,1);assert.equal(first.changes.createdInvoiceDrafts,1);
    const second=await response(imports.POST(req("/api/import",preview)),200);
    assert.equal(second.changes.unchangedOrders,1);assert.equal(second.changes.unchangedClients,1);assert.equal(second.changes.unchangedQuotes,1);assert.equal(second.changes.unchangedInvoiceDrafts,1);
    assert.equal((await fixture.pool.query("SELECT count(*)::int n FROM invoices")).rows[0].n,0);
    const invalid=payload("ROLL");invalid.invoiceDrafts[0].items[0].orderId="MISSING";
    await response(imports.POST(req("/api/import",invalid)),409);
    for(const table of ["orders","clients","quotes","invoice_drafts"])assert.equal((await fixture.pool.query(`SELECT count(*)::int n FROM ${table} WHERE id LIKE 'ROLL-%'`)).rows[0].n,0);
    await response(imports.POST(req("/api/import",{orders:[],payments:[],exchanges:[],clients:[client("CLIENT-ONLY")]})),200);
    assert.equal((await response(data.GET(req("/api/data")),200)).clients.length,2);
  } finally {await fixture.cleanup();}
});

test("API OneDrive con Graph simulado: descarga XLSX, importa auxiliares, conserva cambios web y revierte conflictos", {skip:!hasTestDatabase}, async () => {
  const fixture=await createTestDatabase(),oldFetch=globalThis.fetch;
  const keys=["MICROSOFT_CLIENT_ID","MICROSOFT_CLIENT_SECRET","MICROSOFT_REDIRECT_URI","ONEDRIVE_TOKEN_KEY"];
  const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  let etag='"v1"',source=payload("B"),bytes;
  const workbook=async()=>{bytes=new Uint8Array(await (await exportExcel(source.orders,source.payments,source.exchanges,undefined,source)).arrayBuffer());};
  try {
    Object.assign(process.env,{MICROSOFT_CLIENT_ID:"unit-client",MICROSOFT_CLIENT_SECRET:"unit-secret",MICROSOFT_REDIRECT_URI:"https://site.example/api/onedrive/callback",ONEDRIVE_TOKEN_KEY:Buffer.alloc(32,3).toString("base64")});
    await workbook();
    const access=await encrypt("unit-access",process.env.ONEDRIVE_TOKEN_KEY,"owner-A"),refresh=await encrypt("unit-refresh",process.env.ONEDRIVE_TOKEN_KEY,"owner-A");
    await fixture.pool.query("INSERT INTO onedrive_connections(owner_id,refresh_cipher,access_cipher,access_expires_at,file_id,file_name) VALUES($1,$2,$3,$4,$5,$6)",["owner-A",refresh,access,Date.now()+3600000,"book-test","programa.xlsx"]);
    globalThis.fetch=async(input,options={})=>{
      const url=new URL(String(input));
      assert.equal(url.hostname,"graph.microsoft.com","The test never calls a live Microsoft account");assert.equal(new Headers(options.headers).get("Authorization"),"Bearer unit-access");
      if(url.pathname.endsWith("/content"))return new Response(bytes);
      return Response.json({id:"book-test",name:"programa.xlsx",eTag:etag,size:bytes.byteLength,file:{},webUrl:"https://onedrive.live.com/test",lastModifiedDateTime:"2026-10-18T12:00:00Z"});
    };
    const run=async(status=200)=>{
      const downloaded=await download.GET(req("/api/onedrive/download"));assert.equal(downloaded.status,200,await downloaded.clone().text());
      const preview=await parseExcel(await downloaded.arrayBuffer());assert.deepEqual(preview.errors,[]);
      return response(sync.POST(req("/api/onedrive/sync",{...preview,fileId:"book-test",etag})),status);
    };
    const first=await run();assert.equal(first.changes.createdOrders,1);assert.equal(first.changes.createdClients,1);assert.equal(first.changes.createdQuotes,1);assert.equal(first.changes.createdInvoiceDrafts,1);
    assert.equal((await fixture.pool.query("SELECT count(*)::int n FROM business_baselines")).rows[0].n,3);
    assert.equal((await fixture.pool.query("SELECT count(*)::int n FROM invoices")).rows[0].n,0);
    const repeat=await response(sync.POST(req("/api/onedrive/sync",{...source,fileId:"book-test",etag,generatedIds:0})),200);assert.equal(repeat.unchanged,true);
    const current=(await response(clients.GET(req("/api/clients")),200)).clients[0];
    const update=new Request("https://site.example/api/clients",{method:"PUT",headers:{Origin:"https://site.example","Content-Type":"application/json"},body:JSON.stringify({client:{...current,notes:"Editado en la web"}})});
    await response(clients.PUT(update),200);
    etag='"v2"';source.quotes[0].notes="Nueva versión Excel";await workbook();const second=await run();assert.equal(second.changes.updatedQuotes,1);
    assert.equal((await fixture.pool.query("SELECT notes FROM clients WHERE id='B-C1'")).rows[0].notes,"Editado en la web");
    etag='"v3"';source.clients[0].notes="Cambio contrario en Excel";source.orders.push(order("CONFLICT-P"));await workbook();await run(409);
    assert.equal((await fixture.pool.query("SELECT count(*)::int n FROM orders WHERE id='CONFLICT-P'")).rows[0].n,0);
    assert.equal((await fixture.pool.query("SELECT synced_etag FROM onedrive_connections")).rows[0].synced_etag,'"v2"');
    // A failure during the final SQL batch must roll back legacy and new rows.
    etag='"v4"';source.clients[0].notes="";source.orders=[order("B-P1"),order("ROLLBACK-P")];source.invoiceDrafts.push(draft("ROLLBACK-F","B-C1","MISSING"));await workbook();await run(409);
    assert.equal((await fixture.pool.query("SELECT count(*)::int n FROM orders WHERE id='ROLLBACK-P'")).rows[0].n,0);
    assert.equal((await fixture.pool.query("SELECT count(*)::int n FROM invoice_drafts WHERE id='ROLLBACK-F'")).rows[0].n,0);
    assert.equal((await fixture.pool.query("SELECT synced_etag FROM onedrive_connections")).rows[0].synced_etag,'"v2"');
  } finally {
    globalThis.fetch=oldFetch;for(const key of keys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}
    await fixture.cleanup();
  }
});
