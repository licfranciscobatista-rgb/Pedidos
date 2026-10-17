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
  const module = { exports: {} };
  runInNewContext(compiled, {
    module, exports: module.exports,
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
      requests.push({ path, method: options.method || "GET" });
      if (path === "/api/onedrive/status") return Response.json(status);
      if (path === "/api/onedrive/download") {
        if (responseStatus !== 200) return Response.json({ error: "Microsoft o el archivo requieren revisión." }, { status: responseStatus });
        return new Response(new Uint8Array([0x50, 0x4b, 3, 4]), { headers: { "X-OneDrive-Etag": etag, "X-OneDrive-File-Id": "book" } });
      }
      if (path === "/api/onedrive/sync") {
        status.selectedFile.syncedEtag = JSON.parse(options.body).etag;
        return Response.json({ changes: { createdOrders: 1 } });
      }
      throw new Error(`Unexpected request: ${path}`);
    },
  });
  const render = () => { cursor = 0; tree = module.exports.default({ manualBusy: false, onSyncBusy() {}, onSynced() { synced++; } }); return tree; };
  const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(setImmediate); render(); };
  const text = node => typeof node === "string" || typeof node === "number" ? String(node) : Array.isArray(node) ? node.map(text).join(" ") : node?.props ? text(node.props.children) : "";
  return {
    requests,
    setPreview(value) { preview = value; },
    setEtag(value) { etag = value; },
    setResponseStatus(value) { responseStatus = value; },
    setVisible(value) { document.visibilityState = value ? "visible" : "hidden"; },
    get parseCount() { return parseCount; },
    get synced() { return synced; },
    get text() { return text(tree); },
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
