// LC-DEPLOY-CANDIDATE-DB-ROLE acceptance: the candidate deployer
// (.github/scripts/deploy-candidate.mjs) bootstraps its Postgres the way
// deploy/base/database.yaml bootstraps the estate's, with the initdb owner role
// that is not a superuser, and runs the candidate's migrations and its API as
// that role, never as the Postgres bootstrap superuser. So a migration that
// needs superuser fails the candidate deploy, as it would fail on the estate.
//
// These run the real deployer against real docker: its own Postgres, the real
// migrate and API entrypoints, and the API reached over its published loopback
// port. The candidate image holds what the Dockerfile's image holds (this
// checkout's compiled dist, its node_modules, contracts and db/migrations), built
// on the host so the image build needs no registry access. Requires Docker, like
// tests/schema.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { REPO_ROOT, deployCandidate, removeCandidate } from "../../.github/scripts/deploy-candidate.mjs";
import { buildEntrypoints, type EntrypointBuild } from "../support/entrypoint-build.ts";

const run = `${process.pid}-${randomBytes(3).toString("hex")}`;
const IMAGE = `loopcloser:candidate-dbrole-${run}`;
const SUPERUSER_IMAGE = `loopcloser:candidate-dbrole-su-${run}`;
const initdb = (parse(readFileSync(join(REPO_ROOT, "deploy", "base", "database.yaml"), "utf8")) as any).spec.bootstrap.initdb;
const OWNER: string = initdb.owner;
const DATABASE: string = initdb.database;

let scratch = "";
let build: EntrypointBuild | undefined;

function docker(args: string[], input?: string): string {
  return execFileSync("docker", args, { encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
}

/** One SQL query against the candidate's database, as the container's bootstrap superuser, unaligned rows. */
function sql(name: string, query: string): string[] {
  const out = docker(["exec", `${name}-db`, "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", DATABASE, "-Atc", query]);
  return out.split("\n").filter(Boolean);
}

before(async () => {
  scratch = mkdtempSync(join(tmpdir(), "lc-candidate-dbrole-"));
  const app = join(scratch, "image");
  build = await buildEntrypoints("candidate-dbrole");
  cpSync(build.outDir, join(app, "dist"), { recursive: true });
  for (const p of ["package.json", "contracts", "db/migrations", "node_modules"]) cpSync(join(REPO_ROOT, p), join(app, p), { recursive: true });
  // The Dockerfile's runtime image: its base, workdir and user; CMD is unused, the deployer names each entrypoint.
  // The private build's directory is mkdtemp's 0700, so the image makes the app readable to its user.
  const base = /^ARG NODE_IMAGE=(\S+)$/m.exec(readFileSync(join(REPO_ROOT, "Dockerfile"), "utf8"))?.[1];
  assert.ok(base, "the Dockerfile names no NODE_IMAGE");
  writeFileSync(join(app, "Dockerfile"), `FROM ${base}\nENV NODE_ENV=production\nWORKDIR /app\nCOPY . .\nRUN chmod -R a+rX /app\nUSER node\n`);
  docker(["build", "--quiet", "--tag", IMAGE, app]);
  // The same image with one more migration, which only a superuser may apply.
  const ctx = join(scratch, "superuser-image");
  mkdirSync(ctx);
  writeFileSync(join(ctx, "9999_needs_superuser.sql"), "SET session_replication_role = replica;\n");
  writeFileSync(join(ctx, "Dockerfile"), `FROM ${IMAGE}\nCOPY 9999_needs_superuser.sql /app/db/migrations/\n`);
  docker(["build", "--quiet", "--tag", SUPERUSER_IMAGE, ctx]);
}, { timeout: 900_000 });

after(() => {
  execFileSync("docker", ["image", "rm", "--force", IMAGE, SUPERUSER_IMAGE], { stdio: "ignore" });
  build?.remove();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

test("candidate migrations and the API connect as the estate database owner role, which is not a superuser", { timeout: 300_000 }, async () => {
  const name = `lc-candidate-dbrole-${run}`;
  try {
    const out = await deployCandidate({ image: IMAGE, name, keysRoot: scratch, intervalMs: 1_000, attempts: 90 });

    // The owner role is the one database.yaml bootstraps, and it holds no superuser, CREATEDB or CREATEROLE.
    assert.deepEqual(sql(name, `SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = '${OWNER}'`), ["t|f|f|f"]);
    assert.deepEqual(sql(name, `SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = '${DATABASE}'`), [OWNER]);
    // database.yaml's postInitSQL and postInitApplicationSQL ran: the service role and pgvector exist.
    assert.deepEqual(sql(name, "SELECT rolcanlogin, rolsuper FROM pg_roles WHERE rolname = 'loopcloser_app'"), ["f|f"]);
    assert.deepEqual(sql(name, "SELECT extname FROM pg_extension WHERE extname = 'vector'"), ["vector"]);

    // The migrations ran as the owner: every table they created, and the applied record, belong to it.
    const owners = sql(name, "SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname = 'public'");
    assert.deepEqual(owners, [OWNER]);
    assert.ok(sql(name, "SELECT count(*) FROM schema_migrations")[0] !== "0", "no migration was applied");

    // The API reads the database as the owner: a joe call queries it, and its pooled connection is the owner's.
    const key = readFileSync(join(out.keysDir, "joe"), "utf8").trim();
    const res = await fetch(`${out.url}/v1/loops`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
    assert.equal(res.status, 200, await res.text());
    const sessions = sql(name, `SELECT DISTINCT usename FROM pg_stat_activity WHERE datname = '${DATABASE}' AND backend_type = 'client backend' AND pid <> pg_backend_pid()`);
    assert.deepEqual(sessions, [OWNER], "the API is connected as a role other than the estate database owner");
  } finally {
    removeCandidate({ name });
  }
});

test("a migration that needs superuser privileges fails the candidate deploy", { timeout: 300_000 }, async () => {
  const name = `lc-candidate-dbrole-su-${run}`;
  try {
    await assert.rejects(
      deployCandidate({ image: SUPERUSER_IMAGE, name, keysRoot: scratch, intervalMs: 1_000, attempts: 90 }),
      (err: Error) => {
        assert.match(err.message, /^docker run --rm --name lc-candidate-dbrole-su-\S+-migrate /);
        assert.match(err.message, /9999_needs_superuser\.sql/);
        assert.match(err.message, /permission denied to set parameter "session_replication_role"/);
        return true;
      },
    );
    // The deploy stopped at the migration: the API never started, and nothing was recorded for the failed file.
    assert.equal(docker(["ps", "--all", "--quiet", "--filter", `name=^${name}-api$`]).trim(), "");
    assert.deepEqual(sql(name, "SELECT count(*) FROM schema_migrations WHERE version = '9999'"), ["0"]);
  } finally {
    removeCandidate({ name });
  }
});
