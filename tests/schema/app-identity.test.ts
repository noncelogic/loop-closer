// LC-EST-DB-ROLE acceptance: on the estate, the migrate entrypoint connects as
// `loopcloser`, the CloudNativePG initdb owner, which has no CREATEROLE. The
// cluster bootstrap (deploy/base/database.yaml, initdb.postInitSQL, run by the
// operator as superuser) creates `loopcloser_app` first, so 0001's role guard
// finds it and the migrations apply under the owning identity with least
// privilege. This replays that shape on a Compose replica: a NOSUPERUSER
// NOCREATEROLE owner of a fresh database, the bootstrap SQL read from the
// manifest, and the real migrate CLI over DATABASE_URL.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { migrationFiles, migrationsDir, Replica, repoRoot } from "./replica.ts";

const db = new Replica("schema-app-identity");
const scratch: string[] = [];

before(() => db.up(), { timeout: 300_000 });
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  db.down();
}, { timeout: 120_000 });

/** The superuser statements the CNPG cluster runs at bootstrap. */
function bootstrapSql(): string[] {
  const cluster = parse(readFileSync(join(repoRoot, "deploy", "base", "database.yaml"), "utf8"));
  return (cluster?.spec?.bootstrap?.initdb?.postInitSQL ?? []) as string[];
}

/** A login role shaped like CNPG's initdb owner: owns its database, no superuser, no CREATEROLE. */
function ownerDatabase(owner: string, database: string): void {
  db.psql(`CREATE ROLE ${owner} LOGIN PASSWORD '${owner}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
  db.psql(`CREATE DATABASE ${database} OWNER ${owner}`);
}

function runMigrateAs(owner: string, database: string, files: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "lc-app-identity-"));
  scratch.push(dir);
  for (const f of files) copyFileSync(join(migrationsDir, f), join(dir, f));
  const url = `postgres://${owner}:${owner}@127.0.0.1:${db.hostPort()}/${database}`;
  const res = spawnSync(process.execPath, [join(repoRoot, "src", "migrate.ts")], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: url, MIGRATIONS_DIR: dir },
    timeout: 60_000,
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

const firstTwo = () => migrationFiles().filter((f) => /^000[12]_/.test(f));

test(
  "0001 and 0002 apply as an owner role without CREATEROLE once loopcloser_app exists",
  { timeout: 120_000 },
  () => {
    const files = firstTwo();
    assert.deepEqual(files.map((f) => f.slice(0, 4)), ["0001", "0002"]);

    // Without the bootstrap role, the owner cannot create it: CREATEROLE is the
    // privilege the bootstrap step exists to avoid.
    ownerDatabase("lc_owner_bare", "app_identity_bare");
    assert.equal(db.psql("select exists (select 1 from pg_roles where rolname = 'loopcloser_app')"), "f");
    const bare = runMigrateAs("lc_owner_bare", "app_identity_bare", files);
    assert.notEqual(bare.status, 0, "0001 must not be able to create loopcloser_app without CREATEROLE");
    assert.match(bare.stderr, /permission denied to create role/);

    // Cluster bootstrap, as superuser, exactly as deploy/base/database.yaml declares it.
    const statements = bootstrapSql();
    assert.ok(statements.length > 0, "deploy/base/database.yaml must declare initdb.postInitSQL");
    for (const stmt of statements) db.psql(stmt, { database: "postgres" });
    assert.equal(
      db.psql(
        "select rolcanlogin::text || rolsuper::text || rolcreaterole::text || rolcreatedb::text || rolinherit::text " +
          "from pg_roles where rolname = 'loopcloser_app'",
      ),
      "falsefalsefalsefalsefalse",
    );

    ownerDatabase("lc_owner", "app_identity");
    assert.equal(db.psql("select rolcreaterole or rolsuper from pg_roles where rolname = 'lc_owner'"), "f");
    const run = runMigrateAs("lc_owner", "app_identity", files);
    assert.equal(run.status, 0, run.stderr);
    const sql = (text: string) => db.psql(text, { database: "app_identity" });
    assert.equal(sql("select string_agg(version, ',' order by version) from schema_migrations"), "0001,0002");
    // The owner owns the schema it took; the app role holds only its grants.
    assert.equal(sql("select pg_get_userbyid(relowner) from pg_class where oid = 'public.loops'::regclass"), "lc_owner");
    assert.equal(sql("select has_table_privilege('loopcloser_app', 'public.loops', 'INSERT')::text"), "true");
    assert.equal(sql("select has_table_privilege('loopcloser_app', 'public.loops', 'DELETE')::text"), "false");
  },
);
