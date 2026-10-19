import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getPool } from "./db";
import type { Pool } from "pg";

export interface PhotoBucket {
  put(key: string, data: ArrayBuffer, options: { httpMetadata: { contentType: string }; customMetadata?: Record<string, string> }): Promise<void>;
  get(key: string): Promise<{ body: Uint8Array; httpMetadata: { contentType: string } } | null>;
}

type PhotoClient = Pick<S3Client, "send">;

const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function validateKey(key: string) {
  if (!/^[a-zA-Z0-9_-]{1,100}\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(key)) throw new Error("Invalid private photo key");
}

export function createPhotoBucket(client: PhotoClient, bucket: string): PhotoBucket {
  return {
    async put(key, data, options) {
      validateKey(key);
      if (!data.byteLength || data.byteLength > MAX_PHOTO_BYTES || !CONTENT_TYPES.has(options.httpMetadata.contentType)) throw new Error("Invalid photo");
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: new Uint8Array(data), ContentType: options.httpMetadata.contentType, Metadata: options.customMetadata, CacheControl: "private, max-age=300" }));
    },
    async get(key) {
      validateKey(key);
      try {
        const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        if (!result.Body) return null;
        if (result.ContentLength && result.ContentLength > MAX_PHOTO_BYTES) throw new Error("Stored photo exceeds limit");
        // Read with a strict cap even when storage has no Content-Length.
        const parts: Uint8Array[] = [];
        let size = 0;
        for await (const part of result.Body as AsyncIterable<Uint8Array>) {
          size += part.byteLength;
          if (size > MAX_PHOTO_BYTES) throw new Error("Stored photo exceeds limit");
          parts.push(part);
        }
        const body = new Uint8Array(size);
        let offset = 0;
        for (const part of parts) { body.set(part, offset); offset += part.byteLength; }
        return { body, httpMetadata: { contentType: CONTENT_TYPES.has(result.ContentType ?? "") ? result.ContentType! : "application/octet-stream" } };
      } catch (error) {
        if (error && typeof error === "object" && "name" in error && ["NoSuchKey", "NotFound"].includes(String(error.name))) return null;
        throw error;
      }
    },
  };
}

export function createPostgresPhotoBucket(database?: Pick<Pool, "query">): PhotoBucket {
  return {
    async put(key, data, options) {
      validateKey(key);
      if (!data.byteLength || data.byteLength > MAX_PHOTO_BYTES || !CONTENT_TYPES.has(options.httpMetadata.contentType)) throw new Error("Invalid photo");
      const [ownerId, photoId] = key.split("/");
      const pool = database ?? getPool();
      await pool.query(
        `INSERT INTO photos (owner_id, key, content_type, data)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (owner_id, key) DO UPDATE SET
           content_type = EXCLUDED.content_type,
           data = EXCLUDED.data,
           created_at = NOW()`,
        [ownerId, photoId, options.httpMetadata.contentType, Buffer.from(data)]
      );
    },
    async get(key) {
      validateKey(key);
      const [ownerId, photoId] = key.split("/");
      const pool = database ?? getPool();
      const res = await pool.query(
        `SELECT content_type, octet_length(data) AS size,
                CASE WHEN octet_length(data) BETWEEN 1 AND 5242880 THEN data END AS data
         FROM photos WHERE owner_id = $1 AND key = $2`,
        [ownerId, photoId]
      );
      if (!res.rows.length) return null;
      const row = res.rows[0];
      if (!Number.isSafeInteger(row.size) || row.size < 1 || row.size > MAX_PHOTO_BYTES) throw new Error("Stored photo exceeds limit or is empty");
      if (!CONTENT_TYPES.has(row.content_type)) throw new Error("Stored photo has an unsupported content type");
      if (!(row.data instanceof Uint8Array) || row.data.byteLength !== row.size) throw new Error("Stored photo data is invalid");
      return {
        body: new Uint8Array(row.data),
        httpMetadata: { contentType: row.content_type },
      };
    },
  };
}

let cached: PhotoBucket | undefined;

export async function getPhotoBucket(): Promise<PhotoBucket> {
  if (cached) return cached;
  const { AWS_ENDPOINT_URL_S3, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, PHOTO_BUCKET } = process.env;
  if (!AWS_ENDPOINT_URL_S3 || !AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY || !AWS_REGION || !PHOTO_BUCKET) {
    // Bucket and region can be general defaults. An endpoint or credential
    // indicates an intended S3 store, so partial setup must fail explicitly.
    if ([AWS_ENDPOINT_URL_S3, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY].some(Boolean)) throw new Error("Private photo storage configuration is incomplete");
    if (process.env.DATABASE_URL) {
      cached = createPostgresPhotoBucket();
      return cached;
    }
    throw new Error("Private photo storage is not configured");
  }
  const endpoint = new URL(AWS_ENDPOINT_URL_S3);
  if (endpoint.protocol !== "https:") throw new Error("Photo storage requires HTTPS");
  cached = createPhotoBucket(new S3Client({ endpoint: endpoint.href, region: AWS_REGION, credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY }, forcePathStyle: true, maxAttempts: 3 }), PHOTO_BUCKET);
  return cached;
}
