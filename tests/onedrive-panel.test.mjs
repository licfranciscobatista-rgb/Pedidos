import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../app/onedrive-panel.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const emptyPreview = () => ({ orders: [], payments: [], exchanges: [], photos: [], errors: [], generatedIds: 0 });

// Exercise the panel's real effects, requests and UI state with a deterministic
// hook/scheduler harness. No browser, database, Microsoft account or business data.
function panelHarness() {
  let cursor = 0, timerId = 0, tree, etag = '"one"', responseStatus = 200;
  let preview = emptyPreview(), parseCount = 0, synced = 0;
  let pushResult = { written: 1, etag: '"web-write"' }, pushStatus = 200;
  const slots = [], effects = [], timeouts = new Map(), intervals = new Map(), requests = [];
  const status = { configured: true, connected: true, selectedFile: { id: "book", name: "original.xlsx", syncedEtag: "" } };
  const document = { visibilityState: "visible", addEventListener() {}, removeEventListener() {} };
  const react = {
    useState(initial) {
      const cell = slots[cursor++] ??= { value: initial };
      return [cell.value, value => { cell.value = typeof value === "function" ? value(cell.value) : value; }];
    },
    useRef(initial) { return slots[cursor++] ??= { current: initial }; },
    useCallback(callback) { return slots[cursor++] ??= callback; },
    useEffect(effect) { const index = cursor++; if (!slots[index]) { slots[index] = true; effects.push(effect); } },
  };
  const jsx = (type, props) => ({ type, props });
  const testModule = { exports: {} };
  runInNewContext(compiled, {
    module: testModule, exports: testModule.exports,
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
      if (name === "lucide-react") return new Proxy({}, { get: (_, key) => key });
      if (name === "../lib/excel") return { parseExcel: async () => { parseCount++; return preview; } };
      throw new Error(`Unexpected import: ${name}`);
    },
    setTimeout(callback, ms) { const id = ++timerId; timeouts.set(id, { callback, ms }); return id; },
    clearTimeout(id) { timeouts.delete(id); },
    setInterval(callback, ms) { const id = ++timerId; intervals.set(id, { callback, ms }); return id; },
    clearInterval(id) { intervals.delete(id); },
    document,
    window: { location: { search: "" } },
    AbortController, DOMException, URLSearchParams, FormData,
    async fetch(path, options = {}) {
      requests.push({ path, method: options.method || "GET", body: typeof options.body === "string" ? JSON.parse(options.body) : undefined });
      if (path === "/api/onedrive/status") return Response.json(status);
      if (path === "/api/onedrive/download") {
        if (responseStatus === 304) return new Response(null, { status: 304 });
        if (responseStatus !== 200) return Response.json({ error: "Microsoft o el archivo requieren revisión." }, { status: responseStatus });
        return new Response(new Uint8Array([0x50, 0x4b, 3, 4]), { headers: { "X-OneDrive-Etag": etag, "X-OneDrive-File-Id": "book" } });
      }
      if (path === "/api/onedrive/sync") {
        status.selectedFile.syncedEtag = JSON.parse(options.body).etag;
        return Response.json({ changes: { createdOrders: 1 } });
      }
      if (path === "/api/onedrive/push") {
        if (pushStatus === 200) { status.selectedFile.syncedEtag = pushResult.etag || status.selectedFile.syncedEtag; etag = pushResult.etag || etag; status.writePending = false; }
        return Response.json(pushResult, { status: pushStatus });
      }
      if (path === "/api/onedrive/write-reset") {
        status.writePending = false; status.pendingWrite = null; status.selectedFile.syncedEtag = "";
        return Response.json({cleared:true,requiresPull:true,message:"Confirmación descartada después de revisar; vuelve a leer Excel."});
      }
      throw new Error(`Unexpected request: ${path}`);
    },
  });
  const render = () => { cursor = 0; tree = testModule.exports.default({ manualBusy: false, onSyncBusy() {}, onSynced() { synced++; } }); return tree; };
  const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(setImmediate); render(); };
  const text = node => typeof node === "string" || typeof node === "number" ? String(node) : Array.isArray(node) ? node.map(text).join(" ") : node?.props ? text(node.props.children) : "";
  const find = (node, predicate) => { if (!node || typeof node !== "object") return; if (Array.isArray(node)) { for (const child of node) { const found=find(child,predicate); if(found)return found; } return; } if(predicate(node))return node;return find(node.props?.children,predicate); };
  return {
    requests,
    setPreview(value) { preview = value; },
    setEtag(value) { etag = value; },
    setResponseStatus(value) { responseStatus = value; },
    setWritable(value) { status.canWrite = value; },
    setPending(value) { status.writePending = value; status.selectedFile.syncedEtag = '"one"'; status.pendingWrite=value?{fileId:"book",sourceEtag:'"one"',targetHash:"a".repeat(64),preparedAt:"2026-10-18T12:00:00Z"}:null; },
    setPushResult(value, status = 200) { pushResult = value; pushStatus = status; },
    setVisible(value) { document.visibilityState = value ? "visible" : "hidden"; },
    get parseCount() { return parseCount; },
    get synced() { return synced; },
    get text() { return text(tree); },
    reviewPending() { const checkbox=find(tree,node=>node.type==="input"&&node.props.type==="checkbox");assert.ok(checkbox);checkbox.props.onChange({target:{checked:true}});render(); },
    async discardPending() { const button=find(tree,node=>node.type==="button"&&text(node).includes("Descartar confirmación después de revisar"));assert.ok(button);button.props.onClick();await flush(); },
    async start() {
      render(); while (effects.length) effects.shift()();
      for (const [id, timer] of timeouts) if (timer.ms === 0) { timeouts.delete(id); timer.callback(); }
      await flush();
    },
    async tick() {
      for (const timer of intervals.values()) { assert.equal(timer.ms, 60_000); timer.callback(); }
      await flush();
    },
  };
}

test("Una fila incompleta conserva el aviso, no importa un lote parcial y vuelve a leer al siguiente minuto", async () => {
  const panel = panelHarness();
  panel.setPreview({ ...emptyPreview(), orders: [{ id: "P-LOCAL" }], photos: [{ orderId: "P-LOCAL" }], errors: ["Pedidos, fila 3: falta Cliente."] });
  await panel.start();
  assert.match(panel.text, /falta Cliente/);
  assert.match(panel.text, /volverá a comprobarlo cada 60 segundos/);
  assert.doesNotMatch(panel.text, /Automática pausada/);
  assert.equal(panel.requests.filter(request => request.method === "POST").length, 0);
  panel.setVisible(false);
  await panel.tick();
  assert.equal(panel.parseCount, 1);
  assert.match(panel.text, /falta Cliente/);
  panel.setVisible(true);
  await panel.tick();
  assert.equal(panel.parseCount, 2);
  assert.match(panel.text, /falta Cliente/);
  assert.equal(panel.requests.filter(request => request.method === "POST").length, 0);

  panel.setEtag('"two"');
  panel.setPreview({ ...emptyPreview(), orders: [{ id: "P-LOCAL" }] });
  await panel.tick();
  assert.equal(panel.requests.filter(request => request.path === "/api/onedrive/sync").length, 1);
  assert.equal(panel.synced, 1);
  assert.doesNotMatch(panel.text, /falta Cliente/);
  assert.match(panel.text, /1 registro actualizado/);
});

test("El aviso del libro vacío permanece después de comprobar otra vez el mismo eTag", async () => {
  const panel = panelHarness();
  await panel.start();
  assert.match(panel.text, /El libro solo tiene encabezados/);
  await panel.tick();
  assert.match(panel.text, /El libro solo tiene encabezados/);
  assert.equal(panel.parseCount, 1);
  assert.equal(panel.requests.filter(request => request.method === "POST").length, 0);
});

test("Un libro con clientes y documentos, sin pedidos nuevos, envía todas las colecciones a la sincronización", async () => {
  const panel = panelHarness();
  const clients = [{id:"CLI-001",name:"Prueba"}], quotes = [{id:"COT-001",clientId:"CLI-001"}], invoiceDrafts = [{id:"BOR-001",clientId:"CLI-001"}];
  panel.setPreview({ ...emptyPreview(), clients, quotes, invoiceDrafts });
  await panel.start();
  const committed = panel.requests.find(request => request.path === "/api/onedrive/sync");
  assert.deepEqual(committed.body.clients, clients);
  assert.deepEqual(committed.body.quotes, quotes);
  assert.deepEqual(committed.body.invoiceDrafts, invoiceDrafts);
  assert.equal(panel.synced, 1);
  assert.doesNotMatch(panel.text, /solo tiene encabezados/);
});

test("La conexión de lectura ofrece autorizar escritura sin enviar cambios silenciosamente", async () => {
  const panel = panelHarness(); panel.setWritable(false);
  await panel.start();
  assert.match(panel.text, /solo lectura de Excel/);
  assert.match(panel.text, /Activar envío web → Excel/);
  assert.equal(panel.requests.filter(request => request.path === "/api/onedrive/push").length, 0);
});

test("Con escritura se importa incluso un libro vacío antes de enviar los registros web", async () => {
  const panel = panelHarness(); panel.setWritable(true);
  await panel.start();
  const imported = panel.requests.findIndex(request => request.path === "/api/onedrive/sync");
  const pushed = panel.requests.findIndex(request => request.path === "/api/onedrive/push");
  assert.ok(imported >= 0 && pushed > imported);
  assert.match(panel.text, /registros de la web enviados al Excel original/);
});

test("Una respuesta 304 también comprueba cambios web pendientes", async () => {
  const panel = panelHarness(); panel.setWritable(true); panel.setResponseStatus(304);
  await panel.start();
  assert.equal(panel.requests.filter(request => request.path === "/api/onedrive/push").length, 1);
  assert.equal(panel.parseCount, 0);
});

test("Un envío pendiente se verifica antes de intentar importar otra vez el libro", async () => {
  const panel = panelHarness(); panel.setWritable(true); panel.setPending(true); panel.setPushResult({written:1,etag:'"recovered"',recovered:true});
  await panel.start();
  assert.equal(panel.requests.filter(request => request.path === "/api/onedrive/push").length, 1);
  assert.equal(panel.requests.filter(request => request.path === "/api/onedrive/download" || request.path === "/api/onedrive/sync").length, 0);
  assert.match(panel.text, /verificado por sus bytes/);
});

test("Un conflicto de escritura pausa la automática y conserva el aviso de revisión", async () => {
  const panel = panelHarness(); panel.setWritable(true); panel.setResponseStatus(304); panel.setPushResult({error:"Excel cambió: revisar ambas versiones",requiresPull:true},409);
  await panel.start();
  assert.match(panel.text, /revisar ambas versiones/);
  assert.match(panel.text, /Conflicto/);
  await panel.tick();
  assert.equal(panel.requests.filter(request => request.path === "/api/onedrive/push").length, 1);
});

test("Descartar una confirmación pendiente requiere revisar y envía la versión exacta del trabajo", async () => {
  const panel=panelHarness();panel.setWritable(true);panel.setPending(true);panel.setPushResult({error:"La conexión cambió durante un envío pendiente.",writePending:true},409);
  await panel.start();
  assert.match(panel.text,/Descartar confirmación después de revisar/);
  await panel.discardPending();assert.equal(panel.requests.filter(request=>request.path==="/api/onedrive/write-reset").length,0);
  panel.reviewPending();await panel.discardPending();
  const reset=panel.requests.find(request=>request.path==="/api/onedrive/write-reset");assert.ok(reset);assert.equal(reset.body.reviewed,true);assert.equal(reset.body.expectedTargetHash,"a".repeat(64));assert.equal(reset.body.preparedAt,"2026-10-18T12:00:00Z");
  assert.match(panel.text,/Confirmación descartada después de revisar/);
  assert.equal(panel.requests.filter(request=>request.path==="/api/onedrive/sync").length,0,"discarding must not silently import or acknowledge business records");
});

for (const status of [401, 409, 500]) test(`Un error ${status} conserva la pausa y no vuelve a descargar automáticamente`, async () => {
  const panel = panelHarness();
  panel.setResponseStatus(status);
  await panel.start();
  assert.match(panel.text, status === 409 ? /Conflicto/ : /Automática pausada/);
  assert.match(panel.text, /Microsoft o el archivo requieren revisión/);
  await panel.tick();
  assert.equal(panel.requests.filter(request => request.path === "/api/onedrive/download").length, 1);
  assert.equal(panel.requests.filter(request => request.method === "POST").length, 0);
});
