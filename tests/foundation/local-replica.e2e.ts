// LC-M1-T1 acceptance: the one-command Compose replica boots Postgres in the
// deployment shape — a dedicated `loopcloser` database (no shared database
// with Corpus Ranker, TECH-STACK §2/§4) owned by a `loopcloser` role, with
// pgvector available (TECH-STACK §3).
//
// Requires Docker with the Compose plugin. Uses an isolated Compose project
// name so it never collides with a developer's running replica.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const project = `loopcloser-test-${process.pid}`;

function compose(args: string[], opts: { inherit?: boolean } = {}): string {
  return execFileSync("docker", ["compose", "--project-name", project, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: opts.inherit ? "inherit" : ["ignore", "pipe", "inherit"],
    // The replica must not need a host port for this test; 0 = ephemeral.
    env: { ...process.env, LOOPCLOSER_PG_PORT: "0" },
  }) ?? "";
}

function psql(sql: string): string {
  return compose([
    "exec", "-T", "postgres",
    "psql", "-U", "loopcloser", "-d", "loopcloser", "-v", "ON_ERROR_STOP=1", "-tAc", sql,
  ]).trim();
}

before(() => {
  // The one command a developer runs (see README / `npm run replica:up`).
  compose(["up", "--detach", "--wait", "--wait-timeout", "120"], { inherit: true });
}, { timeout: 300_000 });

after(() => {
  compose(["down", "--volumes", "--remove-orphans"], { inherit: true });
}, { timeout: 120_000 });

test("compose replica boots postgres", { timeout: 60_000 }, () => {
  assert.equal(psql("select 1"), "1");

  const major = Number(psql("show server_version_num")) / 10000;
  assert.ok(major >= 17, `expected Postgres 17+, got server_version_num/10000=${major}`);

  assert.equal(psql("select current_database()"), "loopcloser");
  assert.equal(
    psql("select pg_get_userbyid(datdba) from pg_database where datname = 'loopcloser'"),
    "loopcloser",
  );
  assert.equal(psql("select extname from pg_extension where extname = 'vector'"), "vector");
});
