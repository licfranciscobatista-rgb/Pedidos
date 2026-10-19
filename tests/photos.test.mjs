import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
    const candidate = fileURLToPath(new URL(specifier, context.parentURL));
    if (existsSync(candidate + ".ts")) return { url: pathToFileURL(candidate + ".ts").href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
} });
const { createPhotoBucket, createPostgresPhotoBucket, getPhotoBucket } = await import("../lib/photos.ts");

const key = "owner/11111111-1111-8111-8111-111111111111";

test("photo writes stay in owner-prefixed private bucket and preserve content type", async () => {
  let sent;
  const bucket = createPhotoBucket({ send: async command => { sent = command.input; return {}; } }, "private-photos");
  await bucket.put(key, new Uint8Array([1, 2, 3]).buffer, { httpMetadata: { contentType: "image/png" }, customMetadata: { owner: "owner" } });
  assert.equal(sent.Bucket, "private-photos"); assert.equal(sent.Key, key); assert.equal(sent.ACL, undefined);
  assert.equal(sent.ContentType, "image/png"); assert.equal(sent.CacheControl, "private, max-age=300");
  await assert.rejects(() => bucket.put("../other", new ArrayBuffer(1), { httpMetadata: { contentType: "image/png" } }));
});

test("photo reads are bounded without Content-Length and storage failures are not hidden", async () => {
  const huge = createPhotoBucket({ send: async () => ({ Body: (async function* () { yield new Uint8Array(5 * 1024 * 1024 + 1); })() }) }, "private");
  await assert.rejects(() => huge.get(key), /exceeds limit/);
  const missing = createPhotoBucket({ send: async () => { throw Object.assign(new Error(), { name: "NoSuchKey" }); } }, "private");
  assert.equal(await missing.get(key), null);
  const offline = createPhotoBucket({ send: async () => { throw new Error("Storage offline"); } }, "private");
  await assert.rejects(() => offline.get(key), /offline/);
});

test("PostgreSQL photo reads reject corrupt records and propagate unavailable storage", async () => {
  for (const row of [
    { content_type: "image/png", size: 5 * 1024 * 1024 + 1, data: null },
    { content_type: "image/png", size: 0, data: Buffer.alloc(0) },
    { content_type: "text/html", size: 1, data: Buffer.from([1]) },
    { content_type: "image/png", size: 2, data: Buffer.from([1]) },
  ]) {
    const bucket = createPostgresPhotoBucket({ query: async () => ({ rows: [row] }) });
    await assert.rejects(() => bucket.get(key), /Stored photo/);
  }
  const missing = createPostgresPhotoBucket({ query: async () => ({ rows: [] }) });
  assert.equal(await missing.get(key), null);
  const offline = createPostgresPhotoBucket({ query: async () => { throw new Error("Database unavailable"); } });
  await assert.rejects(() => offline.get(key), /Database unavailable/);
  await assert.rejects(() => offline.put(key, new ArrayBuffer(1), { httpMetadata: { contentType: "image/png" } }), /Database unavailable/);
});

test("PostgreSQL rejects invalid uploads before querying and requires a full private key", async () => {
  const bucket = createPostgresPhotoBucket({ query: async () => { throw new Error("Unexpected database call"); } });
  for (const [data, contentType] of [[new ArrayBuffer(0), "image/png"], [new ArrayBuffer(5 * 1024 * 1024 + 1), "image/jpeg"], [new ArrayBuffer(1), "text/html"]]) {
    await assert.rejects(() => bucket.put(key, data, { httpMetadata: { contentType } }), /Invalid photo/);
  }
  for (const invalid of ["../owner/11111111-1111-8111-8111-111111111111", "owner/" + "-".repeat(36)]) {
    await assert.rejects(() => bucket.get(invalid), /Invalid private photo key/);
    await assert.rejects(() => bucket.put(invalid, new ArrayBuffer(1), { httpMetadata: { contentType: "image/png" } }), /Invalid private photo key/);
  }
});

test("PostgreSQL fallback requires absent S3 credentials, rather than hiding partial configuration", async () => {
  const names = ["AWS_ENDPOINT_URL_S3", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION", "PHOTO_BUCKET", "DATABASE_URL"];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    await assert.rejects(() => getPhotoBucket(), /not configured/);
    process.env.DATABASE_URL = "postgresql://unused.example/unused";
    process.env.AWS_ACCESS_KEY_ID = "test-only";
    await assert.rejects(() => getPhotoBucket(), /incomplete/);
    delete process.env.AWS_ACCESS_KEY_ID;
    process.env.PHOTO_BUCKET = "article-photos"; // The documented .env default is harmless.
    process.env.AWS_REGION = "us-east-2"; // A generic region alone is harmless too.
    const bucket = await getPhotoBucket();
    assert.equal(typeof bucket.get, "function");
  } finally {
    for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; }
  }
});
