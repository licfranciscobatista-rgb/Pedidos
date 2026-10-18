import { test } from "node:test";
import assert from "node:assert/strict";
import { testDatabaseUrl } from "./postgres-safety.mjs";

test("PostgreSQL tests reject live, malformed and lookalike endpoints without printing credentials", () => {
  const valid = "postgresql://qa:fake@ep-cool-mode-b8d95ej7.us-east-2.aws.neon.tech/qa";
  assert.equal(testDatabaseUrl({ TEST_DATABASE_URL: valid }), valid);
  assert.equal(testDatabaseUrl({ TEST_DATABASE_URL: valid.replace("b8d95ej7.", "b8d95ej7-pooler.") }).includes("-pooler."), true);
  assert.equal(testDatabaseUrl({ DATABASE_URL: "postgresql://live:secret@production.example/live" }), undefined);
  for (const value of ["invalid", "postgresql://live:secret@production.example/live", valid.replace("neon.tech", "neon.tech.attacker.example"), valid.replace("postgresql:", "https:"), valid + "?host=production.example", valid + "?options=endpoint%3Dproduction"]) {
    assert.throws(() => testDatabaseUrl({ TEST_DATABASE_URL: value }), error => !error.message.includes("secret") && !error.message.includes("fake"));
  }
});
