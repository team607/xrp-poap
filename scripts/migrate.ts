/**
 * Applies src/db/migrations/*.sql in filename order.
 *
 *   npm run migrate
 *
 * Each file runs inside its own transaction alongside the INSERT that records
 * it in schema_migrations, so a migration is either fully applied and recorded
 * or neither. Re-running is a no-op. Exits non-zero on the first failure —
 * this is meant to gate a deploy.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { ConfigError } from "../src/errors.js";
import { closePool, createPool } from "../src/db/pool.js";

const HERE = dirname(fileURLToPath(import.meta.url));

const CREATE_LEDGER = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name       text        PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )
`;

/** The slice of pg.PoolClient this script needs. */
interface MigrationClient {
  query(text: string, values?: any[]): Promise<{ rows: any[] }>;
}

/**
 * Run via tsx from source, the migrations sit next to the repositories. Run
 * from dist/, tsc has not copied the .sql files, so fall back to the source
 * tree relative to the working directory rather than failing obscurely.
 */
function migrationsDir(): string {
  const candidates = [
    resolve(HERE, "../src/db/migrations"),
    resolve(process.cwd(), "src/db/migrations"),
  ];
  const found = candidates.find((dir) => existsSync(dir));
  if (!found) {
    throw new ConfigError(
      `Could not find the migrations directory. Looked in:\n  ${candidates.join("\n  ")}`,
      { candidates },
    );
  }
  return found;
}

async function applyAll(
  client: MigrationClient,
  dir: string,
  files: string[],
): Promise<string[]> {
  await client.query(CREATE_LEDGER);

  const done = await client.query("SELECT name FROM schema_migrations");
  const already = new Set<string>(done.rows.map((r) => String(r.name)));

  const applied: string[] = [];

  for (const name of files) {
    if (already.has(name)) {
      console.log(`  = ${name} (already applied)`);
      continue;
    }

    const sql = readFileSync(join(dir, name), "utf8");

    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`Migration ${name} failed: ${(err as Error).message}`, { cause: err });
    }

    applied.push(name);
    console.log(`  + ${name}`);
  }

  return applied;
}

async function main(): Promise<void> {
  // requireIssuer: false — migrating the index has nothing to do with the
  // issuer seed, and this must run where nobody holds one.
  const cfg = loadConfig({ requireIssuer: false });
  const dir = migrationsDir();

  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b, "en"));

  if (files.length === 0) {
    console.log(`No .sql migrations found in ${dir}. Nothing to do.`);
    return;
  }

  console.log(`Applying migrations from ${dir}`);

  const pool = createPool(cfg.databaseUrl);
  let applied: string[] = [];

  try {
    const client = await pool.connect();
    try {
      applied = await applyAll(client, dir, files);
    } finally {
      client.release();
    }
  } finally {
    await closePool(pool);
  }

  console.log(
    applied.length === 0
      ? "Schema already up to date. Nothing applied."
      : `Applied ${applied.length} migration(s): ${applied.join(", ")}`,
  );
}

main().catch((err: unknown) => {
  const e = err as Error & { code?: string };
  console.error(`migrate failed${e.code ? ` [${e.code}]` : ""}: ${e.message}`);
  process.exitCode = 1;
});
