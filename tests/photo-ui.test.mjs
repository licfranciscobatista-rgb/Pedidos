import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { File } from "node:buffer";
import ts from "typescript";

const source = readFileSync(new URL("../app/organizador.tsx", import.meta.url), "utf8") + "\nexport { OrderPhoto, PhotoLightbox, preparePhoto };";
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const order = { photoKey: "owner/photo.png", article: "Bolso", client: "Ana", quantity: 1, unitCents: 10000, extraCents: 0, discountCents: 0 };
const photo = { url: "/api/photos/owner%2Fphoto.png", title: "Bolso", client: "Ana", price: 10000 };

function harness({ width = 4000, height = 2000, pngBytes = 50 } = {}) {
  let cursor = 0, tree, target, props, closedBitmap = 0;
  const slots = [], effects = [], cleanups = [], listeners = [];
  const document = { body: { style: { overflow: "auto" } }, activeElement: null,
    addEventListener(name, callback, capture = false) { listeners.push({ name, callback, capture }); },
    removeEventListener(name, callback) { const index = listeners.findIndex(item => item.name === name && item.callback === callback); if (index >= 0) listeners.splice(index, 1); },
    createElement(name) { assert.equal(name, "canvas"); return canvas; },
  };
  const opener = { isConnected: true, focus() { document.activeElement = opener; } }; document.activeElement = opener;
  const canvas = { width: 0, height: 0, getContext() { return { drawImage() {} }; }, toBlob(callback) { callback(new Blob([new Uint8Array(pngBytes)], { type: "image/png" })); } };
  const jsx = (type, props) => ({ type, props });
  const react = { useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial; return [slots[index], value => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }]; }, useRef(value) { return { current: value }; }, useEffect(effect) { effects.push(effect); }, useCallback(fn) { return fn; }, useMemo(fn) { return fn(); } };
  const loaded = { exports: {} };
  runInNewContext(compiled, { module: loaded, exports: loaded.exports, document, File, Blob, crypto, URL, console,
    async createImageBitmap() { return { width, height, close() { closedBitmap++; } }; },
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
      if (name === "react-dom") return { createPortal: node => node };
      if (name === "lucide-react") return new Proxy({}, { get: (_, key) => key });
      if (name === "../lib/types") return { STATUSES: [], orderTotal: order => order.quantity * order.unitCents + order.extraCents - order.discountCents };
      return { default: name };
    },
  });
  const flatten = value => Array.isArray(value) ? value.flatMap(flatten) : value && typeof value === "object" ? [value, ...flatten(value.props?.children)] : [];
  const render = () => {
    cursor = 0; tree = loaded.exports[target](props);
    const nodes = flatten(tree), focused = nodes.filter(node => node.type === "button" || node.type === "a").map(node => ({ node, isConnected: true, focus() { document.activeElement = this; } }));
    for (const node of nodes) if (node.props?.ref) node.props.ref.current = { isConnected: true, focus() { document.activeElement = this; }, querySelectorAll() { return focused; } };
    return tree;
  };
  return { api: loaded.exports, document, opener, canvas, get closedBitmap() { return closedBitmap; },
    mount(name, value) { target = name; props = value; render(); for (const effect of effects.splice(0)) { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); } },
    render, nodes(type) { return flatten(tree).filter(node => type === undefined || node.type === type); },
    key(key, shiftKey = false) { const event = { key, shiftKey, defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.stopped = true; } }; for (const item of [...listeners].sort((a, b) => Number(b.capture) - Number(a.capture))) { if (item.name === "keydown") item.callback(event); if (event.stopped) break; } return event; },
    cleanup() { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); },
  };
}

test("Las fotos se resuelven únicamente desde la clave guardada; no se inventan por el artículo", () => {
  const { api } = harness();
  assert.equal(api.resolvePhotoUrl({ article: "Bolso de cocina", notes: "vestido", photoUrl: "https://example.com/stock.jpg" }), "");
  assert.equal(api.resolvePhotoUrl(order), "/api/photos/owner%2Fphoto.png");
  assert.equal(api.resolvePhotoUrl({ photoKey: "https://example.com/photo.jpg" }), "/api/photos/https%3A%2F%2Fexample.com%2Fphoto.jpg");
});

test("Una foto real se amplía con botón y un error vuelve al placeholder sin sustitutos", () => {
  const h = harness(); let opened;
  h.mount("OrderPhoto", { order, onPreview(value) { opened = value; } });
  const button = h.nodes("button")[0]; assert.equal(button.props.type, "button");
  assert.match(button.props["aria-label"], /Ampliar foto de Bolso/); button.props.onClick();
  assert.equal(opened.url, photo.url);
  h.nodes("img")[0].props.onError(); h.render();
  assert.equal(h.nodes("button").length, 0); assert.equal(h.nodes("img").length, 0);
  assert.equal(h.nodes("span")[0].props["aria-label"], "Foto no disponible");
  h.mount("OrderPhoto", { order: { ...order, photoKey: "" }, onPreview() { assert.fail("No hay foto"); } });
  assert.equal(h.nodes("button").length, 0);
});

test("El lightbox mantiene el foco, cierra solo la foto con Escape y devuelve el foco al origen", () => {
  const h = harness(); let closed = 0, parentClosed = 0;
  h.document.addEventListener("keydown", event => { if (event.key === "Escape") parentClosed++; });
  h.mount("PhotoLightbox", { photo, onClose() { closed++; } });
  const dialog = h.nodes("div").find(node => node.props.role === "dialog");
  assert.equal(dialog.props["aria-modal"], "true"); assert.equal(h.document.body.style.overflow, "hidden");
  const focusables = dialog.props.ref.current.querySelectorAll();
  h.key("Tab"); assert.equal(h.document.activeElement, focusables[0]);
  h.key("Tab", true); assert.equal(h.document.activeElement, focusables.at(-1));
  h.key("Tab"); assert.equal(h.document.activeElement, focusables[0]);
  h.key("Escape"); assert.equal(closed, 1); assert.equal(parentClosed, 0);
  h.cleanup(); assert.equal(h.document.activeElement, h.opener); assert.equal(h.document.body.style.overflow, "auto");
});

test("El lightbox muestra el fallo de carga y retira el acceso a la foto que falló", () => {
  const h = harness(); h.mount("PhotoLightbox", { photo, onClose() {} });
  h.nodes("img")[0].props.onError(); h.render();
  assert.equal(h.nodes("img").length, 0); assert.equal(h.nodes("a").length, 0);
  assert.equal(h.nodes("p").some(node => node.props.role === "status"), true);
});

test("JPEG y PNG conservan el archivo original y se rechazan tipo, vacío y exceso de tamaño", async () => {
  const h = harness();
  for (const type of ["image/jpeg", "image/png"]) { const input = new File(["original"], "photo", { type }); assert.equal(await h.api.preparePhoto(input), input); }
  await assert.rejects(h.api.preparePhoto(new File(["gif"], "photo.gif", { type: "image/gif" })), /JPG, PNG o WebP/);
  await assert.rejects(h.api.preparePhoto(new File([], "photo.png", { type: "image/png" })), /5 MB/);
  await assert.rejects(h.api.preparePhoto(new File([new Uint8Array(5 * 1024 * 1024 + 1)], "photo.png", { type: "image/png" })), /5 MB/);
});

test("WebP conserva proporción, no amplía fotos pequeñas y libera el bitmap incluso al rechazar", async () => {
  const input = new File(["webp"], "photo.webp", { type: "image/webp" });
  const h = harness(); const result = await h.api.preparePhoto(input);
  assert.equal(result.type, "image/png"); assert.equal(h.canvas.width, 1600); assert.equal(h.canvas.height, 800); assert.equal(h.closedBitmap, 1);
  const small = harness({ width: 400, height: 200 }); await small.api.preparePhoto(input);
  assert.equal(small.canvas.width, 400); assert.equal(small.canvas.height, 200);
  const invalid = harness({ width: 0, height: 200 }); await assert.rejects(invalid.api.preparePhoto(input), /dimensiones/); assert.equal(invalid.closedBitmap, 1);
  const large = harness({ width: 10000, height: 10000 }); await assert.rejects(large.api.preparePhoto(input), /megapíxeles/); assert.equal(large.closedBitmap, 1);
  const oversized = harness({ pngBytes: 5 * 1024 * 1024 + 1 }); await assert.rejects(oversized.api.preparePhoto(input), /5 MB/); assert.equal(oversized.closedBitmap, 1);
});
