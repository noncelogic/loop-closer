// Tracked migration runner (LC-RUN-MIGRATE). Applies the versioned schema files
// in db/migrations (`NNNN_name.sql`) that schema_migrations does not yet record,
// in filename order, each in exactly one transaction that also records its
// version, and stops at the first failure with that migration rolled back.
//
// The runner owns each migration's transaction. Files written self-contained
// (a top-level `BEGIN;` … `COMMIT;` wrapper and their own version insert, like
// 0001 and 0002) have the wrapper removed so their COMMIT cannot end the
// runner's transaction early; the runner records the version only when the file
// did not, so there is one schema_migrations row per migration either way.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";

export const MIGRATION_FILE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

/** Tables created by the loop model (0001). Any of these without schema_migrations is an untracked schema. */
export const LOOP_TABLES = [
  "communications",
  "edges",
  "ledger_events",
  "loop_members",
  "loop_state_transitions",
  "loops",
  "nodes",
  "outbox",
] as const;

/** Session advisory lock key, so two runners never apply the same migration concurrently. */
const LOCK_KEY = 0x6c635f6d; // "lc_m"

export interface Migration {
  version: string;
  name: string;
  file: string;
  sql: string;
}

export class MigrationError extends Error {
  override name = "MigrationError";
}

/** Reads every `NNNN_name.sql` in `dir`, in filename (= version) order. */
export function readMigrations(dir: string): Migration[] {
  const migrations: Migration[] = [];
  const seen = new Map<string, string>();
  for (const file of readdirSync(dir).sort()) {
    const m = MIGRATION_FILE.exec(file);
    if (!m) continue;
    const [, version = "", name = ""] = m;
    const other = seen.get(version);
    if (other) throw new MigrationError(`duplicate migration version ${version}: ${other} and ${file}`);
    seen.set(version, file);
    migrations.push({ version, name, file, sql: readFileSync(join(dir, file), "utf8") });
  }
  return migrations;
}

const BEGIN_LINE = /^[ \t]*BEGIN[ \t]*;[ \t]*$/gim;
const COMMIT_LINE = /^[ \t]*COMMIT[ \t]*;[ \t]*$/gim;

/**
 * The statements to run inside the runner's transaction: the file itself, or —
 * when it carries its own top-level `BEGIN;` … `COMMIT;` — the file with that
 * wrapper removed. Any other placement of transaction control is refused.
 */
export function migrationBody(m: Migration): string {
  const begins = [...m.sql.matchAll(BEGIN_LINE)];
  const commits = [...m.sql.matchAll(COMMIT_LINE)];
  if (begins.length === 0 && commits.length === 0) return m.sql;
  const [begin] = begins;
  const [commit] = commits;
  if (begins.length !== 1 || commits.length !== 1 || !begin || !commit || begin.index > commit.index) {
    throw new MigrationError(
      `${m.file}: expected either no transaction control or one top-level "BEGIN;" line followed by one "COMMIT;" line`,
    );
  }
  return (
    m.sql.slice(0, begin.index) +
    m.sql.slice(begin.index + begin[0].length, commit.index) +
    m.sql.slice(commit.index + commit[0].length)
  );
}

async function scalar<T>(client: pg.ClientBase, text: string, values: unknown[] = []): Promise<T> {
  const res = await client.query(text, values);
  return Object.values(res.rows[0] ?? {})[0] as T;
}

/** Versions recorded in schema_migrations; refuses a loop schema that has no schema_migrations. */
async function appliedVersions(client: pg.ClientBase): Promise<Set<string>> {
  const tracked = await scalar<boolean>(client, "SELECT to_regclass('public.schema_migrations') IS NOT NULL");
  if (tracked) {
    const res = await client.query<{ version: string }>("SELECT version FROM public.schema_migrations");
    return new Set(res.rows.map((r) => r.version));
  }
  const res = await client.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1::text[]) ORDER BY tablename",
    [LOOP_TABLES],
  );
  if (res.rows.length > 0) {
    throw new MigrationError(
      `refusing to migrate: the database holds loop tables (${res.rows.map((r) => r.tablename).join(", ")}) ` +
        "but no public.schema_migrations table, so which migrations it has is unknown",
    );
  }
  return new Set();
}

async function applyOne(client: pg.ClientBase, m: Migration): Promise<void> {
  const body = migrationBody(m);
  await client.query("BEGIN");
  try {
    const xact = await scalar<string>(client, "SELECT pg_current_xact_id()::text");
    await client.query(body);
    if ((await scalar<string>(client, "SELECT pg_current_xact_id()::text")) !== xact) {
      throw new MigrationError("it ended the runner's transaction early");
    }
    await client.query(
      "INSERT INTO public.schema_migrations (version, name) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING",
      [m.version, m.name],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    const reason = err instanceof Error ? err.message : String(err);
    throw new MigrationError(`migration ${m.file} failed and was rolled back: ${reason}`, { cause: err });
  }
}

/**
 * Applies every migration whose version schema_migrations does not record, in
 * order, one transaction each. Throws at the first failure (that migration and
 * every later one stay unapplied and unrecorded). Returns the files applied.
 */
export async function migrate(
  client: pg.ClientBase,
  migrations: Migration[],
  log: (line: string) => void = () => undefined,
): Promise<string[]> {
  for (const m of migrations) migrationBody(m); // refuse malformed files before applying anything
  await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
  try {
    const applied = await appliedVersions(client);
    const pending = migrations.filter((m) => !applied.has(m.version));
    for (const m of pending) {
      await applyOne(client, m);
      log(`applied ${m.file}`);
    }
    return pending.map((m) => m.file);
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => undefined);
  }
}
