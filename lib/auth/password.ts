import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const N = 131072;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const MAX_MEMORY = 192 * 1024 * 1024;
let active = false;
const waiting: (() => void)[] = [];

// Keep expensive derivations serial to avoid multiplying 128 MB of scrypt
// working memory on a small instance. The DB limiter bounds remote attempts.
async function derive(password: string, salt: Buffer): Promise<Buffer> {
  if (active) {
    if (waiting.length >= 4) throw new Error("password_queue_full");
    await new Promise<void>(resolve => waiting.push(resolve));
  } else active = true;
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(password, salt, KEY_LENGTH, { N, r: R, p: P, maxmem: MAX_MEMORY }, (error, key) => error ? reject(error) : resolve(key));
    });
  } finally {
    const next = waiting.shift();
    if (next) next(); else active = false;
  }
}

export function constantTimeEqual(left: string, right: string): boolean {
  return timingSafeEqual(createHash("sha256").update(left).digest(), createHash("sha256").update(right).digest());
}
export function validNewPassword(password: unknown): password is string {
  return typeof password === "string" && password.length === 4 && /^[0-9]{4}$/.test(password);
}
export async function hashPassword(password: string): Promise<string> {
  if (!validNewPassword(password)) throw new Error("invalid_new_password");
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt$v1$${N}$${R}$${P}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}
export async function verifyPassword(password: string, encoded: string | null): Promise<boolean> {
  const match = /^scrypt\$v1\$131072\$8\$1\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{86})$/.exec(encoded ?? "");
  const salt = match ? Buffer.from(match[1], "base64url") : Buffer.alloc(16, 17);
  const expected = match ? Buffer.from(match[2], "base64url") : Buffer.alloc(KEY_LENGTH);
  const key = await derive(password, salt);
  return Boolean(match) && timingSafeEqual(key, expected);
}
