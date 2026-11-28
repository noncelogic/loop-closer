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
// on the host from the Dockerfile's node base pinned by digest in
// candidate-node-base.ref. ci's `test` job provisions that base before the suite
// runs; this file never pulls it, so the build needs no registry and no cache it
// did not put there. Requires Docker, like tests/schema.
//
// Each deploy runs through withCandidate: it gets the test's cancellation
// signal, and its candidate is removed only after the deploy has stopped; the
// suite's teardown waits for every deploy and its removal before removing the
// images they run.
import { after, before, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parse } from "yaml";
import { REPO_ROOT, deployCandidate, removeCandidate, type DeployCandidateInput } from "../../.github/scripts/deploy-candidate.mjs";
import { buildEntrypoints, type EntrypointBuild } from "../support/entrypoint-build.ts";

const run = `${process.pid}-${randomBytes(3).toString("hex")}`;
const IMAGE = `loopcloser:candidate-dbrole-${run}`;
const SUPERUSER_IMAGE = `loopcloser:candidate-dbrole-su-${run}`;
/** The pinned node base, tagged under a run-local name so the build resolves it from the daemon and nowhere else. */
const BASE_IMAGE = `loopcloser:candidate-dbrole-base-${run}`;
const NODE_BASE = readFileSync(join(import.meta.dirname, "candidate-node-base.ref"), "utf8").trim();
const initdb = (parse(readFileSync(join(REPO_ROOT, "deploy", "base", "database.yaml"), "utf8")) as any).spec.bootstrap.initdb;
const OWNER: string = initdb.owner;
const DATABASE: string = initdb.database;
const TEST_TIMEOUT_MS = 300_000;

let scratch = "";
let build: EntrypointBuild | undefined;
/** Every candidate's deploy-and-removal, each settled only once its candidate is gone. */
const lifecycles = new Set<Promise<void>>();

function docker(args: string[], timeout = 120_000): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024, timeout, killSignal: "SIGKILL" });
}

/** One SQL query against the candidate's database, as the container's bootstrap superuser, unaligned rows. */
function sql(name: string, query: string): string[] {
  const out = docker(["exec", `${name}-db`, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", DATABASE, "-Atc", query], 30_000);
  return out.split("\n").filter(Boolean);
}

/** Polls `probe` until it yields a value, failing after `deadlineMs` or once `signal` aborts. */
async function waitFor<T>(what: string, deadlineMs: number, signal: AbortSignal, probe: () => T | undefined): Promise<T> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    signal.throwIfAborted();
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`${what} within ${deadlineMs} ms`);
    await delay(100, undefined, { signal });
  }
}

/**
 * Deploys a candidate with the test's cancellation signal and hands `use` the deploy in flight. Whatever `use`
 * does, and even after the test timed out, the candidate is removed only once the deploy has stopped.
 */
async function withCandidate<T>(
  t: TestContext,
  input: Pick<DeployCandidateInput, "image" | "name">,
  use: (deploying: ReturnType<typeof deployCandidate>) => Promise<T>,
): Promise<T> {
  const deploying = deployCandidate({ ...input, keysRoot: scratch, intervalMs: 1_000, attempts: 90, signal: t.signal });
  const stopped = deploying.then(() => undefined, () => undefined);
  const life = (async () => {
    try {
      return await use(deploying);
    } finally {
      await stopped;
      removeCandidate({ name: input.name });
    }
  })();
  lifecycles.add(life.then(() => undefined, () => undefined));
  return life;
}

/**
 * Opens a superuser session on the candidate's database that holds ACCESS EXCLUSIVE on public.loops, the table
 * GET /v1/loops reads, so the API's query waits on it with its session open. `release` rolls the lock back.
 */
async function lockLoops(name: string, signal: AbortSignal): Promise<{ pid: number; release: () => Promise<void> }> {
  const psql = spawn("docker", ["exec", "-i", `${name}-db`, "psql", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", DATABASE], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  psql.stdout.on("data", (d) => (out += d));
  psql.stderr.on("data", (d) => (out += d));
  const exited = once(psql, "exit");
  const release = async (): Promise<void> => {
    if (psql.exitCode === null && psql.signalCode === null) {
      psql.stdin.end("ROLLBACK;\n");
      const timer = setTimeout(() => psql.kill("SIGKILL"), 15_000);
      try {
        await exited;
      } finally {
        clearTimeout(timer);
      }
    }
  };
  try {
    psql.stdin.write("BEGIN;\nLOCK TABLE public.loops IN ACCESS EXCLUSIVE MODE;\nSELECT 'locked:' || pg_backend_pid();\n");
    const pid = await waitFor("the lock session did not take its lock", 30_000, signal, () => {
      if (psql.exitCode !== null) throw new Error(`the lock session exited: ${out}`);
      const m = /^locked:(\d+)$/m.exec(out);
      return m ? Number(m[1]) : undefined;
    });
    return { pid, release };
  } catch (err) {
    await release();
    throw err;
  }
}

before(async () => {
  scratch = mkdtempSync(join(tmpdir(), "lc-candidate-dbrole-"));
  const app = join(scratch, "image");
  build = await buildEntrypoints("candidate-dbrole");
  cpSync(build.outDir, join(app, "dist"), { recursive: true });
  for (const p of ["package.json", "contracts", "db/migrations", "node_modules"]) cpSync(join(REPO_ROOT, p), join(app, p), { recursive: true });
  // The Dockerfile's base, pinned by digest: the pin must be of the tag the Dockerfile names, and must already be
  // in the daemon (ci's `test` job provisions it), so the build reaches no registry.
  const base = /^ARG NODE_IMAGE=(\S+)$/m.exec(readFileSync(join(REPO_ROOT, "Dockerfile"), "utf8"))?.[1];
  assert.ok(base, "the Dockerfile names no NODE_IMAGE");
  assert.ok(NODE_BASE.startsWith(`${base}@sha256:`) && /@sha256:[0-9a-f]{64}$/.test(NODE_BASE), `candidate-node-base.ref (${NODE_BASE}) is not ${base} pinned by digest`);
  try {
    docker(["image", "inspect", "--format", "{{.Id}}", NODE_BASE]);
  } catch {
    assert.fail(`the node base ${NODE_BASE} is not in the docker daemon; provision it first: docker pull ${NODE_BASE}`);
  }
  docker(["tag", NODE_BASE, BASE_IMAGE]);
  // The Dockerfile's runtime image: its base, workdir and user; CMD is unused, the deployer names each entrypoint.
  // The private build's directory is mkdtemp's 0700, so the image makes the app readable to its user.
  writeFileSync(join(app, "Dockerfile"), `FROM ${BASE_IMAGE}\nENV NODE_ENV=production\nWORKDIR /app\nCOPY . .\nRUN chmod -R a+rX /app\nUSER node\n`);
  docker(["build", "--quiet", "--tag", IMAGE, app], 600_000);
  // The same image with one more migration, which only a superuser may apply.
  const ctx = join(scratch, "superuser-image");
  mkdirSync(ctx);
  writeFileSync(join(ctx, "9999_needs_superuser.sql"), "SET session_replication_role = replica;\n");
  writeFileSync(join(ctx, "Dockerfile"), `FROM ${IMAGE}\nCOPY 9999_needs_superuser.sql /app/db/migrations/\n`);
  docker(["build", "--quiet", "--tag", SUPERUSER_IMAGE, ctx], 300_000);
}, { timeout: 900_000 });

after(async () => {
  // A deploy still running (its test timed out) owns its containers until it stops and is removed.
  await Promise.all(lifecycles);
  execFileSync("docker", ["image", "rm", "--force", IMAGE, SUPERUSER_IMAGE, BASE_IMAGE], { stdio: "ignore", timeout: 120_000 });
  build?.remove();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

test("candidate migrations and the API connect as the estate database owner role, which is not a superuser", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const name = `lc-candidate-dbrole-${run}`;
  await withCandidate(t, { image: IMAGE, name }, async (deploying) => {
    const out = await deploying;

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

    // The API reads the database as the owner. With public.loops locked, a joe call's query waits on the lock, so
    // its session is still open to inspect: the backend the lock blocks is the owner's.
    const key = readFileSync(join(out.keysDir, "joe"), "utf8").trim();
    const lock = await lockLoops(name, t.signal);
    let response: Promise<Response>;
    try {
      response = fetch(`${out.url}/v1/loops`, {
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.any([AbortSignal.timeout(60_000), t.signal]),
      });
      response.catch(() => {});
      const blocked = await waitFor("no API session waited on the lock on public.loops", 30_000, t.signal, () => {
        const rows = sql(name, `SELECT usename FROM pg_stat_activity WHERE ${lock.pid} = ANY(pg_blocking_pids(pid))`);
        return rows.length > 0 ? rows : undefined;
      });
      assert.deepEqual(blocked, [OWNER], "the API is connected as a role other than the estate database owner");
    } finally {
      await lock.release();
    }
    const res = await response;
    assert.equal(res.status, 200, await res.text());
  });
});

test("a migration that needs superuser privileges fails the candidate deploy", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const name = `lc-candidate-dbrole-su-${run}`;
  await withCandidate(t, { image: SUPERUSER_IMAGE, name }, async (deploying) => {
    await assert.rejects(deploying, (err: Error) => {
      assert.match(err.message, /^docker run --rm --name lc-candidate-dbrole-su-\S+-migrate /);
      assert.match(err.message, /9999_needs_superuser\.sql/);
      assert.match(err.message, /permission denied to set parameter "session_replication_role"/);
      return true;
    });
    // The deploy stopped at the migration: the API never started, and nothing was recorded for the failed file.
    assert.equal(docker(["ps", "--all", "--quiet", "--filter", `name=^${name}-api$`]).trim(), "");
    assert.deepEqual(sql(name, "SELECT count(*) FROM schema_migrations WHERE version = '9999'"), ["0"]);
  });
});
