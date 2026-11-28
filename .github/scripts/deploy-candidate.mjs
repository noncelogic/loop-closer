#!/usr/bin/env node
// Deploys a loop-closer candidate (COND-342, owner INTENTS I67,
// DELIVERY-GUARANTEE-CHECK; delivery.yaml `deploy`). The deploy workflow builds
// the batch head's image and deploys it here before running the E2E suite and
// the journeys against it, then tears it down.
//
// The candidate runs the way the estate runs it, read from the manifests rather
// than restated. Its own Postgres (compose.yaml's image) is bootstrapped as
// deploy/base/database.yaml bootstraps the estate's (LC-DEPLOY-CANDIDATE-DB-ROLE):
// as the `postgres` bootstrap superuser, which only that bootstrap uses, it
// creates the initdb owner role (LOGIN, not a superuser, no CREATEDB or
// CREATEROLE, as CloudNativePG creates it) and the database it owns, then runs
// postInitSQL and postInitApplicationSQL. The schema Job's migrate command
// (deploy/overlays/aks-obs-01/schema-job.yaml) then applies the migrations as
// that owner role, so a migration needing superuser fails here as on the
// estate, and the API Deployment's container
// (deploy/base/deployment.yaml) serves, as the same owner role, with its command, port, literal env, user,
// read-only root, dropped capabilities and no privilege escalation, with the API
// keys and scopes mounted read-only where the Deployment mounts them. The keys
// are fresh random ones, one per principal (joe, and each scope file under
// deploy/base/api-scopes), written to a new directory for the journeys. Only the
// API is published, on 127.0.0.1 at a port docker picks. Nothing here reaches a
// cluster, a registry or a secret store.
//
//   node deploy-candidate.mjs up IMAGE NAME   deploy; prints CANDIDATE_URL and
//                                             CANDIDATE_KEYS_DIR (also to GITHUB_ENV)
//   node deploy-candidate.mjs down NAME       remove everything `up` created
// NAME is lc-candidate-<id>; containers, volumes and the network carry it.
// Checked by tests/delivery/deploy.test.ts.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const NAME = /^lc-candidate-[a-z0-9][a-z0-9_.-]*$/;
const OWNER = "joe";
const HEALTH_TIMEOUT_MS = 5_000;
/** The Postgres image's bootstrap superuser, as CloudNativePG's; only the bootstrap connects as it, over the socket. */
const SUPERUSER = "postgres";

/**
 * Every repository file and directory candidateShape reads to run the candidate. A pull request changing
 * one changes the candidate, so the deploy queue's dry run (deploy-dry-run.yml) runs on it.
 */
export const CANDIDATE_INPUTS = Object.freeze({
  compose: "compose.yaml",
  deployment: "deploy/base/deployment.yaml",
  schemaJob: "deploy/overlays/aks-obs-01/schema-job.yaml",
  scopes: "deploy/base/api-scopes",
  database: "deploy/base/database.yaml",
});

const MASK = "***";

/** A quoted SQL identifier and string literal, for the role, database and password the bootstrap names. */
const ident = (s) => `"${String(s).replace(/"/g, '""')}"`;
const literal = (s) => `'${String(s).replace(/'/g, "''")}'`;

/**
 * Masks credentials in text the deployer raises or prints: each given secret (the generated password and the
 * DATABASE_URL), the password of any URL's userinfo (postgres://user:***@host) and any *PASSWORD= env value.
 */
function redact(text, secrets = []) {
  let out = String(text);
  for (const s of secrets) if (s) out = out.split(s).join(MASK);
  return out
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+@/gi, `$1${MASK}@`)
    .replace(/(PASSWORD=)(?!\*\*\*(?:\s|$))\S+/gi, `$1${MASK}`);
}

/**
 * The docker CLI (`bin`, docker on PATH by default) as a Docker: resolves with stdout once the command has exited,
 * rejects on a non-zero exit unless `check` is false, with its credentials masked. It never blocks the event loop.
 * A command runs as long as it takes unless the caller gives `timeoutMs`, or a `signal` that aborts: then the
 * command is killed, and the promise rejects only once it has exited, naming the bound or the cancellation, even
 * when `check` is false.
 */
export function dockerCli({ timeoutMs, bin = "docker" } = {}) {
  return (args, { check = true, signal } = {}) =>
    new Promise((resolvePromise, reject) => {
      execFile(bin, args, {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        killSignal: "SIGKILL",
        ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
        ...(signal ? { signal } : {}),
      }, (err, stdout, stderr) => {
        if (!err) return resolvePromise(stdout);
        const line = `docker ${args.join(" ")}`;
        if (signal?.aborted) return reject(new Error(redact(`${line} was cancelled: ${signal.reason?.message ?? signal.reason}`)));
        if (err.killed && timeoutMs !== undefined) return reject(new Error(redact(`${line} failed: did not finish within ${timeoutMs} ms`)));
        if (!check) return resolvePromise("");
        reject(new Error(redact(`${line} failed: ${String(stderr || err.message).trim()}`)));
      });
    });
}

const realDocker = dockerCli();

function yamlAt(root, path) {
  return parse(readFileSync(join(root, path), "utf8"));
}

/** How a manifest's container runs, as docker run options: user, read-only root, capabilities, privilege escalation. */
function runOptions(podSpec, container) {
  const pod = podSpec.securityContext ?? {};
  const sc = container.securityContext ?? {};
  const user = sc.runAsUser ?? pod.runAsUser;
  const group = sc.runAsGroup ?? pod.runAsGroup;
  if (!Number.isInteger(user) || !Number.isInteger(group)) throw new Error(`container ${container.name} names no runAsUser and runAsGroup`);
  if (!Array.isArray(container.command) || container.command.length === 0) throw new Error(`container ${container.name} has no command`);
  const opts = ["--user", `${user}:${group}`];
  if (sc.readOnlyRootFilesystem === true) opts.push("--read-only");
  for (const cap of sc.capabilities?.drop ?? []) opts.push("--cap-drop", cap);
  if (sc.allowPrivilegeEscalation === false) opts.push("--security-opt", "no-new-privileges");
  return { opts, command: container.command };
}

/** The env a manifest's container sets literally; DATABASE_URL is the candidate's own, any other secret env is refused. */
function literalEnv(container) {
  const env = {};
  for (const e of container.env ?? []) {
    if (typeof e.value === "string") env[e.name] = e.value;
    else if (e.name !== "DATABASE_URL") throw new Error(`container ${container.name} reads ${e.name} from a source the candidate does not have`);
  }
  return env;
}

function containerOf(podSpec, name, file) {
  const c = (podSpec?.containers ?? []).find((x) => x.name === name);
  if (!c) throw new Error(`${file} has no ${name} container`);
  return c;
}

/** The candidate's shape, read from compose.yaml and the estate manifests. */
export function candidateShape(root = REPO_ROOT) {
  const compose = yamlAt(root, CANDIDATE_INPUTS.compose).services.postgres;
  const deployment = yamlAt(root, CANDIDATE_INPUTS.deployment);
  const job = yamlAt(root, CANDIDATE_INPUTS.schemaJob);
  // CloudNativePG bootstraps with initdb when the Cluster names no bootstrap method; initdb's database defaults
  // to `app` and its owner to the database's name (BootstrapInitDB, cloudnative-pg.v1).
  const bootstrap = yamlAt(root, CANDIDATE_INPUTS.database)?.spec?.bootstrap ?? {};
  const methods = Object.keys(bootstrap).filter((k) => k !== "initdb");
  if (!bootstrap.initdb && methods.length > 0) throw new Error(`database.yaml bootstraps by ${methods.join(", ")}, not initdb`);
  const initdb = bootstrap.initdb ?? {};
  const database = initdb.database ?? "app";
  const owner = initdb.owner ?? database;
  for (const [k, v] of [["database", database], ["owner", owner]]) if (typeof v !== "string" || !v) throw new Error(`database.yaml's initdb ${k} is not a name`);
  if (owner === SUPERUSER) throw new Error(`database.yaml's initdb owner is the ${SUPERUSER} superuser`);
  const sqlList = (k) => {
    const v = initdb[k] ?? [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new Error(`database.yaml initdb ${k} is not a list of statements`);
    return v;
  };

  const apiPod = deployment.spec.template.spec;
  const api = containerOf(apiPod, "api", "deployment.yaml");
  const mounts = {};
  for (const m of api.volumeMounts ?? []) mounts[m.name] = m.mountPath;
  for (const v of ["api-keys", "api-scopes"]) if (!mounts[v]) throw new Error(`the api container does not mount ${v}`);
  const port = api.ports?.[0]?.containerPort;
  if (!Number.isInteger(port)) throw new Error("the api container declares no port");

  const jobPod = job.spec.template.spec;
  const migrate = containerOf(jobPod, "migrate", "schema-job.yaml");
  literalEnv(migrate);

  return {
    db: {
      image: compose.image,
      superuser: SUPERUSER,
      owner,
      database,
      postInitSQL: sqlList("postInitSQL"),
      postInitApplicationSQL: sqlList("postInitApplicationSQL"),
    },
    migrate: runOptions(jobPod, migrate),
    api: { ...runOptions(apiPod, api), env: literalEnv(api), port, keysPath: mounts["api-keys"], scopesPath: mounts["api-scopes"] },
    scopesDir: join(root, CANDIDATE_INPUTS.scopes),
  };
}

/** The candidate's principals: joe, and every principal deploy/base/api-scopes grants scopes to. */
function principals(scopesDir) {
  const names = readdirSync(scopesDir).filter((n) => !n.startsWith(".") && statSync(join(scopesDir, n)).isFile());
  return [OWNER, ...names.filter((n) => n !== OWNER).sort()];
}

const defaultSleep = (ms, signal) => delay(ms, undefined, { signal });
const defaultRandom = () => randomBytes(24).toString("hex");

/**
 * Deploys IMAGE as candidate NAME: its own network and Postgres, the migrations, then the API.
 * Resolves with the API's URL and the directory holding each principal's key. Once `signal` aborts, or
 * `deadlineMs` (a bound on the whole deploy) has passed, the deploy kills the docker command in flight, runs no
 * further one, ends its wait or health probe and rejects; the caller then removes the candidate.
 */
export async function deployCandidate({
  image,
  name,
  docker = realDocker,
  fetch = globalThis.fetch,
  sleep = defaultSleep,
  random = defaultRandom,
  keysRoot = tmpdir(),
  root = REPO_ROOT,
  attempts = 60,
  intervalMs = 2_000,
  signal: callerSignal,
  deadlineMs,
}) {
  if (!image) throw new Error("no candidate image");
  if (!NAME.test(String(name ?? ""))) throw new Error(`candidate name ${JSON.stringify(name)} is not lc-candidate-<id>`);
  const shape = candidateShape(root);
  const db = `${name}-db`;
  // The owner's password reaches the migrations and the API; the superuser's reaches only the Postgres container.
  const password = random();
  const superPassword = random();
  const databaseUrl = `postgres://${shape.db.owner}:${password}@${db}:5432/${shape.db.database}`;
  // The deploy's own signal: the caller's, or the deadline's once it passes, whichever comes first.
  const stop = new AbortController();
  const onAbort = () => stop.abort(callerSignal.reason);
  if (callerSignal?.aborted) onAbort();
  else callerSignal?.addEventListener("abort", onAbort, { once: true });
  const deadline = deadlineMs === undefined ? undefined
    : setTimeout(() => stop.abort(new Error(`its deadline of ${deadlineMs} ms passed`)), deadlineMs);
  const signal = stop.signal;
  const cancelled = () => {
    if (signal.aborted) throw new Error(`the deploy of ${name} was cancelled: ${signal.reason?.message ?? signal.reason}`);
  };
  // Every docker command, wait and probe first checks the signal and is given it, so a cancelled deploy kills the
  // command in flight and stops there.
  const guardedDocker = async (args, opts) => {
    cancelled();
    try {
      return await docker(args, { ...opts, signal });
    } catch (err) {
      cancelled();
      throw err;
    }
  };
  const guardedSleep = async (ms) => {
    cancelled();
    try {
      await sleep(ms, signal);
    } catch (err) {
      cancelled();
      throw err;
    }
  };
  try {
    return await deploy({ image, name, docker: guardedDocker, fetch, sleep: guardedSleep, random, keysRoot, attempts, intervalMs, shape, db, password, superPassword, databaseUrl, signal, cancelled });
  } catch (err) {
    // Whatever docker or a log echoed, the candidate's database credentials never leave in an error.
    throw new Error(redact(err?.message ?? err, [password, superPassword, databaseUrl]));
  } finally {
    clearTimeout(deadline);
    callerSignal?.removeEventListener("abort", onAbort);
  }
}

/** psql as the bootstrap superuser over the container's socket, one statement per -c, stopping at the first error. */
async function psqlAsSuperuser(docker, db, shape, database, statements) {
  if (statements.length === 0) return;
  await docker(["exec", db, "psql", "-v", "ON_ERROR_STOP=1", "-U", shape.db.superuser, "-d", database, ...statements.flatMap((s) => ["-c", s])]);
}

async function deploy({ image, name, docker, fetch, sleep, random, keysRoot, attempts, intervalMs, shape, db, password, superPassword, databaseUrl, signal, cancelled }) {

  // Fresh keys, one per principal, readable by the API's user once copied in.
  const keysDir = mkdtempSync(join(keysRoot, "lc-candidate-keys-"));
  const who = principals(shape.scopesDir);
  for (const p of who) writeFileSync(join(keysDir, p), `${random()}\n`, { mode: 0o644 });

  await docker(["network", "create", name]);
  await docker(["create", "--name", db, "--network", name,
    "--env", `POSTGRES_USER=${shape.db.superuser}`, "--env", `POSTGRES_PASSWORD=${superPassword}`, "--env", `POSTGRES_DB=${shape.db.superuser}`,
    shape.db.image]);
  await docker(["start", db]);
  // -h 127.0.0.1: the initdb-phase server listens only on its socket (compose.yaml healthcheck).
  await until(attempts, intervalMs, sleep, cancelled, `Postgres of ${name} is not ready`, async () => {
    try {
      await docker(["exec", db, "pg_isready", "-h", "127.0.0.1", "-U", shape.db.superuser, "-d", shape.db.superuser]);
      return true;
    } catch {
      cancelled();
      return false;
    }
  });
  // database.yaml's initdb: the owner role and its database, then postInitSQL (in postgres) and
  // postInitApplicationSQL (in the application database), each run once by the superuser.
  await psqlAsSuperuser(docker, db, shape, shape.db.superuser, [
    `CREATE ROLE ${ident(shape.db.owner)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${literal(password)}`,
    `CREATE DATABASE ${ident(shape.db.database)} OWNER ${ident(shape.db.owner)}`,
    ...shape.db.postInitSQL,
  ]);
  await psqlAsSuperuser(docker, db, shape, shape.db.database, shape.db.postInitApplicationSQL);

  // The keys and scopes, in volumes the API mounts read-only (a read-only root cannot be copied into).
  await docker(["volume", "create", `${name}-keys`]);
  await docker(["volume", "create", `${name}-scopes`]);
  await docker(["create", "--name", `${name}-config`, "--volume", `${name}-keys:/keys`, "--volume", `${name}-scopes:/scopes`, image]);
  await docker(["cp", `${keysDir}/.`, `${name}-config:/keys/`]);
  await docker(["cp", `${shape.scopesDir}/.`, `${name}-config:/scopes/`]);
  await docker(["rm", `${name}-config`]);

  const [migrateEntry, ...migrateArgs] = shape.migrate.command;
  await docker(["run", "--rm", "--name", `${name}-migrate`, "--network", name, ...shape.migrate.opts,
    "--env", `DATABASE_URL=${databaseUrl}`, "--entrypoint", migrateEntry, image, ...migrateArgs]);

  const [apiEntry, ...apiArgs] = shape.api.command;
  const env = { ...shape.api.env, DATABASE_URL: databaseUrl };
  await docker(["run", "--detach", "--name", `${name}-api`, "--network", name, ...shape.api.opts,
    ...Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`]),
    "--volume", `${name}-keys:${shape.api.keysPath}:ro`, "--volume", `${name}-scopes:${shape.api.scopesPath}:ro`,
    "--publish", `127.0.0.1::${shape.api.port}`, "--entrypoint", apiEntry, image, ...apiArgs]);

  const published = (await docker(["port", `${name}-api`, `${shape.api.port}/tcp`])).trim().split("\n")[0] ?? "";
  const hostPort = Number(published.slice(published.lastIndexOf(":") + 1));
  if (!published.startsWith("127.0.0.1:") || !Number.isInteger(hostPort) || hostPort <= 0) {
    throw new Error(`the API of ${name} is not published on 127.0.0.1: ${JSON.stringify(published)}`);
  }
  const url = `http://127.0.0.1:${hostPort}`;
  try {
    await until(attempts, intervalMs, sleep, cancelled, `the API of ${name} never answered /healthz`, async () => {
      try {
        const probe = AbortSignal.timeout(HEALTH_TIMEOUT_MS);
        const res = await fetch(`${url}/healthz`, { signal: signal ? AbortSignal.any([probe, signal]) : probe });
        return res.ok && (await res.json())?.status === "ok";
      } catch {
        cancelled();
        return false;
      }
    });
  } catch (err) {
    cancelled();
    throw new Error(`${err.message}; its log:\n${await docker(["logs", `${name}-api`], { check: false })}`);
  }
  return { url, keysDir, principals: who };
}

async function until(attempts, intervalMs, sleep, cancelled, failure, ready) {
  for (let i = 0; i < attempts; i++) {
    cancelled();
    if (await ready()) return;
    cancelled();
    if (i < attempts - 1) await sleep(intervalMs);
  }
  throw new Error(`${failure} after ${attempts} attempts`);
}

/** The containers, volumes and network deployCandidate creates for NAME. */
function resourcesOf(name) {
  return {
    containers: [`${name}-api`, `${name}-migrate`, `${name}-config`, `${name}-db`],
    volumes: [`${name}-keys`, `${name}-scopes`],
    networks: [name],
  };
}

/** Which of NAME's containers, volumes and network docker still lists. */
export async function candidateLeftovers({ name, docker = realDocker }) {
  const mine = resourcesOf(name);
  // docker's name filter matches substrings, so only NAME's own resources are kept.
  const listed = async (kind, args, names) => {
    const out = await docker([...args, "--filter", `name=${name}`]);
    return out.split("\n").map((l) => l.trim()).filter((l) => names.includes(l)).map((l) => `${kind} ${l}`);
  };
  return [
    ...(await listed("container", ["ps", "--all", "--format", "{{.Names}}"], mine.containers)),
    ...(await listed("volume", ["volume", "ls", "--format", "{{.Name}}"], mine.volumes)),
    ...(await listed("network", ["network", "ls", "--format", "{{.Name}}"], mine.networks)),
  ];
}

/**
 * Removes everything deployCandidate created for NAME; what is already gone is skipped. Then reads back that none
 * of it is left: an operation the daemon was still finishing for a killed command (a container created after the
 * deploy stopped) is removed on the next round, and removal fails naming what is left after `attempts` rounds.
 */
export async function removeCandidate({ name, docker = realDocker, sleep = defaultSleep, attempts = 5, intervalMs = 1_000 }) {
  if (!NAME.test(String(name ?? ""))) throw new Error(`candidate name ${JSON.stringify(name)} is not lc-candidate-<id>`);
  const mine = resourcesOf(name);
  let left = [];
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(intervalMs);
    await docker(["rm", "--force", "--volumes", ...mine.containers], { check: false });
    await docker(["volume", "rm", "--force", ...mine.volumes], { check: false });
    await docker(["network", "rm", ...mine.networks], { check: false });
    left = await candidateLeftovers({ name, docker });
    if (left.length === 0) return;
  }
  throw new Error(`candidate ${name} still has ${left.join(", ")} after ${attempts} removals`);
}

async function main([cmd, ...args]) {
  if (cmd === "up" && args.length === 2) {
    const { url, keysDir } = await deployCandidate({ image: args[0], name: args[1], keysRoot: process.env.RUNNER_TEMP || tmpdir() });
    const lines = `CANDIDATE_URL=${url}\nCANDIDATE_KEYS_DIR=${keysDir}\n`;
    if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, lines);
    console.log(`candidate ${args[1]} (${args[0]}) serves at ${url}\n${lines.trimEnd()}`);
    return;
  }
  if (cmd === "down" && args.length === 1) {
    await removeCandidate({ name: args[0] });
    console.log(`candidate ${args[0]} removed`);
    return;
  }
  console.error("usage: deploy-candidate.mjs up IMAGE NAME | down NAME");
  process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.log(`::error::${redact(err?.message ?? err)}`);
    process.exitCode = 1;
  });
}
