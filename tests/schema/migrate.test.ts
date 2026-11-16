// LC-RUN-MIGRATE acceptance: the migrate entrypoint (src/migrate.ts, shipped in
// the image as `node dist/migrate.js`) applies only the db/migrations files
// missing from schema_migrations, in filename order, one transaction each, and
// stops at the first failure without recording it. Each test gets its own
// database on one Compose replica and drives the real CLI over DATABASE_URL.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrationFiles, migrationsDir, Replica, repoRoot } from "./replica.ts";

const db = new Replica("schema-migrate");
const scratch: string[] = [];

before(() => db.up(), { timeout: 300_000 });
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  db.down();
}, { timeout: 120_000 });

/** A fresh, empty database on the replica. */
function freshDatabase(name: string): string {
  db.psql(`CREATE DATABASE ${name}`);
  return name;
}

/** A migrations directory holding the named real files plus extra `{file: sql}` ones. */
function migrationsFixture(real: string[], extra: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "lc-migrate-"));
  scratch.push(dir);
  for (const f of real) copyFileSync(join(migrationsDir, f), join(dir, f));
  for (const [f, sql] of Object.entries(extra)) writeFileSync(join(dir, f), sql);
  return dir;
}

/** Runs the migrate entrypoint the way the image does: DATABASE_URL in, exit code out. */
function runMigrate(database: string, dir: string): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [join(repoRoot, "src", "migrate.ts")], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: db.databaseUrl(database), MIGRATIONS_DIR: dir },
    timeout: 60_000,
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

const sql = (database: string, text: string) => db.psql(text, { database });
const versions = (database: string) => sql(database, "select version || ':' || name from schema_migrations order by version");
const tableExists = (database: string, table: string) => sql(database, `select to_regclass('public.${table}') is not null`) === "t";

test(
  "applies only missing migrations in order and records each version in schema_migrations",
  { timeout: 120_000 },
  () => {
    const real = migrationFiles();
    assert.ok(real.length >= 2, "expected at least two real migrations");
    const database = freshDatabase("migrate_in_order");

    // First run: only the first real migration exists.
    const first = runMigrate(database, migrationsFixture(real.slice(0, 1)));
    assert.equal(first.status, 0, first.stderr);
    assert.equal(versions(database), "0001:loop_model");

    // Second run: every real migration, plus two later ones without their own
    // BEGIN/COMMIT or version insert; 0901 depends on 0900 having run first.
    const dir = migrationsFixture(real, {
      "0901_probe_rows.sql": "INSERT INTO migrate_probe (step) VALUES ('0901');\n",
      "0900_probe_table.sql": "CREATE TABLE migrate_probe (step text PRIMARY KEY);\n",
    });
    const second = runMigrate(database, dir);
    assert.equal(second.status, 0, second.stderr);
    // 0001 was not re-applied (re-running it would fail on CREATE TABLE schema_migrations).
    assert.doesNotMatch(second.stdout, /0001_loop_model/);
    const expected = [...real.map((f) => `${f.slice(0, 4)}:${f.slice(5, -4)}`), "0900:probe_table", "0901:probe_rows"];
    assert.deepEqual(versions(database).split("\n"), expected);
    assert.equal(sql(database, "select string_agg(step, ',') from migrate_probe"), "0901");

    // Third run: nothing missing, nothing applied, still one row per version.
    const third = runMigrate(database, dir);
    assert.equal(third.status, 0, third.stderr);
    assert.deepEqual(versions(database).split("\n"), expected);
    assert.equal(sql(database, "select count(*) from migrate_probe"), "1");
  },
);

test(
  "stops at a failing migration and leaves it and every later migration unrecorded",
  { timeout: 120_000 },
  () => {
    const real = migrationFiles();
    const database = freshDatabase("migrate_stops");
    const dir = migrationsFixture(real, {
      "0900_good.sql": "CREATE TABLE migrate_good (id int);\n",
      // Written like the real files (own BEGIN/COMMIT and version insert): its
      // table and its version row must both roll back.
      "0901_bad.sql": [
        "BEGIN;",
        "CREATE TABLE migrate_bad (id int);",
        "INSERT INTO schema_migrations (version, name) VALUES ('0901', 'bad');",
        "SELECT 1 / 0;",
        "COMMIT;",
        "",
      ].join("\n"),
      "0902_later.sql": "CREATE TABLE migrate_later (id int);\n",
    });

    const res = runMigrate(database, dir);
    assert.notEqual(res.status, 0, "a failing migration must exit nonzero");
    assert.match(res.stderr, /0901_bad\.sql/);
    assert.match(res.stderr, /division by zero/);

    // Earlier migrations stay committed and recorded.
    const expected = [...real.map((f) => `${f.slice(0, 4)}:${f.slice(5, -4)}`), "0900:good"];
    assert.deepEqual(versions(database).split("\n"), expected);
    assert.ok(tableExists(database, "migrate_good"), "0900's effects must be committed");
    // The failing migration rolled back entirely; the later one never ran.
    assert.ok(!tableExists(database, "migrate_bad"), "0901's effects must be rolled back");
    assert.ok(!tableExists(database, "migrate_later"), "0902 must not run after a failure");

    // Fixing the failure and re-running resumes at the failed version.
    writeFileSync(join(dir, "0901_bad.sql"), "CREATE TABLE migrate_bad (id int);\n");
    const retry = runMigrate(database, dir);
    assert.equal(retry.status, 0, retry.stderr);
    assert.deepEqual(versions(database).split("\n"), [...expected, "0901:bad", "0902:later"]);
  },
);

test(
  "refuses a database that holds loop tables but no schema_migrations table",
  { timeout: 120_000 },
  () => {
    const database = freshDatabase("migrate_untracked");
    sql(database, "CREATE TABLE loops (id text PRIMARY KEY)");

    const res = runMigrate(database, migrationsFixture(migrationFiles()));
    assert.notEqual(res.status, 0, "an untracked loop schema must be refused");
    assert.match(res.stderr, /schema_migrations/);
    assert.match(res.stderr, /\bloops\b/);
    // Nothing was applied: no tracking table, no other loop tables.
    assert.ok(!tableExists(database, "schema_migrations"));
    assert.ok(!tableExists(database, "nodes"));
  },
);
