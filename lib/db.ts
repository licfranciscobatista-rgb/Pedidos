import { Pool, types, type PoolClient, type QueryResultRow } from "pg";

// Monetary values and epoch milliseconds fit safely within JS's exact integer
// range. Never silently round a database integer outside that range.
types.setTypeParser(20, value => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("Database integer exceeds the supported range");
  return parsed;
});

export class TransactionConflict extends Error {
  constructor() { super("transaction_conflict"); this.name = "TransactionConflict"; }
}
export function isTransactionConflict(error: unknown): boolean {
  return error instanceof TransactionConflict || Boolean(error && typeof error === "object" && "code" in error && ["23505", "23503", "23514", "40001", "40P01"].includes(String(error.code)));
}
export function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "23505");
}

export type DbResult<T = Record<string, unknown>> = { success: true; results: T[]; meta: { changes: number } };
export class PreparedStatement {
  constructor(readonly database: Database, readonly sql: string, readonly values: unknown[] = [], readonly assertion = false) {}
  bind(...values: unknown[]): PreparedStatement { return new PreparedStatement(this.database, this.sql, values, this.assertion); }
  asAssertion(): PreparedStatement { return new PreparedStatement(this.database, this.sql, this.values, true); }
  async first<T = Record<string, unknown>>(): Promise<T | null> { return (await this.all<T>()).results[0] ?? null; }
  async all<T = Record<string, unknown>>(): Promise<DbResult<T>> { return (await this.database.batch([this]))[0] as DbResult<T>; }
  async run<T = Record<string, unknown>>(): Promise<DbResult<T>> { return this.all<T>(); }
}

let pool: Pool | undefined;
export function getPool(): Pool {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured");
  pool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 8, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 15_000 });
  return pool;
}
export async function closeDatabasePool(): Promise<void> { const current = pool; pool = undefined; await current?.end(); }

export class Database {
  constructor(readonly ownerId: string, readonly connectionPool: Pool = getPool()) {}
  prepare(sql: string): PreparedStatement { return new PreparedStatement(this, sql); }
  async batch(statements: PreparedStatement[]): Promise<DbResult[]> {
    if (statements.some(item => item.database !== this)) throw new Error("A transaction cannot mix database contexts");
    const client = await this.connectionPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '15s'");
      await client.query("SET LOCAL statement_timeout = '30s'");
      // Every operation for one owner uses this transaction-level lock. Reads
      // and writes below therefore see committed preceding mutations, while
      // different owners remain independent. It also works with PgBouncer.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))", [this.ownerId]);
      const results: DbResult[] = [];
      for (const statement of statements) results.push(await execute(client, statement));
      await client.query("COMMIT");
      return results;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }
}
async function execute(client: PoolClient, statement: PreparedStatement): Promise<DbResult> {
  const result = await client.query<QueryResultRow>(statement.sql, statement.values);
  if (statement.assertion && result.rows[0]?.ok !== true) throw new TransactionConflict();
  return { success: true, results: result.rows, meta: { changes: result.rowCount ?? 0 } };
}
export function getDatabase(ownerId: string): Database { return new Database(ownerId); }
