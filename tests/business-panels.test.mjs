import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const order = { id: "P-1", client: "Ana", phone: "809-555-1234", article: "Bolso", variant: "", quantity: 2, unitCents: 65000, extraCents: 10000, discountCents: 5000, status: "En camino", date: "2026-10-18", platform: "Temu" };
const client = { id: "C-1", name: "Ana", phone: "8095551234", active: true };
const draft = { id: "D-1", clientId: "C-1", date: "2026-10-18", pricingMode: "manual", manualTotalCents: 0, showAmounts: false, items: [{ orderId: "P-1", deliveryLabel: "Sigue pendiente" }], revision: 2, notes: "", businessName: "" };
const money = cents => `RD$${cents / 100}`;
const norm = value => value.trim().toLowerCase();
const orderTotal = item => item.quantity * item.unitCents + item.extraCents - item.discountCents;

// The actual event handlers run against a local hook/DOM harness. It never
// connects to an application, database, Microsoft account or photo service.
function componentHarness(file, exported, props, customStates = {}) {
  let cursor = 0, tree, fail = false;
  const slots = [], calls = [], effects = [], listeners = new Map();
  const react = { useState(initial) { const index = cursor++; const cell = slots[index] ??= { value: index in customStates ? customStates[index] : typeof initial === "function" ? initial() : initial }; return [cell.value, next => { cell.value = typeof next === "function" ? next(cell.value) : next; }]; }, useMemo(fn) { return fn(); }, useCallback(fn) { return fn; }, useEffect(effect) { effects.push(effect); }, useRef(value) { return { current: value }; } };
  const jsx = (type, props) => ({ type, props });
  const source = readFileSync(new URL(`../app/${file}`, import.meta.url), "utf8") + (exported === "default" ? "" : `\nexport { ${exported} };`);
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const loaded = { exports: {} };
  runInNewContext(compiled, { module: loaded, exports: loaded.exports, crypto, Date, FormData: class { constructor(value) { this.value = value; } get(name) { return this.value[name] || ""; } }, window: { confirm: () => true },
    document: { body: { style: {} }, activeElement: null, addEventListener(name, listener) { listeners.set(name, listener); }, removeEventListener(name) { listeners.delete(name); } },
    async fetch(url, options) { calls.push({ url, body: JSON.parse(options.body) }); return Response.json({ invoice: { id: "I-1" } }); },
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
      if (name === "react-dom") return { createPortal: value => value };
      if (name === "lucide-react") return new Proxy({}, { get: (_, key) => key });
      if (name === "../lib/types") return { orderTotal, paidFor: () => 0, STATUSES: ["Pendiente", "Pedido", "En camino", "Recibido", "Entregado", "Cancelado", "Cambiado"] };
      if (name === "../lib/invoice-pdf") return { downloadInvoicePdf() {} };
      if (["./excel-panel", "./history-panel", "./account-menu", "./clients-panel", "./quotes-panel", "./invoices-panel"].includes(name)) return { default: name.slice(2) === "excel-panel" ? "ExcelPanel" : name.slice(2) };
      if (name === "./invoice-drafts-panel") return { default: "InvoiceDraftsPanel" };
      if (name === "./business-ui") return { BusinessDialog: "dialog", money, dateLabel: value => value || "Sin fecha", norm, today: () => "2026-10-18", async businessApi(url, method, body) { calls.push({ url, method, body }); if (fail) throw new Error("Fallo temporal"); return { invoice: { id: "I-1" } }; } };
      throw new Error(`Unexpected import ${name}`);
    },
  });
  const render = () => { cursor = 0; tree = loaded.exports[exported](props); return tree; };
  const flatten = node => Array.isArray(node) ? node.flatMap(flatten) : node && typeof node === "object" ? [node, ...flatten(node.props?.children)] : [];
  const text = node => typeof node === "string" || typeof node === "number" ? String(node) : Array.isArray(node) ? node.map(text).join(" ") : node?.props ? text(node.props.children) : "";
  render();
  return { calls, render, runEffects() { for (const effect of effects.splice(0)) effect(); }, keydown(key) { listeners.get("keydown")?.({ key }); }, setFailure(value) { fail = value; }, nodes(type) { return flatten(tree).filter(node => type === undefined || node.type === type); }, button(label) { const node = flatten(tree).find(node => node.type === "button" && text(node).includes(label)); assert.ok(node, `Missing button ${label}`); return node; }, get text() { return text(tree); }, async submit(values) { const form = flatten(tree).find(node => node.type === "form"); assert.ok(form); await form.props.onSubmit({ preventDefault() {}, currentTarget: values }); render(); } };
}

test("La emisión directa sin importes no exige un monto manual ni nombre de negocio", async () => {
  let created = 0;
  const panel = componentHarness("invoices-panel.tsx", "InvoiceCreator", { orders: [order], payments: [], invoices: [], onClose() {}, async onCreated() { created++; } }, { 0: "ana|8095551234", 1: ["P-1"], 2: "manual", 3: "", 4: false });
  await panel.submit({ businessName: "", notes: "Entrega parcial" });
  assert.equal(panel.calls.length, 1);
  assert.equal(panel.calls[0].body.showAmounts, false);
  assert.equal(panel.calls[0].body.pricingMode, "items");
  assert.equal(panel.calls[0].body.manualTotalCents, 0);
  assert.equal(panel.calls[0].body.businessName, "");
  assert.equal(created, 1);
});

test("El borrador relaciona teléfonos con guiones y permite un aviso de entrega sin monto", async () => {
  let saved = 0;
  const panel = componentHarness("invoice-drafts-panel.tsx", "DraftEditor", { initial: draft, clients: [client], orders: [order, { ...order, id: "P-OTHER", phone: "8290000000" }], onClose() {}, async onSaved() { saved++; } }, { 3: "" });
  assert.match(panel.text, /Bolso/);
  assert.doesNotMatch(panel.text, /P-OTHER/);
  await panel.submit({ date: "2026-10-18" });
  assert.equal(panel.calls.length, 1);
  assert.equal(panel.calls[0].url, "/api/invoice-drafts");
  assert.equal(panel.calls[0].body.draft.pricingMode, "items");
  assert.equal(panel.calls[0].body.draft.showAmounts, false);
  assert.equal(saved, 1);
});

test("El ID Cliente conserva la relación después de renombrar un cliente", async () => {
  const panel = componentHarness("invoice-drafts-panel.tsx", "DraftEditor", { initial: draft, clients: [{ ...client, name: "Ana Renombrada", phone: "8299999999" }], orders: [{ ...order, clientId: "C-1" }], onClose() {}, async onSaved() {} });
  assert.match(panel.text, /Bolso/);
  await panel.submit({ date: "2026-10-18" });
  assert.equal(panel.calls.length, 1);
  assert.equal(panel.calls[0].body.draft.clientId, "C-1");
});

test("Un pedido legado con dos clientes homónimos no se asocia arbitrariamente", async () => {
  const panel = componentHarness("invoice-drafts-panel.tsx", "DraftEditor", { initial: draft, clients: [client, { ...client, id: "C-2" }], orders: [order], onClose() {}, async onSaved() {} });
  assert.match(panel.text, /no tiene artículos activos/);
  await panel.submit({ date: "2026-10-18" });
  assert.equal(panel.calls.length, 0);
});

test("Un borrador solo emite tras confirmar y el reintento conserva su requestId", async () => {
  let issued = 0;
  const panel = componentHarness("invoice-drafts-panel.tsx", "default", { drafts: [draft], clients: [client], orders: [order], onSaved() {}, async onIssued() { issued++; }, onOpenInvoice() {} });
  assert.equal(panel.calls.length, 0);
  panel.button("Emitir factura").props.onClick(); panel.render();
  assert.equal(panel.calls.length, 0);
  assert.equal(panel.nodes("dialog")[0].props.title, "Confirmar emisión");
  panel.setFailure(true);
  const confirmButton = panel.nodes("button").filter(node => node.props.onClick).at(-1);
  await confirmButton.props.onClick(); await new Promise(setImmediate); panel.render();
  assert.equal(panel.calls.length, 1);
  panel.setFailure(false);
  await panel.nodes("button").filter(node => node.props.onClick).at(-1).props.onClick(); await new Promise(setImmediate); panel.render();
  assert.equal(panel.calls.length, 2);
  assert.equal(panel.calls[0].body.requestId, panel.calls[1].body.requestId);
  assert.equal(panel.calls[1].body.sourceDraftId, "D-1");
  assert.equal(panel.calls[1].body.sourceDraftRevision, 2);
  assert.equal(issued, 1);
});

test("Una cotización calcula líneas y cargos sin llamar al endpoint de facturas o pagos", async () => {
  const quote = { id: "Q-1", clientId: "C-1", date: "2026-10-18", validUntil: "", status: "Borrador", notes: "", revision: 1, totalCents: 135000, items: [{ ...order, id: "LINE-1" }] };
  const panel = componentHarness("quotes-panel.tsx", "QuoteEditor", { initial: quote, clients: [client], onClose() {}, async onSaved() {} });
  await panel.submit({ clientId: "C-1", date: "2026-10-18", status: "Aceptada" });
  assert.equal(panel.calls.length, 1);
  assert.equal(panel.calls[0].url, "/api/quotes");
  assert.equal(panel.calls[0].body.quote.totalCents, 135000);
});

test("Una cotización con descuento mayor al importe conserva el error y no guarda", async () => {
  const panel = componentHarness("quotes-panel.tsx", "QuoteEditor", { clients: [client], onClose() {}, async onSaved() {} }, { 1: [{ id: "L", article: "Bolso", quantity: 1, unitCents: 100, extraCents: 0, discountCents: 200, variant: "", platform: "Temu" }] });
  await panel.submit({ clientId: "C-1", date: "2026-10-18" });
  assert.equal(panel.calls.length, 0);
  assert.match(panel.text, /revisa los artículos/);
});

test("La sincronización permanece montada fuera de Mi Excel y un conflicto muestra un acceso visible", () => {
  const panel = componentHarness("organizador.tsx", "default", {});
  assert.equal(panel.nodes("ExcelPanel").length, 1);
  assert.equal(panel.nodes("div").some(node => node.props.hidden === true), true);
  panel.nodes("ExcelPanel")[0].props.onSyncStatus({ error: "Conflicto de prueba: Excel y web cambiaron.", working: "", paused: true, conflict: true, writePending: true }); panel.render();
  assert.match(panel.text, /Hay cambios de Excel y de la web que debes revisar/);
  assert.match(panel.text, /Conflicto de prueba/);
  assert.equal(panel.nodes("div").some(node => node.props.role === "alert"), true);
  panel.button("Ir a Mi Excel").props.onClick(); panel.render();
  assert.equal(panel.nodes("ExcelPanel").length, 1);
  assert.equal(panel.nodes("div").some(node => node.props.hidden === false), true);
});

test("Un enlace de Historial abre directamente la factura emitida conocida", () => {
  const invoice = { id: "I-KNOWN", number: "F-001", client: "Ana", phone: "", issuedAt: "2026-10-18T12:00:00Z", orderIds: ["P-1"], items: [], totalCents: 0, paidCents: 0, balanceCents: 0, showAmounts: false };
  const panel = componentHarness("invoices-panel.tsx", "default", { orders: [], payments: [], invoices: [invoice], clients: [], drafts: [], onIssued() {}, initialInvoiceId: "I-KNOWN" });
  const opened = panel.nodes().find(node => typeof node.type === "function" && node.type.name === "InvoicePrint");
  assert.ok(opened);
  assert.equal(opened.props.invoice.id, "I-KNOWN");
  assert.match(panel.text, /Facturas emitidas/);
});

test("La emisión agrupa teléfonos equivalentes con guiones, espacios y paréntesis", async () => {
  const orders = [order, { ...order, id: "P-2", phone: "(809) 555 1234" }];
  const panel = componentHarness("invoices-panel.tsx", "InvoiceCreator", { orders, payments: [], invoices: [], onClose() {}, async onCreated() {} }, { 2: "items" });
  const clientPicker = panel.nodes("select")[0];
  assert.equal(panel.nodes("option").filter(option => option.props.value).length, 1);
  clientPicker.props.onChange({ target: { value: "ana|8095551234" } }); panel.render();
  await panel.submit({ businessName: "" });
  assert.equal(panel.calls.length, 1);
  assert.deepEqual(Array.from(panel.calls[0].body.orderIds), ["P-1", "P-2"]);
});

test("El filtro de emisión usa el mismo día local que muestra la factura", () => {
  const originalTimezone = process.env.TZ;
  try {
    process.env.TZ = "America/La_Paz";
    const invoice = { id: "I-NIGHT", number: "F-NOCHE", client: "Ana", phone: "", issuedAt: "2026-10-18T02:30:00Z", orderIds: [], items: [], totalCents: 0, paidCents: 0, balanceCents: 0, showAmounts: false };
    const panel = componentHarness("invoices-panel.tsx", "default", { orders: [], payments: [], invoices: [invoice], clients: [], drafts: [], onIssued() {} }, { 3: "issued", 5: "2026-10-17", 6: "2026-10-17" });
    assert.match(panel.text, /F-NOCHE/);
    assert.doesNotMatch(panel.text, /No encontramos esa factura/);
    panel.nodes("input").filter(input => input.props.type === "date")[0].props.onChange({ target: { value: "2026-10-18" } }); panel.render();
    assert.doesNotMatch(panel.text, /F-NOCHE/);
  } finally {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
  }
});

test("El diálogo de emisión no se cierra con Escape ni con el fondo mientras guarda", () => {
  let closed = 0;
  const panel = componentHarness("invoices-panel.tsx", "InvoiceDialog", { title: "Emitiendo", onClose() { closed++; }, busy: true });
  panel.runEffects(); panel.keydown("Escape");
  const backdrop = panel.nodes("div").find(node => node.props.className === "modal-backdrop"), target = {};
  backdrop.props.onMouseDown({ target, currentTarget: target });
  assert.equal(closed, 0);
  assert.equal(panel.nodes("button").find(node => node.props["aria-label"] === "Cerrar factura").props.disabled, true);
});
