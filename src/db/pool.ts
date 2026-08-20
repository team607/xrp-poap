/**
 * Connection plumbing for the attendance index.
 *
 * Deliberately tiny and deliberately without a module-level singleton: a
 * cached pool leaks across vitest files, keeps the process alive after a run,
 * and makes "point this suite at a scratch database" impossible. Callers own
 * the pool they create and close it.
 */
import { Pool, type PoolConfig } from "pg";
import { loadConfig } from "../config.js";
import { ConfigError, type XrplLayerError } from "../errors.js";

/**
 * The narrow slice of `pg.Pool` the repositories actually use.
 *
 * Typed here rather than importing `Pool` into every repository so the stores
 * stay injectable: a PoolClient inside a transaction, a stub, or a logging
 * wrapper all satisfy this.
 */
export interface QueryResultLike {
  rows: any[];
  rowCount: number | null;
}

export interface Queryable {
  query(text: string, values?: any[]): Promise<QueryResultLike>;
}

/** A checked-out connection. `pg.PoolClient` satisfies this. */
export interface TransactionClient extends Queryable {
  release(err?: Error | boolean): void;
}

/** Anything that can hand out a dedicated connection. `pg.Pool` satisfies this. */
export interface Connectable extends Queryable {
  connect(): Promise<TransactionClient>;
}

function isConnectable(db: Queryable): db is Connectable {
  return typeof (db as Partial<Connectable>).connect === "function";
}

async function runInTransaction<T>(
  client: Queryable,
  fn: (tx: Queryable) => Promise<T>,
): Promise<T> {
  await client.query("BEGIN");
  try {
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // A rollback that fails means the connection is already gone, which is
      // the same outcome. The original error is the one worth surfacing.
    }
    throw err;
  }
}

/**
 * Runs `fn` inside one transaction, on one connection.
 *
 * THE POOL IS NOT A CONNECTION. `pool.query("BEGIN")` takes a connection from
 * the pool, begins a transaction on it and hands it straight back — the next
 * statement may land on a different connection entirely, leaving an orphaned
 * transaction open and the "atomic" work committed piecemeal. Anything that
 * needs BEGIN, and in particular anything that needs `pg_advisory_xact_lock`,
 * must go through here.
 *
 * When `db` cannot hand out a connection (a stub, or a PoolClient a caller
 * already checked out) the statements run on it directly. That caller must not
 * already be inside a transaction: this would COMMIT theirs.
 */
export async function withTransaction<T>(
  db: Queryable,
  fn: (tx: Queryable) => Promise<T>,
): Promise<T> {
  if (!isConnectable(db)) return runInTransaction(db, fn);

  const client = await db.connect();
  try {
    return await runInTransaction(client, fn);
  } finally {
    client.release();
  }
}

export interface CreatePoolOptions extends Omit<PoolConfig, "connectionString"> {
  /** Skip reading a .env file when falling back to loadConfig(). */
  skipDotenv?: boolean;
}

/**
 * DATABASE_URL, via loadConfig so a .env file is honoured.
 *
 * loadConfig validates the whole app config, and the index has no business
 * demanding an XRPL endpoint before it will open a socket to Postgres — a
 * migration container legitimately holds neither a seed nor an endpoint. So a
 * CONFIG_INVALID from an unrelated variable falls back to the environment,
 * while NETWORK_GUARD still propagates: that guard exists to stop a mainnet
 * mistake and must never be swallowed.
 */
function databaseUrlFromConfig(skipDotenv: boolean): string | undefined {
  try {
    return loadConfig({ requireIssuer: false, skipDotenv }).databaseUrl;
  } catch (err) {
    if ((err as XrplLayerError).code !== "CONFIG_INVALID") throw err;
    const fromEnv = process.env.DATABASE_URL;
    return fromEnv && fromEnv.trim() !== "" ? fromEnv.trim() : undefined;
  }
}

/**
 * Builds a pool from an explicit URL, or from DATABASE_URL when the argument
 * is omitted. Throws ConfigError rather than handing back a pool that will
 * fail on first query with a connection error nobody can trace.
 */
export function createPool(databaseUrl?: string, options: CreatePoolOptions = {}): Pool {
  const { skipDotenv = false, ...poolConfig } = options;

  const url = databaseUrl ?? databaseUrlFromConfig(skipDotenv);

  if (!url || url.trim() === "") {
    throw new ConfigError(
      "DATABASE_URL is not set. The attendance index needs a Postgres connection string; " +
        "pass one to createPool() or use the in-memory stores from src/db/memory.ts.",
      { key: "DATABASE_URL" },
    );
  }

  return new Pool({ ...poolConfig, connectionString: url });
}

/** Idempotent. Safe to call in an afterAll that may run twice. */
export async function closePool(pool: Pool): Promise<void> {
  if (pool.ended || pool.ending) return;
  await pool.end();
}
