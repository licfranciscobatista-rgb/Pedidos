import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) return { url: pathToFileURL(resolve(root, specifier.slice(2)) + ".ts").href, shortCircuit: true };
  if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
    const candidate = fileURLToPath(new URL(specifier, context.parentURL));
    if (existsSync(candidate + ".ts")) return { url: pathToFileURL(candidate + ".ts").href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
} });
const { authConfiguration, sessionCookieName } = await import("../lib/auth/config.ts");
const { constantTimeEqual, hashPassword, validNewPassword, verifyPassword } = await import("../lib/auth/password.ts");
const { authBody, requireAuthConfig } = await import("../lib/auth/http.ts");
const { readSession, setupState, sessionCookie, tokenHash, validSessionToken } = await import("../lib/auth/session.ts");
const environment = { APP_OWNER_USERNAME: "ADMINISTRADOR", APP_DATA_OWNER_ID: "40000000-0000-4000-8000-000000000001", APP_ORIGIN: "https://orders.example.test", NODE_ENV: "production", APP_SETUP_TOKEN: "isolated-test-only-not-real-secret-0123456789" };

test("configuración privada: usuario explícito, namespace UUID y origen HTTPS", async () => {
  const config = authConfiguration(environment);
  assert.equal(config.ownerUsername, "ADMINISTRADOR");
  assert.equal(config.normalizedUsername, "administrador");
  for (const key of ["APP_OWNER_USERNAME", "APP_DATA_OWNER_ID", "APP_ORIGIN"]) assert.equal(authConfiguration({ ...environment, [key]: "" }), null);
  assert.equal(authConfiguration({ ...environment, APP_ORIGIN: "http://orders.example.test" }), null);
  assert.equal(authConfiguration({ ...environment, APP_ORIGIN: "https://user:pass@orders.example.test" }), null);
  assert.equal(authConfiguration({ ...environment, APP_ORIGIN: "https://orders.example.test/path" }), null);
  assert.equal(authConfiguration({ ...environment, APP_OWNER_USERNAME: "everyone@site.test" }), null);
  assert.equal(authConfiguration({ ...environment, APP_DATA_OWNER_ID: "first-registrant" }), null);
  assert.notEqual(authConfiguration({ ...environment, APP_ORIGIN: "http://127.0.0.1:5173", NODE_ENV: "development" }), null);
  assert.equal(await readSession(undefined, null), null);
  assert.equal(await setupState(null), "unavailable");
});

test("contraseñas scrypt: sal distinta, comparación correcta y política de longitud", async () => {
  const password = "Una clave de prueba 8274";
  assert.equal(validNewPassword("muy corta"), false);
  assert.equal(validNewPassword("a".repeat(257)), false);
  assert.equal(validNewPassword(password), true);
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  assert.match(first, /^scrypt\$v1\$131072\$8\$1\$/);
  assert.notEqual(first, second);
  assert.ok(!first.includes(password));
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword("Una clave equivocada", first), false);
  assert.equal(await verifyPassword(password, null), false);
  assert.equal(constantTimeEqual("secret", "secret"), true);
  assert.equal(constantTimeEqual("secret", "secret-more"), false);
});

test("sesión opaca: hash independiente y cookie segura de siete días", () => {
  const config = authConfiguration(environment);
  const token = "a".repeat(43);
  assert.equal(validSessionToken(token), true);
  assert.equal(validSessionToken("other-user/token"), false);
  assert.equal(tokenHash(token).length, 64);
  assert.notEqual(tokenHash(token), token);
  const cookie = sessionCookie(token, config);
  for (const flag of ["__Host-mi_encargo_session=", "HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=604800"]) assert.ok(cookie.includes(flag), flag);
  assert.ok(!cookie.includes("Domain="));
  assert.match(sessionCookie("", config, true), /Max-Age=0/);
  assert.equal(sessionCookieName(false), "mi_encargo_session");
});

test("peticiones de acceso: origen obligatorio, JSON limitado y errores de datos", async () => {
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  const request = (body, origin = environment.APP_ORIGIN, type = "application/json") => new Request("http://internal-render-host/api/auth/login", { method: "POST", headers: { ...(origin ? { origin } : {}), "content-type": type }, body });
  try {
    assert.equal(requireAuthConfig(request("{}")).appOrigin, environment.APP_ORIGIN, "usa el origen canónico aunque el host interno sea distinto");
    assert.throws(() => requireAuthConfig(request("{}", "https://attacker.test")), { status: 403 });
    assert.throws(() => requireAuthConfig(request("{}", "")), { status: 403 });
    assert.throws(() => requireAuthConfig(request("{}", environment.APP_ORIGIN, "text/plain")), { status: 415 });
    assert.deepEqual(await authBody(request('{"username":"ADMINISTRADOR"}')), { username: "ADMINISTRADOR" });
    await assert.rejects(authBody(request("[]")), { status: 400 });
    await assert.rejects(authBody(request("{invalid")), { status: 400 });
    await assert.rejects(authBody(request('"' + "x".repeat(9000) + '"')), { status: 413 });
    delete process.env.APP_OWNER_USERNAME;
    assert.throws(() => requireAuthConfig(request("{}")), { status: 503 });
  } finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});
