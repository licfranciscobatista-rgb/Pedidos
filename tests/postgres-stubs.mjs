// This module replaces only account/storage wiring during integration tests.
// Database SQL and its transaction adapter are the real production code.
export * from "../lib/db.ts";
export function getDatabase(ownerId) {
  if (!globalThis.__postgresTestDatabase) throw new Error("Create an isolated test database first");
  return globalThis.__postgresTestDatabase(ownerId);
}
export async function getAppUser() { return globalThis.__postgresTestUser ?? null; }
export async function getPhotoBucket() {
  if (!globalThis.__postgresTestBucket) throw new Error("No test photo bucket configured");
  return globalThis.__postgresTestBucket;
}
