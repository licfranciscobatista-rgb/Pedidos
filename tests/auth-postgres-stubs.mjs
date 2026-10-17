export function getPool() {
  if (!globalThis.__authTestPool) throw new Error("No isolated auth test pool");
  return globalThis.__authTestPool;
}
export async function cookies() {
  return { get(name) {
    const value = globalThis.__authTestCookies?.get(name);
    return value === undefined ? undefined : { value };
  } };
}
