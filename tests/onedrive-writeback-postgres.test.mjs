import{test}from"node:test";
import assert from"node:assert/strict";
import{createHash}from"node:crypto";
import{createTestDatabase,hasTestDatabase}from"./postgres-harness.mjs";
const push=await import("../app/api/onedrive/push/route.ts"),download=await import("../app/api/onedrive/download/route.ts"),sync=await import("../app/api/onedrive/sync/route.ts"),data=await import("../app/api/data/route.ts"),orderRoute=await import("../app/api/orders/[id]/route.ts");
const clientRoute=await import("../app/api/clients/route.ts"),quoteRoute=await import("../app/api/quotes/route.ts"),draftRoute=await import("../app/api/invoice-drafts/route.ts"),paymentRoute=await import("../app/api/payments/route.ts"),exchangeRoute=await import("../app/api/orders/[id]/exchange/route.ts");
const{encrypt,READ_SCOPE,WRITE_SCOPE}=await import("../app/api/onedrive/_core.ts");
const{exportExcel,parseExcel}=await import("../lib/excel.ts");
const{patchWorkbook}=await import("../lib/excel-writeback.ts");
const reset=await import("../app/api/onedrive/write-reset/route.ts");
const req=(path,value,method=value===undefined?"GET":"POST")=>new Request(`https://site.example${path}`,{method,headers:{Origin:"https://site.example","Content-Type":"application/json"},body:value===undefined?undefined:JSON.stringify(value)});
async function result(promise,status){const response=await promise,value=await response.json();assert.equal(response.status,status,JSON.stringify(value));return value;}
const client={id:"C-1",name:"Ana",phone:"8095550101",email:"",address:"",notes:"",active:true,revision:0};
const order={id:"P-1",clientId:"C-1",client:"Ana",phone:"8095550101",article:"Bolso",platform:"Temu",quantity:2,unitCents:65000,extraCents:10000,discountCents:5000,storeCents:80000,status:"En camino",date:"2026-10-18",deliveryDate:"",batch:"",variant:"Azul",notes:"",photoKey:"",revision:0};
const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9xkAAAAASUVORK5CYII=","base64");
const digest=createHash("sha256").update(png).digest();digest[6]=(digest[6]&15)|128;digest[8]=(digest[8]&63)|128;const hex=digest.subarray(0,16).toString("hex"),photoKey=`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
test("OneDrive outbound QA: permisos, If-Match, fotos, revisión exacta y recuperación durable",{skip:!hasTestDatabase},async t=>{
 const fixture=await createTestDatabase(),oldFetch=globalThis.fetch,oldBucket=globalThis.__postgresTestBucket;
 const envKeys=["MICROSOFT_CLIENT_ID","MICROSOFT_CLIENT_SECRET","MICROSOFT_REDIRECT_URI","ONEDRIVE_TOKEN_KEY"],previous=Object.fromEntries(envKeys.map(key=>[key,process.env[key]]));
 let bytes,etag='"source-1"',generation=1,puts=0,mode="success",duringPut;
 const fileId="book-qa",read=async()=>result(data.GET(req("/api/data")),200),body=()=>({fileId,etag});
 const mutate=async changes=>{const current=(await read()).orders.find(item=>item.id==="P-1");return(await result(orderRoute.PUT(req("/api/orders/P-1",{order:{...current,...changes}},"PUT"),{params:Promise.resolve({id:"P-1"})}),200)).order;};
 const scalar=async(sql,values=[])=>Number((await fixture.pool.query(sql,values)).rows[0].n);
 try{
  Object.assign(process.env,{MICROSOFT_CLIENT_ID:"qa-client",MICROSOFT_CLIENT_SECRET:"qa-only-secret",MICROSOFT_REDIRECT_URI:"https://site.example/api/onedrive/callback",ONEDRIVE_TOKEN_KEY:Buffer.alloc(32,8).toString("base64")});
  bytes=new Uint8Array(await(await exportExcel([order],[],[],undefined,{clients:[client]})).arrayBuffer());
  const access=await encrypt("qa-access",process.env.ONEDRIVE_TOKEN_KEY,"owner-A"),refresh=await encrypt("qa-refresh",process.env.ONEDRIVE_TOKEN_KEY,"owner-A");
  await fixture.pool.query(`INSERT INTO onedrive_connections(owner_id,refresh_cipher,access_cipher,access_expires_at,file_id,file_name,granted_scope) VALUES($1,$2,$3,$4,$5,'qa.xlsx',$6)`,["owner-A",refresh,access,Date.now()+3600000,fileId,READ_SCOPE]);
  globalThis.__postgresTestBucket={get:async key=>{assert.equal(key,`owner-A/${photoKey}`);return{body:png,httpMetadata:{contentType:"image/png"}};},put:async()=>{throw Error("No storage writes are needed for outbound");}};
  globalThis.fetch=async(input,options={})=>{
   const url=new URL(String(input)),headers=new Headers(options.headers);
   if(url.hostname==="qa.microsoftpersonalcontent.com"){assert.equal(headers.has("Authorization"),false);return new Response(bytes);}
   assert.equal(url.hostname,"graph.microsoft.com","QA must never contact live Microsoft");assert.equal(headers.get("Authorization"),"Bearer qa-access");
   if(options.method==="PUT"){
    puts++;assert.equal(url.pathname,`/v1.0/me/drive/items/${fileId}/content`);assert.equal(options.redirect,"manual");assert.equal(headers.get("If-Match"),etag);
    if(mode==="412")return new Response(null,{status:412});
    if(mode.startsWith("http-"))return Response.json({error:{code:"notAllowed",message:"A private upstream message must not be returned",innerError:{code:"resourceLocked","request-id":"11111111-1111-4111-8111-111111111111"}}},{status:Number(mode.slice(5)),headers:mode==="http-429"?{"Retry-After":"180"}:{}});
    if(mode==="timeout-before-accept")throw new TypeError("Simulated request lost before server accepted bytes");
    bytes=new Uint8Array(options.body);etag=`"written-${++generation}"`;
    if(duringPut){const hook=duringPut;duringPut=undefined;await hook();}
    if(mode==="accepted-timeout")throw new TypeError("Simulated response lost after server accepted bytes");
    if(mode==="accepted-503")return Response.json({error:{code:"serviceNotAvailable"}},{status:503,headers:{"Retry-After":"60"}});
    return Response.json({id:fileId,eTag:etag});
   }
   if(url.pathname.endsWith("/content"))return new Response(null,{status:302,headers:{Location:"https://qa.microsoftpersonalcontent.com/download"}});
   return Response.json({id:fileId,name:"qa.xlsx",eTag:etag,size:bytes.byteLength,file:{},webUrl:"https://onedrive.live.com/qa",lastModifiedDateTime:"2026-10-18T12:00:00Z"});
  };
  const initial=await download.GET(req("/api/onedrive/download"));assert.equal(initial.status,200);const preview=await parseExcel(await initial.arrayBuffer());assert.deepEqual(preview.errors,[]);await result(sync.POST(req("/api/onedrive/sync",{...preview,...body()})),200);
  await t.test("read-only refuses PUT; granted write produces an image and preserves unchanged data",async()=>{
   await mutate({notes:"Creado en web",photoKey});await result(push.POST(req("/api/onedrive/push",body())),403);assert.equal(puts,0);
   await fixture.pool.query("UPDATE onedrive_connections SET granted_scope=$1",[WRITE_SCOPE]);const saved=await result(push.POST(req("/api/onedrive/push",body())),200);assert.equal(saved.written,1);assert.equal(puts,1);
   const parsed=await parseExcel(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));assert.deepEqual(parsed.errors,[]);assert.equal(parsed.photos.length,1);assert.equal(parsed.orders[0].photoKey,photoKey);assert.equal(parsed.orders[0].notes,"Creado en web");assert.equal(parsed.clients[0].name,"Ana");
  });
  await t.test("repeated current version is idempotent and does not write another ZIP",async()=>{
   const previous=bytes,putCount=puts;const same=await result(push.POST(req("/api/onedrive/push",body())),200);assert.equal(same.unchanged,true);assert.equal(same.written,0);assert.equal(puts,putCount);assert.equal(bytes,previous);assert.equal(await scalar("SELECT count(*)::int n FROM onedrive_write_jobs"),0);
  });
  await t.test("If-Match 412 preserves workbook, baseline and the web edit",async()=>{
   await mutate({notes:"Editar sin pisar"});const before=bytes,beforeEtag=etag,revision=await scalar("SELECT local_revision n FROM onedrive_baselines WHERE order_id='P-1'");mode="412";
   const refused=await result(push.POST(req("/api/onedrive/push",body())),409);assert.equal(refused.requiresPull,true);assert.equal(bytes,before);assert.equal(etag,beforeEtag);assert.equal(await scalar("SELECT local_revision n FROM onedrive_baselines WHERE order_id='P-1'"),revision);assert.equal(await scalar("SELECT count(*)::int n FROM onedrive_write_jobs"),0);
   mode="success";await result(push.POST(req("/api/onedrive/push",body())),200);
  });
  await t.test("Microsoft rejection preserves HTTP cause, safe diagnostics and backoff without acknowledging edits",async()=>{
   await mutate({notes:"Debe esperar el desbloqueo"});const before=bytes,baseline=await scalar("SELECT local_revision n FROM onedrive_baselines WHERE order_id='P-1'");
   for(const status of [400,404,423,429]){
    mode=`http-${status}`;const count=puts,response=await push.POST(req("/api/onedrive/push",body())),failure=await response.json();
    assert.equal(response.status,status);assert.equal(failure.microsoftStatus,status);assert.equal(failure.microsoftCode,"notAllowed");assert.equal(failure.microsoftInnerCode,"resourceLocked");assert.equal(failure.requestId,"11111111-1111-4111-8111-111111111111");assert.equal(failure.retryable,status===423||status===429);assert.doesNotMatch(JSON.stringify(failure),/private upstream/);
    if(status===429){assert.equal(failure.retryAfterSeconds,180);assert.equal(response.headers.get("Retry-After"),"180");}
    assert.equal(puts,count+1);assert.equal(bytes,before);assert.equal(await scalar("SELECT count(*)::int n FROM onedrive_write_jobs"),0);assert.equal(await scalar("SELECT local_revision n FROM onedrive_baselines WHERE order_id='P-1'"),baseline);
   }
   mode="success";await result(push.POST(req("/api/onedrive/push",body())),200);
  });
  await t.test("upstream 503 after acceptance retains exact pending job and recovers without another PUT",async()=>{
   await mutate({notes:"Aceptado pero servicio respondió503"});mode="accepted-503";const count=puts,sourceEtag=etag;
   const failure=await result(push.POST(req("/api/onedrive/push",body())),502);assert.equal(failure.microsoftStatus,503);assert.equal(failure.retryable,true);assert.equal(failure.retryAfterSeconds,60);assert.equal(failure.writePending,true);assert.equal(await scalar("SELECT count(*)::int n FROM onedrive_write_jobs"),1);
   mode="success";const recovered=await result(push.POST(req("/api/onedrive/push",{fileId,etag:sourceEtag})),200);assert.equal(recovered.recovered,true);assert.equal(puts,count+1);assert.equal(await scalar("SELECT count(*)::int n FROM onedrive_write_jobs"),0);
  });
  await t.test("edit during PUT is not acknowledged as if it had been sent",async()=>{
   const captured=await mutate({notes:"Versión capturada"});duringPut=()=>mutate({notes:"Versión posterior"});await result(push.POST(req("/api/onedrive/push",body())),200);
   assert.equal(await scalar("SELECT local_revision n FROM onedrive_baselines WHERE order_id='P-1'"),captured.revision);assert.equal((await read()).orders[0].revision,captured.revision+1);
   const parsed=await parseExcel(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));assert.equal(parsed.orders[0].notes,"Versión capturada");await result(push.POST(req("/api/onedrive/push",body())),200);assert.equal(await scalar("SELECT local_revision n FROM onedrive_baselines WHERE order_id='P-1'"),captured.revision+1);
  });
  await t.test("lost response is recovered by exact target hash without a second PUT",async()=>{
   await mutate({notes:"Respuesta perdida"});mode="accepted-timeout";const sourceEtag=etag,count=puts;const pending=await result(push.POST(req("/api/onedrive/push",body())),502);assert.equal(pending.writePending,true);assert.equal(await scalar("SELECT count(*)::int n FROM onedrive_write_jobs"),1);mode="success";
   const recovered=await result(push.POST(req("/api/onedrive/push",{fileId,etag:sourceEtag})),200);assert.equal(recovered.recovered,true);assert.equal(puts,count+1);assert.equal(await scalar("SELECT count(*)::int n FROM onedrive_write_jobs"),0);
  });
  await t.test("parallel retries of an expired unsent job claim that exact job only once",async()=>{
   await mutate({notes:"Recuperar solicitud no recibida"});mode="timeout-before-accept";
   const sourceEtag=etag;await result(push.POST(req("/api/onedrive/push",body())),502);
   await fixture.pool.query("UPDATE onedrive_write_jobs SET created_at=$1 WHERE owner_id='owner-A'",[new Date(Date.now()-180000).toISOString()]);
   mode="success";const count=puts,replies=await Promise.all([1,2].map(()=>push.POST(req("/api/onedrive/push",{fileId,etag:sourceEtag}))));
   assert.deepEqual(replies.map(reply=>reply.status).sort(),[200,409]);assert.equal(puts,count+1);assert.equal(await scalar("SELECT count(*)::int n FROM onedrive_write_jobs"),0);
  });
  await t.test("explicit web photo removal does not resurrect on reimport",async()=>{
   await mutate({photoKey:""});await result(push.POST(req("/api/onedrive/push",body())),200);const parsed=await parseExcel(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));assert.deepEqual(parsed.errors,[]);assert.equal(parsed.photos.length,0);assert.equal(parsed.orders[0].photoKey,"");
   const again=await result(sync.POST(req("/api/onedrive/sync",{...parsed,...body()})),200);assert.equal(again.unchanged,true);assert.equal((await read()).orders[0].photoKey,"");
  });
  await t.test("parallel sends write once and never create a second job",async()=>{
   await mutate({notes:"Una sola escritura"});const current=body(),count=puts;const replies=await Promise.all([push.POST(req("/api/onedrive/push",current)),push.POST(req("/api/onedrive/push",current))]);assert.deepEqual(replies.map(r=>r.status).sort(),[200,409]);assert.equal(puts,count+1);assert.equal(await scalar("SELECT count(*)::int n FROM onedrive_write_jobs"),0);
  });
  await t.test("web client identity, ledger, quotes and drafts roundtrip without emitting or duplicating",async()=>{
   const current=await read(),master=current.clients[0];
   await result(clientRoute.PUT(req("/api/clients",{client:{...master,name:"Ana renombrada",phone:"8095550112"}},"PUT")),200);
   const payment={id:"PAY-WEB",orderId:"P-1",amountCents:25001,kind:"Abono",date:"2026-10-18",method:"Efectivo",note:"Pago web exacto"};
   await result(paymentRoute.POST(req("/api/payments",{payment})),201);
   const exchange=(await result(exchangeRoute.POST(req("/api/orders/P-1/exchange",{revision:current.orders[0].revision,article:"Bolso cambiado",quantity:1,unitCents:77001,photoKey:"",notes:"Cambio web",date:"2026-10-18"}),{params:Promise.resolve({id:"P-1"})}),201)).exchange;
   await result(quoteRoute.POST(req("/api/quotes",{quote:{id:"Q-WEB",clientId:"C-1",date:"2026-10-18",validUntil:"2026-10-25",status:"Borrador",notes:"Propuesta sin deuda",revision:0,items:[{id:"LINE-WEB",article:"Camisa",variant:"M",platform:"SHEIN",quantity:2,unitCents:12345,extraCents:9,discountCents:10}]}})),201);
   await result(draftRoute.POST(req("/api/invoice-drafts",{draft:{id:"DRAFT-WEB",clientId:"C-1",date:"2026-10-18",businessName:"",notes:"Solo aviso",pricingMode:"manual",manualTotalCents:80001,showAmounts:true,revision:0,items:[{orderId:"P-1",deliveryLabel:"Sigue pendiente"}]}})),201);
   await result(push.POST(req("/api/onedrive/push",body())),200);
   const parsed=await parseExcel(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));assert.deepEqual(parsed.errors,[]);
   assert.equal(parsed.clients[0].name,"Ana renombrada");assert.equal(parsed.orders[0].clientId,"C-1");assert.equal(parsed.orders[0].client,"Ana renombrada");assert.deepEqual(parsed.payments,[payment]);assert.deepEqual(parsed.exchanges,[exchange]);assert.equal(parsed.quotes[0].totalCents,24689);assert.equal(parsed.invoiceDrafts[0].id,"DRAFT-WEB");
   assert.equal(await scalar("SELECT count(*)::int n FROM invoices"),0);
   etag='"metadata-only-new-version"';const copy=await download.GET(req("/api/onedrive/download"));assert.equal(copy.status,200);
   const incoming=await parseExcel(await copy.arrayBuffer()),imported=await result(sync.POST(req("/api/onedrive/sync",{...incoming,...body()})),200);
   assert.equal(imported.changes.createdPayments,0);assert.equal(imported.changes.createdExchanges,0);assert.equal(await scalar("SELECT count(*)::int n FROM invoices"),0);assert.equal(await scalar("SELECT count(*)::int n FROM payments"),1);assert.equal(await scalar("SELECT count(*)::int n FROM exchanges"),1);
  });
  await t.test("a newer eTag with different bytes never acknowledges an uncertain write",async()=>{
   await mutate({notes:"Envío pendiente de verificar"});const sourceEtag=etag,baseline=await scalar("SELECT local_revision n FROM onedrive_baselines WHERE order_id='P-1'");mode="accepted-timeout";await result(push.POST(req("/api/onedrive/push",body())),502);mode="success";const targetBytes=bytes,count=puts;
   const external=await parseExcel(targetBytes.buffer.slice(targetBytes.byteOffset,targetBytes.byteOffset+targetBytes.byteLength));external.orders[0].notes="Editado directamente en OneDrive después";
   bytes=await patchWorkbook(targetBytes,{orders:external.orders,clients:[],quotes:[],invoiceDrafts:[],payments:[],exchanges:[],invoices:[]});etag='"external-different"';
   const rejected=await result(push.POST(req("/api/onedrive/push",{fileId,etag:sourceEtag})),409);assert.equal(rejected.writePending,true);assert.equal(puts,count);assert.equal(await scalar("SELECT local_revision n FROM onedrive_baselines WHERE order_id='P-1'"),baseline);assert.equal(await scalar("SELECT count(*)::int n FROM onedrive_write_jobs"),1);
   // Simulate the owner restoring the exact captured file, rather than silently
   // accepting an unrelated newer version as proof of the lost response.
   bytes=targetBytes;etag='"exact-target-restored"';const recovered=await result(push.POST(req("/api/onedrive/push",{fileId,etag:sourceEtag})),200);assert.equal(recovered.recovered,true);assert.equal(puts,count);
  });
  await t.test("disconnect and reconnect same file during PUT cannot acknowledge a new generation",async()=>{
   const edited=await mutate({notes:"Cambio de conexión"}),previousBaseline=await scalar("SELECT local_revision n FROM onedrive_baselines WHERE order_id='P-1'");duringPut=()=>fixture.pool.query("UPDATE onedrive_connections SET revision=revision+2,refresh_cipher=$1,access_cipher=$2 WHERE owner_id='owner-A'",[refresh,access]);
   const failed=await result(push.POST(req("/api/onedrive/push",body())),502);assert.equal(failed.writePending,true);assert.equal(await scalar("SELECT local_revision n FROM onedrive_baselines WHERE order_id='P-1'"),previousBaseline);assert.equal(await scalar("SELECT count(*)::int n FROM onedrive_write_jobs"),1);assert.ok(edited.revision>previousBaseline);
   const blocked=await result(push.POST(req("/api/onedrive/push",body())),409);assert.equal(blocked.writePending,true);assert.equal(await scalar("SELECT local_revision n FROM onedrive_baselines WHERE order_id='P-1'"),previousBaseline);
  });
  await t.test("explicit reset requires current reviewed job and old lease, preserves business and audits once",async()=>{
   const job=(await fixture.pool.query("SELECT target_hash,created_at FROM onedrive_write_jobs WHERE owner_id='owner-A'")).rows[0],payload={expectedTargetHash:job.target_hash,preparedAt:job.created_at,reviewed:true},putCount=puts;
   const snapshot=await read();delete snapshot.activities;
   const baselines=async()=>{const all={};for(const table of["onedrive_baselines","business_baselines","onedrive_ledger_baselines","onedrive_output_baselines"])all[table]=(await fixture.pool.query(`SELECT * FROM ${table} WHERE owner_id='owner-A' ORDER BY 1,2,3`)).rows;return all;};
   const beforeBaselines=await baselines(),auditCount=await scalar("SELECT count(*)::int n FROM activities WHERE kind='Sincronización revisada'");
   const actualFetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error("Reset must never call Microsoft or storage");};
   try{
    await result(reset.POST(req("/api/onedrive/write-reset",{...payload,expectedTargetHash:"a".repeat(64)})),409);
    await result(reset.POST(req("/api/onedrive/write-reset",{...payload,reviewed:false})),400);
    await result(reset.POST(req("/api/onedrive/write-reset",payload)),409);
    globalThis.__postgresTestUser={userId:"owner-B"};await result(reset.POST(req("/api/onedrive/write-reset",payload)),409);globalThis.__postgresTestUser={userId:"owner-A"};
    const old=new Date(Date.now()-180000).toISOString();await fixture.pool.query("UPDATE onedrive_write_jobs SET created_at=$1 WHERE owner_id='owner-A'",[old]);
    const requests=await Promise.all([1,2].map(()=>reset.POST(req("/api/onedrive/write-reset",{...payload,preparedAt:old}))));assert.deepEqual(requests.map(r=>r.status).sort(),[200,409]);const success=await requests.find(r=>r.status===200).json();assert.equal(success.cleared,true);assert.equal(success.requiresPull,true);
   }finally{globalThis.fetch=actualFetch;globalThis.__postgresTestUser={userId:"owner-A"};}
   assert.equal(puts,putCount);assert.equal(await scalar("SELECT count(*)::int n FROM onedrive_write_jobs"),0);assert.deepEqual(await baselines(),beforeBaselines);const after=await read();delete after.activities;assert.deepEqual(after,snapshot);assert.equal(await scalar("SELECT count(*)::int n FROM activities WHERE kind='Sincronización revisada'"),auditCount+1);
   const cache=(await fixture.pool.query("SELECT etag,synced_etag,downloaded_etag FROM onedrive_connections WHERE owner_id='owner-A'")).rows[0];assert.deepEqual(cache,{etag:"",synced_etag:"",downloaded_etag:""});
  });
 }finally{globalThis.fetch=oldFetch;globalThis.__postgresTestBucket=oldBucket;for(const key of envKeys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}await fixture.cleanup();}
});
