import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stub = new URL("./onedrive-unit-stubs.mjs", import.meta.url).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.endsWith("/_shared")) return { url: stub, shortCircuit: true };
  if (specifier.startsWith("@/")) return { url: pathToFileURL(resolve(root, specifier.slice(2)) + ".ts").href, shortCircuit: true };
  if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
    const candidate = fileURLToPath(new URL(specifier, context.parentURL));
    if (existsSync(candidate + ".ts")) return { url: pathToFileURL(candidate + ".ts").href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}});

const { encrypt, decrypt, hash, randomToken, configuration, oauthCookie, redirectBack } = await import("../app/api/onedrive/_core.ts");
const { planSync } = await import("../app/api/onedrive/_sync.ts");
const { parseOrder, parsePayment } = await import("../lib/validation.ts");

function order(overrides = {}) {
  return { id: "pedido-uno", platform: "Temu", client: "Ana", phone: "", batch: "Grupo 1", article: "Cartera", variant: "Azul", quantity: 1, unitCents: 10000, extraCents: 0, discountCents: 0, storeCents: 7000, status: "Pedido", date: "2026-10-17", deliveryDate: "", notes: "", photoKey: "", revision: 0, ...overrides };
}
const payment = { id: "pago-uno", orderId: "pedido-uno", amountCents: 5000, kind: "Abono", date: "2026-10-17", method: "Efectivo", note: "" };
async function orderHash(value) { const { revision, ...business } = parseOrder(value, "import"); return hash(JSON.stringify(business)); }
function plannerDatabase({ orders = [], baselines = [], payments = [], exchanges = [], ledgerBaselines = [] } = {}) {
  return {
    prepare(sql) { return { sql, bind(...values) { return { sql, values }; } }; },
    async batch(statements) {
      // The planner must perform one consistent read, scoped to the owner.
      assert.equal(statements.length, 5);
      for (const statement of statements) assert.equal(statement.values[0], "owner-A");
      for (const index of [1, 4]) assert.equal(statements[index].values[1], "excel-uno");
      return [orders, baselines, payments, exchanges, ledgerBaselines].map(results => ({ results, success: true, meta: { changes: 0 } }));
    },
  };
}
const input = (orders = [order()], payments = []) => ({ orders, payments, exchanges: [] });

test("OneDrive: AES-GCM binds tokens to their owner and rejects altered ciphertext", async () => {
  const secret = Buffer.alloc(32, 17).toString("base64");
  const sealed = await encrypt("private refresh token", secret, "owner-A");
  assert.ok(!sealed.includes("private"));
  assert.equal(await decrypt(sealed, secret, "owner-A"), "private refresh token");
  await assert.rejects(decrypt(sealed, secret, "owner-B"), /conexión guardada/);
  const parts = sealed.split(".");
  parts[2] = (parts[2].startsWith("A") ? "B" : "A") + parts[2].slice(1);
  await assert.rejects(decrypt(parts.join("."), secret, "owner-A"), /conexión guardada/);
  await assert.rejects(decrypt(sealed, Buffer.alloc(32, 18).toString("base64"), "owner-A"));
  const state = randomToken();
  assert.match(state, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(state, randomToken());
  assert.match(oauthCookie(state), /HttpOnly; Secure; SameSite=Lax; Max-Age=600/);
});

test("OneDrive: configuration fails closed on missing credentials, invalid key and wrong callback", () => {
  const keys = ["APP_ORIGIN", "MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET", "MICROSOFT_REDIRECT_URI", "ONEDRIVE_TOKEN_KEY"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const request = new Request("https://pedidos.example/api/onedrive/status");
  try {
    for (const key of keys) delete process.env[key];
    assert.equal(configuration(request).configured, false);
    Object.assign(process.env, { APP_ORIGIN: "https://pedidos.example", MICROSOFT_CLIENT_ID: "test-client", MICROSOFT_CLIENT_SECRET: "test-secret", MICROSOFT_REDIRECT_URI: "https://pedidos.example/api/onedrive/callback", ONEDRIVE_TOKEN_KEY: Buffer.alloc(32, 17).toString("base64") });
    assert.equal(configuration(request).configured, true);
    const internal = new Request("http://localhost:10000/api/onedrive/callback", { headers: { "X-Forwarded-Host": "attacker.example" } });
    assert.equal(configuration(internal).configured, true, "The registered public callback works behind Render's proxy");
    assert.equal(redirectBack(internal, "connected").headers.get("Location"), "https://pedidos.example/?onedrive=connected");
    process.env.ONEDRIVE_TOKEN_KEY = Buffer.alloc(16).toString("base64");
    assert.equal(configuration(request).configured, false);
    process.env.ONEDRIVE_TOKEN_KEY = Buffer.alloc(32, 17).toString("base64");
    for (const callback of ["http://pedidos.example/api/onedrive/callback", "https://attacker.example/api/onedrive/callback", "https://pedidos.example/api/onedrive/callback?extra=1", "https://pedidos.example/other"]) {
      process.env.MICROSOFT_REDIRECT_URI = callback;
      assert.equal(configuration(request).configured, false, callback);
    }
    process.env.MICROSOFT_REDIRECT_URI = "https://pedidos.example/api/onedrive/callback";
    for (const origin of ["http://pedidos.example", "https://pedidos.example/path", "https://user:password@pedidos.example", "https://pedidos.example/"]) {
      process.env.APP_ORIGIN = origin;
      assert.equal(configuration(request).configured, false, origin);
    }
  } finally {
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  }
});

test("OneDrive planning: a continuing Excel revision 0 advances the tracked web revision", async () => {
  const existing = order({ revision: 7 });
  const baselineHash = await orderHash(existing);
  const database = plannerDatabase({ orders: [existing], baselines: [{ order_id: existing.id, remote_hash: baselineHash, local_revision: 7 }] });
  const unchanged = await planSync(database, "owner-A", "excel-uno", input());
  assert.equal(unchanged.conflicts.length, 0);
  assert.equal(unchanged.input.orders[0].revision, 7);
  assert.equal(unchanged.nextBaselines[0].localRevision, 7);
  const changed = await planSync(database, "owner-A", "excel-uno", input([order({ unitCents: 15000 })]));
  assert.equal(changed.conflicts.length, 0);
  assert.equal(changed.input.orders[0].revision, 7);
  assert.equal(changed.nextBaselines[0].localRevision, 8);
  assert.notEqual(changed.nextBaselines[0].remoteHash, baselineHash);
  assert.deepEqual(changed.expectations, [{ id: existing.id, revision: 7, baselineHash, baselineRevision: 7 }]);
});

test("OneDrive planning: local edits and deleted orders cannot be overwritten or resurrected", async () => {
  const old = order();
  const oldHash = await orderHash(old);
  const baseline = { order_id: old.id, remote_hash: oldHash, local_revision: 3 };
  const current = order({ revision: 4, notes: "Editar en web" });
  const divergent = await planSync(plannerDatabase({ orders: [current], baselines: [baseline] }), "owner-A", "excel-uno", input([order({ unitCents: 15000 })]));
  assert.equal(divergent.input.orders.length, 0);
  assert.match(divergent.conflicts[0].reason, /modificó en la web/);
  const deleted = await planSync(plannerDatabase({ baselines: [baseline] }), "owner-A", "excel-uno", input());
  assert.equal(deleted.input.orders.length, 0);
  assert.match(deleted.conflicts[0].reason, /eliminado en la web/);
  const reconciled = await planSync(plannerDatabase({ orders: [current], baselines: [baseline] }), "owner-A", "excel-uno", input([{ ...current, revision: 0 }]));
  assert.equal(reconciled.conflicts.length, 0);
  assert.equal(reconciled.nextBaselines[0].localRevision, 4);
});

test("OneDrive planning: ledger baseline preserves payment deletion and immutable amounts", async () => {
  const fingerprint = await hash(JSON.stringify(parsePayment(payment)));
  const baseline = { kind: "payment", id: payment.id, fingerprint };
  const deleted = await planSync(plannerDatabase({ ledgerBaselines: [baseline] }), "owner-A", "excel-uno", input([], [payment]));
  assert.match(deleted.conflicts[0].reason, /eliminado en la web/);
  const altered = await planSync(plannerDatabase({ payments: [payment], ledgerBaselines: [baseline] }), "owner-A", "excel-uno", input([], [{ ...payment, amountCents: 6000 }]));
  assert.match(altered.conflicts[0].reason, /otros datos/);
  const same = await planSync(plannerDatabase({ payments: [payment], ledgerBaselines: [baseline] }), "owner-A", "excel-uno", input([], [payment]));
  assert.equal(same.conflicts.length, 0);
  assert.deepEqual(same.ledgerExpectations, [{ kind: "payment", id: payment.id, present: true }]);
  assert.deepEqual(same.nextLedgerBaselines, [baseline]);
});
