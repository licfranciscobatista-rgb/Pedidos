import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestDatabase, hasTestDatabase } from "./postgres-harness.mjs";

const statusRoute = await import("../app/api/onedrive/status/route.ts");
const startRoute = await import("../app/api/onedrive/start/route.ts");
const callbackRoute = await import("../app/api/onedrive/callback/route.ts");
const filesRoute = await import("../app/api/onedrive/files/route.ts");
const selectRoute = await import("../app/api/onedrive/select/route.ts");
const downloadRoute = await import("../app/api/onedrive/download/route.ts");
const syncRoute = await import("../app/api/onedrive/sync/route.ts");
const disconnectRoute = await import("../app/api/onedrive/disconnect/route.ts");
const orderRoute = await import("../app/api/orders/[id]/route.ts");
const paymentRoute = await import("../app/api/payments/[id]/route.ts");
const dataRoute = await import("../app/api/data/route.ts");
const { hash } = await import("../app/api/onedrive/_core.ts");

const req = (path, method = "GET", data, headers = {}) => new Request(`https://pedidos.example${path}`, { method, headers: { Origin: "https://pedidos.example", ...(data === undefined ? {} : { "Content-Type": "application/json" }), ...headers }, body: data === undefined ? undefined : JSON.stringify(data) });
const params = id => ({ params: Promise.resolve({ id }) });
const order = (id, overrides = {}) => ({ id, platform: "Temu", client: "Ana", phone: "", batch: "Grupo 1", article: "Cartera", variant: "Azul", quantity: 1, unitCents: 10000, extraCents: 0, discountCents: 0, storeCents: 7000, status: "Pedido", date: "2026-10-17", deliveryDate: "", notes: "", photoKey: "", revision: 0, ...overrides });
const payment = (id, orderId, amountCents = 5000) => ({ id, orderId, amountCents, kind: "Abono", date: "2026-10-17", method: "Efectivo", note: "" });

test("PostgreSQL OneDrive: PKCE owner isolation, atomic sync, baselines, ledger and disconnect races", { skip: !hasTestDatabase }, async () => {
  const database = await createTestDatabase({ origin: "https://pedidos.example" });
  const { pool } = database;
  const envKeys = ["MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET", "MICROSOFT_REDIRECT_URI", "ONEDRIVE_TOKEN_KEY"];
  const oldEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  const actualFetch = globalThis.fetch;
  const originalFactory = globalThis.__postgresTestDatabase;
  let etag = '"version-1"';
  let tokenCalls = 0;
  let contentCalls = 0;
  let verifier = "";
  let disconnectDuringToken = false;
  let hugeDownload = false;
  let downloadLocation = "https://my.microsoftpersonalcontent.com/download/test";
  const metadata = () => ({ id: "file-one", name: "PROGRAMA DE PEDIDOS.xlsx", eTag: etag, size: 5, file: {}, lastModifiedDateTime: "2026-10-17T12:00:00Z", webUrl: "https://onedrive.live.com/edit/test", parentReference: { driveId: "drive-personal", path: "/drive/root:/Pedidos" } });
  const read = async () => (await dataRoute.GET(req("/api/data"))).json();
  const scalar = async sql => (await pool.query(sql)).rows[0].n;
  const download = () => downloadRoute.GET(req("/api/onedrive/download"));
  try {
    for (const key of envKeys) delete process.env[key];
    assert.equal((await (await statusRoute.GET(req("/api/onedrive/status"))).json()).configured, false);
    assert.equal((await startRoute.GET(req("/api/onedrive/start"))).status, 503);
    Object.assign(process.env, { MICROSOFT_CLIENT_ID: "test-client-id", MICROSOFT_CLIENT_SECRET: "test-only-secret", MICROSOFT_REDIRECT_URI: "https://pedidos.example/api/onedrive/callback", ONEDRIVE_TOKEN_KEY: Buffer.alloc(32, 7).toString("base64") });
    globalThis.fetch = async (input, options = {}) => {
      const url = new URL(String(input));
      if (url.hostname === "login.microsoftonline.com") {
        tokenCalls++;
        const fields = new URLSearchParams(options.body);
        assert.equal(fields.get("scope"), "https://graph.microsoft.com/Files.Read offline_access");
        verifier = fields.get("code_verifier") || verifier;
        if (disconnectDuringToken) { disconnectDuringToken = false; await disconnectRoute.POST(req("/api/onedrive/disconnect", "POST")); }
        return Response.json({ access_token: "test-access-token", refresh_token: "test-refresh-token", expires_in: 3600 });
      }
      if (url.hostname === "graph.microsoft.com") {
        assert.match(new Headers(options.headers).get("Authorization"), /^Bearer /);
        assert.doesNotMatch(url.pathname, /shares|workbook/);
        if (url.pathname === "/v1.0/me/drive") return Response.json({ id: "drive-personal", driveType: "personal", owner: { user: { displayName: "Cuenta de prueba" } } });
        if (url.pathname.includes("/search(")) return Response.json({ value: [metadata(), { id: "text", name: "notes.txt", file: {} }, { id: "remote", name: "Shared.xlsx", file: {}, remoteItem: {} }] });
        if (url.pathname === "/v1.0/me/drive/items/file-one") return Response.json(metadata());
        if (url.pathname.endsWith("/content")) return new Response(null, { status: 302, headers: { Location: downloadLocation } });
      }
      if (url.hostname === "my.microsoftpersonalcontent.com") {
        contentCalls++;
        assert.equal(new Headers(options.headers).has("Authorization"), false);
        return new Response(hugeDownload ? new Uint8Array(5 * 1024 * 1024 + 1) : Uint8Array.from([80, 75, 3, 4, 0]));
      }
      throw new Error(`Unexpected mock host: ${url.hostname}`);
    };
    let response = await startRoute.GET(req("/api/onedrive/start"));
    assert.equal(response.status, 302);
    const authorize = new URL(response.headers.get("Location"));
    assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
    const state = authorize.searchParams.get("state");
    const cookie = response.headers.get("Set-Cookie").split(";")[0];
    const callback = () => req(`/api/onedrive/callback?state=${state}&code=test-code`, "GET", undefined, { Cookie: cookie });
    globalThis.__postgresTestUser = { userId: "owner-B" };
    assert.match((await callbackRoute.GET(callback())).headers.get("Location"), /onedrive=error/);
    assert.equal(tokenCalls, 0);
    globalThis.__postgresTestUser = { userId: "owner-A" };
    assert.match((await callbackRoute.GET(callback())).headers.get("Location"), /onedrive=connected/);
    assert.equal(await hash(verifier), authorize.searchParams.get("code_challenge"));
    const stored = (await pool.query("SELECT * FROM onedrive_connections WHERE owner_id='owner-A'")).rows[0];
    assert.ok(!stored.refresh_cipher.includes("test-refresh-token"));
    assert.ok(!stored.access_cipher.includes("test-access-token"));
    assert.match((await callbackRoute.GET(callback())).headers.get("Location"), /onedrive=error/);
    assert.equal(tokenCalls, 1);
    assert.deepEqual((await (await filesRoute.GET(req("/api/onedrive/files?query=PROGRAMA"))).json()).files.map(item => item.id), ["file-one"]);
    assert.equal((await selectRoute.POST(req("/api/onedrive/select", "POST", { fileId: "file-one" }))).status, 200);
    response = await download();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("X-OneDrive-Etag"), etag);
    assert.equal((await response.arrayBuffer()).byteLength, 5);

    const importedExchange = { id: "sync-exchange", orderId: "sync-one", date: "2026-10-17", oldArticle: "Cartera", newArticle: "Cartera azul", oldTotalCents: 10000, newTotalCents: 10000, differenceCents: 0, note: "Cambio importado" };
    const payload = { fileId: "file-one", etag, generatedIds: 0, orders: [order("sync-one"), order("sync-two")], payments: [payment("sync-payment", "sync-one")], exchanges: [importedExchange] };
    const simultaneous = await Promise.all([
      syncRoute.POST(req("/api/onedrive/sync", "POST", payload)),
      syncRoute.POST(req("/api/onedrive/sync", "POST", payload)),
    ]);
    for (const item of simultaneous) assert.equal(item.status, 200, await item.clone().text());
    const simultaneousResults = await Promise.all(simultaneous.map(item => item.json()));
    assert.equal(simultaneousResults.reduce((sum, item) => sum + item.changes.createdOrders, 0), 2, "Concurrent synchronization creates each order once");
    assert.equal(simultaneousResults.reduce((sum, item) => sum + item.changes.createdExchanges, 0), 1, "Concurrent synchronization records the imported exchange once");
    assert.equal(simultaneousResults.filter(item => item.unchanged).length, 1);
    const events = await scalar("SELECT COUNT(*)::integer n FROM activities");
    assert.equal((await (await syncRoute.POST(req("/api/onedrive/sync", "POST", payload))).json()).unchanged, true);
    assert.equal(await scalar("SELECT COUNT(*)::integer n FROM activities"), events);
    assert.equal((await downloadRoute.GET(req("/api/onedrive/download", "GET", undefined, { "If-None-Match": etag }))).status, 304);
    assert.equal(contentCalls, 1);

    etag = '"version-2"'; payload.etag = etag; payload.orders[0].unitCents = 15000;
    assert.equal((await download()).status, 200);
    response = await syncRoute.POST(req("/api/onedrive/sync", "POST", payload));
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).changes.updatedOrders, 1);
    let current = (await read()).orders.find(item => item.id === "sync-one");
    assert.equal(current.revision, 2, "The Excel may retain revision 0 while its baseline advances");
    assert.equal((await orderRoute.PUT(req("/api/orders/sync-one", "PUT", { order: { ...current, notes: "Cambio local" } }), params("sync-one"))).status, 200);
    etag = '"version-3"'; payload.etag = etag; payload.orders[0].unitCents = 18000;
    await download();
    response = await syncRoute.POST(req("/api/onedrive/sync", "POST", payload));
    assert.equal(response.status, 409);
    assert.equal((await response.json()).conflicts[0].orderId, "sync-one");
    current = (await read()).orders.find(item => item.id === "sync-one");
    assert.equal(current.unitCents, 15000); assert.equal(current.notes, "Cambio local");
    payload.orders[0] = { ...current, revision: 0 };
    assert.equal((await syncRoute.POST(req("/api/onedrive/sync", "POST", payload))).status, 200);

    etag = '"version-4"'; payload.etag = etag; payload.payments[0].amountCents = 6000;
    await download();
    assert.equal((await syncRoute.POST(req("/api/onedrive/sync", "POST", payload))).status, 409);
    assert.equal(await scalar("SELECT amount_cents n FROM payments WHERE id='sync-payment'"), 5000);
    assert.equal(await scalar("SELECT synced_etag n FROM onedrive_connections WHERE owner_id='owner-A'"), '"version-3"');
    payload.payments[0].amountCents = 5000;
    payload.exchanges[0].note = "Intento de modificar el historial";
    assert.equal((await syncRoute.POST(req("/api/onedrive/sync", "POST", payload))).status, 409);
    assert.equal(await scalar("SELECT note n FROM exchanges WHERE id='sync-exchange'"), "Cambio importado");
    payload.exchanges[0].note = "Cambio importado";
    etag = '"version-5"';
    assert.equal((await syncRoute.POST(req("/api/onedrive/sync", "POST", payload))).status, 409, "Metadata changed after the download");
    payload.etag = etag; payload.payments[0].amountCents = 5000;
    await download();
    assert.equal((await paymentRoute.DELETE(req("/api/payments/sync-payment", "DELETE"), params("sync-payment"))).status, 200);
    response = await syncRoute.POST(req("/api/onedrive/sync", "POST", payload));
    assert.equal(response.status, 409);
    assert.match((await response.json()).conflicts[0].reason, /eliminado/);
    assert.equal(await scalar("SELECT COUNT(*)::integer n FROM payments WHERE id='sync-payment'"), 0);
    payload.payments = [];
    assert.equal((await syncRoute.POST(req("/api/onedrive/sync", "POST", payload))).status, 200);

    etag = '"version-6"'; payload.etag = etag; payload.payments = [payment("race-payment", "sync-one", 2000)];
    await download();
    assert.equal((await syncRoute.POST(req("/api/onedrive/sync", "POST", payload))).status, 200);
    etag = '"version-7"'; payload.etag = etag;
    await download();
    let raceArmed = true;
    globalThis.__postgresTestDatabase = ownerId => {
      const wrapper = originalFactory(ownerId);
      const normalBatch = wrapper.batch.bind(wrapper);
      wrapper.batch = async statements => {
        if (raceArmed && statements.some(item => item.sql.startsWith("INSERT INTO onedrive_baselines"))) {
          raceArmed = false;
          await pool.query("DELETE FROM payments WHERE owner_id='owner-A' AND id='race-payment'");
        }
        return normalBatch(statements);
      };
      return wrapper;
    };
    try { assert.equal((await syncRoute.POST(req("/api/onedrive/sync", "POST", payload))).status, 409, "The commit rechecks ledger presence after planning"); }
    finally { globalThis.__postgresTestDatabase = originalFactory; }
    assert.equal(await scalar("SELECT COUNT(*)::integer n FROM payments WHERE id='race-payment'"), 0);
    assert.equal(await scalar("SELECT synced_etag n FROM onedrive_connections WHERE owner_id='owner-A'"), '"version-6"');

    etag = '"version-8"'; hugeDownload = true;
    assert.equal((await download()).status, 413);
    hugeDownload = false; downloadLocation = "http://169.254.169.254/metadata";
    assert.equal((await download()).status, 502);
    await pool.query("UPDATE onedrive_connections SET access_expires_at=0 WHERE owner_id='owner-A'");
    assert.equal((await filesRoute.GET(req("/api/onedrive/files"))).status, 200);
    assert.equal(tokenCalls, 2);
    globalThis.__postgresTestUser = { userId: "owner-B" };
    assert.equal((await (await statusRoute.GET(req("/api/onedrive/status"))).json()).connected, false);
    assert.equal((await download()).status, 409);
    globalThis.__postgresTestUser = { userId: "owner-A" };
    assert.equal((await disconnectRoute.POST(req("/api/onedrive/disconnect", "POST"))).status, 200);
    assert.equal(await scalar("SELECT refresh_cipher n FROM onedrive_connections WHERE owner_id='owner-A'"), "");
    assert.equal(await scalar("SELECT COUNT(*)::integer n FROM orders"), 2);
    response = await startRoute.GET(req("/api/onedrive/start"));
    const racingAuthorize = new URL(response.headers.get("Location"));
    const racingCookie = response.headers.get("Set-Cookie").split(";")[0];
    disconnectDuringToken = true;
    response = await callbackRoute.GET(req(`/api/onedrive/callback?state=${racingAuthorize.searchParams.get("state")}&code=another-test-code`, "GET", undefined, { Cookie: racingCookie }));
    assert.match(response.headers.get("Location"), /onedrive=error/);
    assert.equal(await scalar("SELECT refresh_cipher n FROM onedrive_connections WHERE owner_id='owner-A'"), "");
  } finally {
    globalThis.fetch = actualFetch;
    globalThis.__postgresTestDatabase = originalFactory;
    for (const key of envKeys) { if (oldEnv[key] === undefined) delete process.env[key]; else process.env[key] = oldEnv[key]; }
    await database.cleanup();
  }
});
