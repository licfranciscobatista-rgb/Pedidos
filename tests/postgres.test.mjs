import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestDatabase, hasTestDatabase } from "./postgres-harness.mjs";

const orders = await import("../app/api/orders/route.ts");
const order = await import("../app/api/orders/[id]/route.ts");
const payments = await import("../app/api/payments/route.ts");
const payment = await import("../app/api/payments/[id]/route.ts");
const exchange = await import("../app/api/orders/[id]/exchange/route.ts");
const imports = await import("../app/api/import/route.ts");
const invoices = await import("../app/api/invoices/route.ts");
const invoice = await import("../app/api/invoices/[id]/route.ts");
const data = await import("../app/api/data/route.ts");
const { assertSql } = await import("../app/api/_shared.ts");

function request(path, method = "GET", body, origin = "https://site.example") {
  return new Request(`https://site.example${path}`, { method, headers: { Origin: origin, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
}
const params = id => ({ params: Promise.resolve({ id }) });
const article = (id, overrides = {}) => ({ id, platform: "Temu", client: "María Pérez", phone: "809-555-0100", batch: "Lote 1", article: "Cartera", variant: "Azul", quantity: 1, unitCents: 10001, extraCents: 9, discountCents: 10, storeCents: 5000, status: "Pedido", date: "2026-10-17", deliveryDate: "", notes: "Se conserva", photoKey: "", revision: 1, ...overrides });
const movement = (id, orderId, amountCents, kind = "Abono") => ({ id, orderId, amountCents, kind, date: "2026-10-17", method: "Efectivo", note: "" });
async function response(responsePromise, expected) {
  const result = await responsePromise;
  const value = await result.json();
  assert.equal(result.status, expected, JSON.stringify(value));
  return value;
}

test("PostgreSQL real: centavos, carreras, importación atómica, facturas e aislamiento", { skip: !hasTestDatabase }, async t => {
  const fixture = await createTestDatabase();
  const db = fixture.database("owner-A");
  try {
    await t.test("una aserción fallida revierte escrituras anteriores", async () => {
      await assert.rejects(db.batch([
        db.prepare("INSERT INTO activities (owner_id,id,at,kind,summary) VALUES ($1,$2,$3,$4,$5)").bind("owner-A", "rollback", "now", "test", "must disappear"),
        assertSql(db, "FALSE", []),
      ]), /transaction_conflict/);
      assert.equal((await fixture.pool.query("SELECT COUNT(*) AS count FROM activities")).rows[0].count, 0);
    });
    await t.test("actualizaciones simultáneas conservan revisión e historial", async () => {
      await response(orders.POST(request("/api/orders", "POST", { order: article("one") })), 201);
      const requests = ["Primera", "Segunda"].map(notes => order.PUT(request("/api/orders/one", "PUT", { order: article("one", { notes }) }), params("one")));
      const replies = await Promise.all(requests);
      assert.deepEqual(replies.map(item => item.status).sort(), [200, 409]);
      const saved = (await response(data.GET(request("/api/data")), 200)).orders[0];
      assert.equal(saved.revision, 2);
      assert.equal(saved.unitCents, 10001);
      assert.equal(saved.storeCents, 5000);
      assert.equal((await fixture.pool.query("SELECT COUNT(*) AS count FROM activities WHERE kind='Artículo actualizado'")).rows[0].count, 1);
    });
    await t.test("devoluciones concurrentes no exceden abonos", async () => {
      await response(payments.POST(request("/api/payments", "POST", { payment: movement("paid", "one", 10000) })), 201);
      const refunds = await Promise.all(["refund-a", "refund-b"].map(id => payments.POST(request("/api/payments", "POST", { payment: movement(id, "one", 7000, "Devolución") }))));
      assert.deepEqual(refunds.map(item => item.status).sort(), [201, 409]);
      assert.equal((await fixture.pool.query("SELECT SUM(CASE WHEN kind='Abono' THEN amount_cents ELSE -amount_cents END)::bigint AS paid FROM payments WHERE order_id='one'")).rows[0].paid, 3000);
      await response(payment.DELETE(request("/api/payments/paid", "DELETE"), params("paid")), 409);
    });
    await t.test("cambio preserva identidad, pagos y notas", async () => {
      const before = (await response(data.GET(request("/api/data")), 200)).orders[0];
      const changed = await response(exchange.POST(request("/api/orders/one/exchange", "POST", { revision: before.revision, article: "Zapatos", quantity: 2, unitCents: 6000, photoKey: "", date: "2026-10-17", notes: "Talla" }), params("one")), 201);
      assert.equal(changed.order.id, "one");
      assert.equal(changed.order.notes, before.notes);
      assert.equal(changed.exchange.oldTotalCents, 10000);
      assert.equal(changed.exchange.newTotalCents, 11999);
      assert.equal(changed.exchange.differenceCents, 1999);
      assert.equal((await fixture.pool.query("SELECT COUNT(*) AS count FROM payments WHERE order_id='one'")).rows[0].count, 2);
    });
    await t.test("eliminaciones válidas dejan historial y no permiten borrar cambios", async () => {
      await response(orders.POST(request("/api/orders", "POST", { order: article("removable") })), 201);
      await response(payments.POST(request("/api/payments", "POST", { payment: movement("removable-paid", "removable", 100) })), 201);
      await response(payment.DELETE(request("/api/payments/removable-paid", "DELETE"), params("removable-paid")), 200);
      await response(order.DELETE(request("/api/orders/removable?revision=1", "DELETE"), params("removable")), 200);
      assert.equal((await fixture.pool.query("SELECT COUNT(*) AS count FROM activities WHERE order_id='removable'")).rows[0].count, 4);
      await response(order.DELETE(request("/api/orders/one?revision=3", "DELETE"), params("one")), 409);
    });
    await t.test("importar repite IDs y revierte el lote completo si un pago cambia", async () => {
      const historicExchange = { id: "imported-change", orderId: "imported", date: "2026-10-17", oldArticle: "Anterior", newArticle: "Cartera", oldTotalCents: 9000, newTotalCents: 10000, differenceCents: 1000, note: "Historial" };
      const input = { orders: [article("imported")], payments: [movement("imported-paid", "imported", 1500)], exchanges: [historicExchange] };
      const first = await response(imports.POST(request("/api/import", "POST", input)), 200);
      assert.equal(first.changes.createdOrders, 1);
      assert.equal(first.changes.createdExchanges, 1);
      const second = await response(imports.POST(request("/api/import", "POST", input)), 200);
      assert.equal(second.changes.createdOrders, 0);
      assert.equal(second.changes.unchangedPayments, 1);
      const before = (await fixture.pool.query("SELECT COUNT(*) AS count FROM activities")).rows[0].count;
      await response(imports.POST(request("/api/import", "POST", { orders: [...input.orders, article("must-rollback")], payments: [{ ...input.payments[0], amountCents: 1600 }], exchanges: [] })), 409);
      assert.equal((await fixture.pool.query("SELECT COUNT(*) AS count FROM orders WHERE id='must-rollback'")).rows[0].count, 0);
      assert.equal((await fixture.pool.query("SELECT COUNT(*) AS count FROM activities")).rows[0].count, before);
      assert.equal((await fixture.pool.query("SELECT amount_cents AS amount FROM payments WHERE id='imported-paid'")).rows[0].amount, 1500);
      await response(imports.POST(request("/api/import", "POST", { ...input, exchanges: [{ ...historicExchange, note: "Alterado" }] })), 409);
      assert.equal((await fixture.pool.query("SELECT note FROM exchanges WHERE id='imported-change'")).rows[0].note, "Historial");
      const local = (await response(data.GET(request("/api/data")), 200)).orders.find(item => item.id === "imported");
      await response(order.PUT(request("/api/orders/imported", "PUT", { order: { ...local, notes: "Nueva nota" } }), params("imported")), 200);
      await response(imports.POST(request("/api/import", "POST", { ...input, orders: [article("imported", { article: "Stale" }), article("also-rollback")] })), 409);
      assert.equal((await fixture.pool.query("SELECT COUNT(*) AS count FROM orders WHERE id='also-rollback'")).rows[0].count, 0);
    });
    await t.test("facturas concurrentes son inmutables e idempotentes; monto manual exacto", async () => {
      const input = { orderIds: ["imported"], businessName: "Mis pedidos", notes: "Entrega", requestId: crypto.randomUUID(), pricingMode: "manual", manualTotalCents: 100_000_000, showAmounts: true, deliveryLabels: { imported: "Sigue pendiente" } };
      const before = (await fixture.pool.query("SELECT * FROM orders ORDER BY id")).rows;
      const replies = await Promise.all([invoices.POST(request("/api/invoices", "POST", input)), invoices.POST(request("/api/invoices", "POST", input))]);
      assert.deepEqual(replies.map(item => item.status).sort(), [200, 201]);
      const saved = await Promise.all(replies.map(item => item.json()));
      assert.deepEqual(saved[0].invoice, saved[1].invoice);
      const snapshot = saved[0].invoice;
      assert.equal(snapshot.totalCents, 100_000_000);
      assert.equal(snapshot.paidCents, 1500);
      assert.equal(snapshot.balanceCents, 99_998_500);
      assert.equal(snapshot.registeredTotalCents, 10000);
      assert.equal(snapshot.items[0].deliveryLabel, "Sigue pendiente");
      assert.equal(snapshot.showAmounts, true);
      assert.equal(snapshot.client, "María Pérez");
      assert.equal((await fixture.pool.query("SELECT COUNT(*) AS count FROM activities WHERE kind='Factura emitida'")).rows[0].count, 1);
      assert.deepEqual((await fixture.pool.query("SELECT * FROM orders ORDER BY id")).rows, before);
      const next = await response(invoices.POST(request("/api/invoices", "POST", { ...input, requestId: crypto.randomUUID(), pricingMode: "items", showAmounts: true })), 201);
      assert.match(next.invoice.number, /000002$/);
      assert.equal(next.invoice.totalCents, 10000);
      const simultaneous = await Promise.all([1, 2].map(() => invoices.POST(request("/api/invoices", "POST", { ...input, requestId: crypto.randomUUID() }))));
      assert.deepEqual(simultaneous.map(item => item.status), [201, 201]);
      const sequenceNumbers = await Promise.all(simultaneous.map(async item => (await item.json()).invoice.number));
      assert.equal(new Set(sequenceNumbers).size, 2);
      await fixture.pool.query("UPDATE invoice_counters SET next_sequence=1000000 WHERE owner_id='owner-A'");
      const million = await response(invoices.POST(request("/api/invoices", "POST", { ...input, requestId: crypto.randomUUID() })), 201);
      assert.match(million.invoice.number, /-1000000$/);
      await response(orders.POST(request("/api/orders", "POST", { order: article("different", { client: "Otra" }) })), 201);
      await response(invoices.POST(request("/api/invoices", "POST", { ...input, requestId: crypto.randomUUID(), orderIds: ["imported", "different"] })), 409);
      const current = (await response(data.GET(request("/api/data")), 200)).orders.find(item => item.id === "imported");
      await response(order.PUT(request("/api/orders/imported", "PUT", { order: { ...current, unitCents: 90000, status: "Cancelado" } }), params("imported")), 200);
      const reloaded = await response(invoice.GET(request(`/api/invoices/${snapshot.id}`), params(snapshot.id)), 200);
      assert.deepEqual(reloaded.invoice, snapshot);
    });
    await t.test("cada dueño y origen conserva su límite de acceso", async () => {
      globalThis.__postgresTestUser = { userId: "owner-B" };
      const other = await response(data.GET(request("/api/data")), 200);
      assert.equal(other.orders.length, 0);
      assert.equal(other.invoices.length, 0);
      assert.equal(other.activities.length, 0);
      const previousOrigin = process.env.APP_ORIGIN;
      process.env.APP_ORIGIN = "https://site.example";
      try {
        const internal = new Request("http://127.0.0.1:10000/api/orders", { method: "POST", headers: { Origin: "https://site.example", "Content-Type": "application/json" }, body: JSON.stringify({ order: article("proxy-request") }) });
        await response(orders.POST(internal), 201);
      } finally {
        if (previousOrigin === undefined) delete process.env.APP_ORIGIN;
        else process.env.APP_ORIGIN = previousOrigin;
      }
      await response(order.DELETE(request("/api/orders/one?revision=3", "DELETE"), params("one")), 409);
      await response(orders.POST(request("/api/orders", "POST", { order: article("cross-origin") }, "https://evil.example")), 403);
      globalThis.__postgresTestUser = null;
      await response(data.GET(request("/api/data")), 401);
    });
  } finally { await fixture.cleanup(); }
});
