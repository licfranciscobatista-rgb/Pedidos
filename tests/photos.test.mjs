import test from "node:test";
import assert from "node:assert/strict";
import { createPhotoBucket } from "../lib/photos.ts";

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
