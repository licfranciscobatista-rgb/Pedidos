import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestDatabase, hasTestDatabase } from "./postgres-harness.mjs";
const { createPostgresPhotoBucket } = await import("../lib/photos.ts");

const upload = await import("../app/api/photos/route.ts");
const download = await import("../app/api/photos/[key]/route.ts");
const key = "11111111-1111-8111-8111-111111111111";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9xkAAAAASUVORK5CYII=", "base64");

test("PostgreSQL photos: owner isolation, durable upload, strict migration and private response", { skip: !hasTestDatabase }, async () => {
  const fixture = await createTestDatabase(), previousBucket = globalThis.__postgresTestBucket;
  const bucket = createPostgresPhotoBucket(fixture.pool);
  try {
    await bucket.put(`owner-A/${key}`, png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength), { httpMetadata: { contentType: "image/png" } });
    assert.equal(await bucket.get(`owner-B/${key}`), null);
    await bucket.put(`owner-B/${key}`, new Uint8Array([1, 2, 3]).buffer, { httpMetadata: { contentType: "image/webp" } });
    assert.deepEqual((await bucket.get(`owner-A/${key}`)).body, new Uint8Array(png));
    assert.equal((await bucket.get(`owner-B/${key}`)).httpMetadata.contentType, "image/webp");
    await bucket.put(`owner-A/${key}`, png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength), { httpMetadata: { contentType: "image/png" } });
    assert.equal((await fixture.pool.query("SELECT count(*)::int AS n FROM photos")).rows[0].n, 2);

    for (const [owner, id, type, bytes] of [
      ["../other", key, "image/png", png],
      ["owner-A", "invalid", "image/png", png],
      ["owner-A", key, "text/html", png],
      ["owner-A", key, "image/png", Buffer.alloc(0)],
      ["owner-A", key, "image/png", Buffer.alloc(5 * 1024 * 1024 + 1)],
    ]) await assert.rejects(fixture.pool.query("INSERT INTO photos(owner_id,key,content_type,data) VALUES($1,$2,$3,$4) ON CONFLICT(owner_id,key) DO UPDATE SET content_type=EXCLUDED.content_type,data=EXCLUDED.data", [owner, id, type, bytes]), error => error.code === "23514");

    globalThis.__postgresTestBucket = bucket;
    const form = () => { const value = new FormData(); value.append("file", new Blob([png], { type: "image/png" }), "photo.png"); return value; };
    const send = () => upload.POST(new Request("https://site.example/api/photos", { method: "POST", headers: { Origin: "https://site.example" }, body: form() }));
    const first = await send(); assert.equal(first.status, 201);
    const photoKey = (await first.json()).photoKey;
    assert.equal((await (await send()).json()).photoKey, photoKey);
    const get = () => download.GET(new Request(`https://site.example/api/photos/${photoKey}`), { params: Promise.resolve({ key: photoKey }) });
    const saved = await get(); assert.equal(saved.status, 200); assert.equal(saved.headers.get("Content-Type"), "image/png"); assert.match(saved.headers.get("Cache-Control"), /private/); assert.equal(saved.headers.get("X-Content-Type-Options"), "nosniff"); assert.deepEqual(Buffer.from(await saved.arrayBuffer()), png);
    globalThis.__postgresTestUser = { userId: "owner-B" };
    assert.equal((await get()).status, 404);
    globalThis.__postgresTestUser = { userId: "owner-A" };
    assert.equal((await get()).status, 200);
  } finally {
    globalThis.__postgresTestBucket = previousBucket;
    await fixture.cleanup();
  }
});
