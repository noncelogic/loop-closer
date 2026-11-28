// LC-DEPLOY-CANDIDATE-DB-ROLE acceptance: the candidate deployer
// (.github/scripts/deploy-candidate.mjs) bootstraps its Postgres the way
// deploy/base/database.yaml bootstraps the estate's, with the initdb owner role
// that is not a superuser, and runs the candidate's migrations and its API as
// that role, never as the Postgres bootstrap superuser. So a migration that
// needs superuser fails the candidate deploy, as it would fail on the estate.
//
// These run the real deployer against real docker: its own Postgres, the real
// migrate and API entrypoints, and the API reached over its published loopback
// port. The candidate image holds what the Dockerfile's runtime stage holds
// (this checkout's compiled dist, its contracts and migrations, and its
// dependencies) on the Dockerfile's node base pinned by digest: ci.yml's `test`
// job names that base (CANDIDATE_NODE_BASE) and provisions it in its Docker
// daemon before the suite runs, and the build uses the dependencies the job has
// already installed, so building reaches no registry and runs no `npm ci`.
// Requires Docker, like tests/schema.
//
// Each deploy runs through withCandidate: it gets the test's cancellation
// signal and a deadline for the whole deploy, and its docker commands run
// asynchronously, each killed once the deploy is cancelled. The candidate is
// removed only after the deploy has stopped, and the fixture settles only once
// docker lists none of the candidate's containers, volumes or network; the
// suite's teardown waits for every deploy and its removal before removing the
// images they run.
import { after, before, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parse } from "yaml";
import { buildEntrypoints } from "../support/entrypoint-build.ts";
import { REPO_ROOT, candidateLeftovers, deployCandidate, dockerCli, removeCandidate, type DeployCandidateInput } from "../../.github/scripts/deploy-candidate.mjs";

const run = `${process.pid}-${randomBytes(3).toString("hex")}`;
const IMAGE = `loopcloser:candidate-dbrole-${run}`;
const SUPERUSER_IMAGE = `loopcloser:candidate-dbrole-su-${run}`;
// database.yaml's initdb names, with CloudNativePG's defaults for a name it leaves out: database `app`, owned by
// a role named as the database.
const initdb = (parse(readFileSync(join(REPO_ROOT, "deploy", "base", "database.yaml"), "utf8")) as any).spec?.bootstrap?.initdb ?? {};
const DATABASE: string = initdb.database ?? "app";
const OWNER: string = initdb.owner ?? DATABASE;
const TEST_TIMEOUT_MS = 300_000;
/** The deadline on each whole deploy, inside its test's timeout so its removal still runs within it. */
const DEPLOY_DEADLINE_MS = 200_000;
/** The bound on each docker command a removal or a check runs, so a hung one cannot outlive its test. */
const boundedDocker = dockerCli({ timeoutMs: 60_000 });

/** The digest-pinned node base ci.yml's `test` job provisions for these tests. */
const ciTest = (parse(readFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8")) as any).jobs.test;
const NODE_BASE = String(ciTest.env?.CANDIDATE_NODE_BASE ?? "");

let scratch = "";
/** Every candidate's deploy-and-removal, each settled only once its candidate is gone. */
const lifecycles = new Set<Promise<void>>();

/** One docker command, asynchronous: killed once `signal` aborts or after `timeoutMs`. */
function docker(args: string[], signal?: AbortSignal, timeoutMs = 120_000): Promise<string> {
  return dockerCli({ timeoutMs })(args, signal ? { signal } : {});
}

/** One SQL query against the candidate's database, as the container's bootstrap superuser, unaligned rows. */
async function sql(name: string, query: string, signal?: AbortSignal): Promise<string[]> {
  const out = await docker(["exec", `${name}-db`, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", DATABASE, "-Atc", query], signal, 30_000);
  return out.split("\n").filter(Boolean);
}

/** Polls `probe` until it yields a value, failing after `deadlineMs` or once `signal` aborts. */
async function waitFor<T>(what: string, deadlineMs: number, signal: AbortSignal, probe: () => Promise<T | undefined> | T | undefined): Promise<T> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    signal.throwIfAborted();
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`${what} within ${deadlineMs} ms`);
    await delay(100, undefined, { signal });
  }
}

/**
 * Deploys a candidate with the test's cancellation signal and a deadline for the whole deploy, and hands `use` the
 * deploy in flight. Whatever `use` does, and even after the test timed out, the candidate is removed only once the
 * deploy has stopped (its docker commands killed and exited), and the fixture settles only once docker lists
 * nothing of the candidate.
 */
async function withCandidate<T>(
  t: TestContext,
  input: Pick<DeployCandidateInput, "image" | "name">,
  use: (deploying: ReturnType<typeof deployCandidate>) => Promise<T>,
): Promise<T> {
  const deploying = deployCandidate({
    ...input, docker: dockerCli(), keysRoot: scratch, intervalMs: 1_000, attempts: 90, signal: t.signal, deadlineMs: DEPLOY_DEADLINE_MS,
  });
  const stopped = deploying.then(() => undefined, () => undefined);
  const life = (async () => {
    try {
      return await use(deploying);
    } finally {
      await stopped;
      await removeCandidate({ name: input.name, docker: boundedDocker });
      assert.deepEqual(await candidateLeftovers({ name: input.name, docker: boundedDocker }), [], `candidate ${input.name} outlived its test`);
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
  // The base is the Dockerfile's node base pinned by digest, already in the daemon: nothing is resolved or pulled.
  assert.match(NODE_BASE, /^node:24-bookworm-slim@sha256:[0-9a-f]{64}$/, "ci.yml's test job names no digest-pinned CANDIDATE_NODE_BASE");
  await docker(["image", "inspect", "--format", "{{.Id}}", NODE_BASE], undefined, 30_000).catch((err: Error) => {
    throw new Error(`the candidate node base is not provisioned in this Docker daemon (ci.yml's test job pulls it): ${err.message}`);
  });
  // The service image: the Dockerfile's runtime stage contents (dist compiled from this checkout, contracts,
  // migrations and the installed dependencies) on that base, as its runtime user, with no `npm ci`.
  const app = join(scratch, "app-image");
  mkdirSync(app);
  // The production build, into an output directory of its own (tests/support/entrypoint-build.ts), never dist/.
  const build = await buildEntrypoints("candidate-dbrole");
  try {
    cpSync(build.outDir, join(app, "dist"), { recursive: true });
    // The build's directory is private (0700); the image's runtime user reads dist/ as it reads the Dockerfile's.
    chmodSync(join(app, "dist"), 0o755);
  } finally {
    build.remove();
  }
  for (const p of ["package.json", "package-lock.json", "node_modules", "contracts", join("db", "migrations")]) {
    cpSync(join(REPO_ROOT, p), join(app, p), { recursive: true, verbatimSymlinks: true });
  }
  writeFileSync(join(app, "Dockerfile"), `FROM ${NODE_BASE}\nENV NODE_ENV=production\nWORKDIR /app\nCOPY . .\nUSER node\nEXPOSE 8080\nCMD ["node", "dist/main.js"]\n`);
  await docker(["build", "--quiet", "--tag", IMAGE, app], undefined, 600_000);
  // The same image with one more migration, which only a superuser may apply.
  const ctx = join(scratch, "superuser-image");
  mkdirSync(ctx);
  writeFileSync(join(ctx, "9999_needs_superuser.sql"), "SET session_replication_role = replica;\n");
  writeFileSync(join(ctx, "Dockerfile"), `FROM ${IMAGE}\nCOPY 9999_needs_superuser.sql /app/db/migrations/\n`);
  await docker(["build", "--quiet", "--tag", SUPERUSER_IMAGE, ctx], undefined, 300_000);
}, { timeout: 900_000 });

after(async () => {
  // A deploy still running (its test timed out) owns its containers until it stops and is removed.
  await Promise.all(lifecycles);
  await docker(["image", "rm", "--force", IMAGE, SUPERUSER_IMAGE], undefined, 120_000);
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

test("candidate migrations and the API connect as the estate database owner role, which is not a superuser", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const name = `lc-candidate-dbrole-${run}`;
  await withCandidate(t, { image: IMAGE, name }, async (deploying) => {
    const out = await deploying;

    // The owner role is the one database.yaml bootstraps, and it holds no superuser, CREATEDB or CREATEROLE.
    assert.deepEqual(await sql(name, `SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = '${OWNER}'`), ["t|f|f|f"]);
    assert.deepEqual(await sql(name, `SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = '${DATABASE}'`), [OWNER]);
    // database.yaml's postInitSQL and postInitApplicationSQL ran: the service role and pgvector exist.
    assert.deepEqual(await sql(name, "SELECT rolcanlogin, rolsuper FROM pg_roles WHERE rolname = 'loopcloser_app'"), ["f|f"]);
    assert.deepEqual(await sql(name, "SELECT extname FROM pg_extension WHERE extname = 'vector'"), ["vector"]);

    // The migrations ran as the owner: every table they created, and the applied record, belong to it.
    const owners = await sql(name, "SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname = 'public'");
    assert.deepEqual(owners, [OWNER]);
    assert.ok((await sql(name, "SELECT count(*) FROM schema_migrations"))[0] !== "0", "no migration was applied");

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
      const blocked = await waitFor("no API session waited on the lock on public.loops", 30_000, t.signal, async () => {
        const rows = await sql(name, `SELECT usename FROM pg_stat_activity WHERE ${lock.pid} = ANY(pg_blocking_pids(pid))`, t.signal);
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
    assert.equal((await docker(["ps", "--all", "--quiet", "--filter", `name=^${name}-api$`], t.signal)).trim(), "");
    assert.deepEqual(await sql(name, "SELECT count(*) FROM schema_migrations WHERE version = '9999'"), ["0"]);
  });
});
