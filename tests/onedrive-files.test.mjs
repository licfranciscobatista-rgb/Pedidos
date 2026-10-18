import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

function loadModule(path, imports = {}) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  runInNewContext(compiled, { module, exports: module.exports, URL, require(name) { if (name in imports) return imports[name]; throw new Error(`Unexpected import: ${name}`); } });
  return module.exports;
}
const validation = loadModule("../lib/validation.ts");
const book = { id: "original-book", name: "PROGRAMA  DE PEDIDOS.xlsx", size: 18973, file: {}, parentReference: { path: "/drive/root:/Documents" }, webUrl: "https://onedrive.live.com/original" };
const fields = "id,name,size,lastModifiedDateTime,webUrl,parentReference,file,remoteItem";

// Invoke the real route and real text validator, replacing only its authenticated
// context and Microsoft transport. No database, tokens or remote services are used.
function handler(result) {
  const calls = [], db = {}, config = {};
  const route = loadModule("../app/api/onedrive/files/route.ts", {
    "@/lib/validation": validation,
    "../../_shared": {
      context: async () => ({ db, ownerId: "owner-A" }),
      json: value => Response.json(value),
      route: async work => { try { return await work(); } catch (error) { return Response.json({ error: error.message }, { status: error.status || 500 }); } },
    },
    "../_core": {
      requireConfig: () => config,
      graph: async (database, ownerId, suppliedConfig, path) => {
        assert.equal(database, db); assert.equal(ownerId, "owner-A"); assert.equal(suppliedConfig, config);
        calls.push(path); return Response.json(result);
      },
    },
  });
  return { calls, get(query) { const url = new URL("https://pedidos.example/api/onedrive/files"); url.searchParams.set("query", query); return route.GET(new Request(url)); } };
}

test("La ruta exacta encuentra el original conservando sus dos espacios y el contrato files", async () => {
  for (const query of ["Documents/PROGRAMA  DE PEDIDOS.xlsx", "/Documents/PROGRAMA  DE PEDIDOS.xlsx"]) {
    const route = handler(book), response = await route.get(query);
    assert.equal(response.status, 200);
    assert.deepEqual(route.calls, [`/me/drive/root:/Documents/PROGRAMA%20%20DE%20PEDIDOS.xlsx?$select=${fields}`]);
    assert.deepEqual(await response.json(), { files: [{ id: book.id, name: book.name, size: book.size, lastModifiedAt: "", webUrl: book.webUrl, parentPath: "/drive/root:/Documents" }] });
  }
});

test("La ruta codifica cada segmento sin convertir caracteres del nombre en parámetros", async () => {
  const route = handler(book), response = await route.get("Documentos/Árbol #1/Libro ? revisión.xlsx");
  assert.equal(response.status, 200);
  assert.equal(route.calls[0], `/me/drive/root:/Documentos/%C3%81rbol%20%231/Libro%20%3F%20revisi%C3%B3n.xlsx?$select=${fields}`);
});

test("Rutas ambiguas o de más de 300 caracteres se rechazan antes de consultar Microsoft", async () => {
  for (const query of ["/", "//Documents/Libro.xlsx", "Documents//Libro.xlsx", "Documents/Libro.xlsx/", "Documents/./Libro.xlsx", "Documents/../Libro.xlsx", "Documents/ /Libro.xlsx", "Documents\\Libro.xlsx", "Documents/" + "a".repeat(300) + ".xlsx"]) {
    const route = handler(book), response = await route.get(query);
    assert.equal(response.status, 400, query);
    assert.equal(route.calls.length, 0, query);
  }
});

test("Resolver una ruta conserva el filtro de libro propio y excluye remotos o archivos ajenos al formato", async () => {
  for (const result of [{ ...book, remoteItem: { id: "shared-book" } }, { ...book, file: undefined }, { ...book, name: "not-a-book.pdf" }]) {
    const response = await handler(result).get("Documents/Libro.xlsx");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { files: [] });
  }
});

test("La búsqueda normal conserva su endpoint, escape y filtro existentes", async () => {
  const route = handler({ value: [book, { ...book, id: "remote", remoteItem: {} }, { id: "folder", name: "PROGRAMA" }] });
  const response = await route.get("PROGRAMA");
  assert.equal(response.status, 200);
  assert.deepEqual(route.calls, [`/me/drive/root/search(q='PROGRAMA')?$select=${fields}&$top=50`]);
  assert.deepEqual((await response.json()).files.map(item => item.id), [book.id]);
  const escaped = handler({ value: [] });
  await escaped.get("Ana's libro");
  assert.equal(escaped.calls[0], `/me/drive/root/search(q='Ana''s%20libro')?$select=${fields}&$top=50`);
});
