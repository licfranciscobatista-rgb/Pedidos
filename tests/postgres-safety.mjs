// Integration tests may mutate only the verified disposable Neon QA branch.
// Never fall back to DATABASE_URL: that variable can point at the live app.
export function testDatabaseUrl(environment = process.env) {
  const value = environment.TEST_DATABASE_URL;
  if (!value) return undefined;
  let target;
  try { target = new URL(value); }
  catch { throw new Error("TEST_DATABASE_URL must be a valid PostgreSQL QA URL"); }
  if (!["postgres:", "postgresql:"].includes(target.protocol) ||
      !/^ep-cool-mode-b8d95ej7(?:-pooler)?\.[a-z0-9.-]+\.neon\.tech$/i.test(target.hostname) ||
      // node-postgres lets URL query parameters override host and connection
      // options. Accept only the TLS parameters used by the verified QA URL.
      [...target.searchParams.keys()].some(key => !["sslmode", "channel_binding"].includes(key))) {
    throw new Error("PostgreSQL integration tests permit only the verified QA branch");
  }
  return value;
}
