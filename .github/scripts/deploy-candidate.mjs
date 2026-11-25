#!/usr/bin/env node
// Deploys a loop-closer candidate (COND-342, owner INTENTS I67,
// DELIVERY-GUARANTEE-CHECK; delivery.yaml `deploy`). The deploy workflow builds
// the batch head's image and deploys it here before running the E2E suite and
// the journeys against it, then tears it down.
//
// The candidate runs the way the estate runs it, read from the manifests rather
// than restated: the schema Job's migrate command
// (deploy/overlays/aks-obs-01/schema-job.yaml) applies the migrations to the
// candidate's own Postgres (compose.yaml's image, user and database, plus
// infra/postgres/initdb), then the API Deployment's container
// (deploy/base/deployment.yaml) serves with its command, port, literal env, user,
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
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const NAME = /^lc-candidate-[a-z0-9][a-z0-9_.-]*$/;
const OWNER = "joe";
const HEALTH_TIMEOUT_MS = 5_000;

/** Runs docker; returns stdout, throws on a non-zero exit unless `check` is false. */
function realDocker(args, { check = true } = {}) {
  try {
    return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    if (!check) return "";
    throw new Error(`docker ${args.join(" ")} failed: ${String(err.stderr ?? err.message).trim()}`);
  }
}

function yamlAt(root, ...parts) {
  return parse(readFileSync(join(root, ...parts), "utf8"));
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
  const compose = yamlAt(root, "compose.yaml").services.postgres;
  const deployment = yamlAt(root, "deploy", "base", "deployment.yaml");
  const job = yamlAt(root, "deploy", "overlays", "aks-obs-01", "schema-job.yaml");

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
      user: compose.environment.POSTGRES_USER,
      database: compose.environment.POSTGRES_DB,
      initdb: join(root, "infra", "postgres", "initdb"),
    },
    migrate: runOptions(jobPod, migrate),
    api: { ...runOptions(apiPod, api), env: literalEnv(api), port, keysPath: mounts["api-keys"], scopesPath: mounts["api-scopes"] },
    scopesDir: join(root, "deploy", "base", "api-scopes"),
  };
}

/** The candidate's principals: joe, and every principal deploy/base/api-scopes grants scopes to. */
function principals(scopesDir) {
  const names = readdirSync(scopesDir).filter((n) => !n.startsWith(".") && statSync(join(scopesDir, n)).isFile());
  return [OWNER, ...names.filter((n) => n !== OWNER).sort()];
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const defaultRandom = () => randomBytes(24).toString("hex");

/**
 * Deploys IMAGE as candidate NAME: its own network and Postgres, the migrations, then the API.
 * Resolves with the API's URL and the directory holding each principal's key.
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
}) {
  if (!image) throw new Error("no candidate image");
  if (!NAME.test(String(name ?? ""))) throw new Error(`candidate name ${JSON.stringify(name)} is not lc-candidate-<id>`);
  const shape = candidateShape(root);
  const db = `${name}-db`;
  const password = random();
  const databaseUrl = `postgres://${shape.db.user}:${password}@${db}:5432/${shape.db.database}`;

  // Fresh keys, one per principal, readable by the API's user once copied in.
  const keysDir = mkdtempSync(join(keysRoot, "lc-candidate-keys-"));
  const who = principals(shape.scopesDir);
  for (const p of who) writeFileSync(join(keysDir, p), `${random()}\n`, { mode: 0o644 });

  docker(["network", "create", name]);
  docker(["create", "--name", db, "--network", name,
    "--env", `POSTGRES_USER=${shape.db.user}`, "--env", `POSTGRES_PASSWORD=${password}`, "--env", `POSTGRES_DB=${shape.db.database}`,
    shape.db.image]);
  docker(["cp", `${shape.db.initdb}/.`, `${db}:/docker-entrypoint-initdb.d/`]);
  docker(["start", db]);
  // -h 127.0.0.1: the initdb-phase server listens only on its socket (compose.yaml healthcheck).
  await until(attempts, intervalMs, sleep, `Postgres of ${name} is not ready`, async () => {
    try {
      docker(["exec", db, "pg_isready", "-h", "127.0.0.1", "-U", shape.db.user, "-d", shape.db.database]);
      return true;
    } catch {
      return false;
    }
  });

  // The keys and scopes, in volumes the API mounts read-only (a read-only root cannot be copied into).
  docker(["volume", "create", `${name}-keys`]);
  docker(["volume", "create", `${name}-scopes`]);
  docker(["create", "--name", `${name}-config`, "--volume", `${name}-keys:/keys`, "--volume", `${name}-scopes:/scopes`, image]);
  docker(["cp", `${keysDir}/.`, `${name}-config:/keys/`]);
  docker(["cp", `${shape.scopesDir}/.`, `${name}-config:/scopes/`]);
  docker(["rm", `${name}-config`]);

  const [migrateEntry, ...migrateArgs] = shape.migrate.command;
  docker(["run", "--rm", "--name", `${name}-migrate`, "--network", name, ...shape.migrate.opts,
    "--env", `DATABASE_URL=${databaseUrl}`, "--entrypoint", migrateEntry, image, ...migrateArgs]);

  const [apiEntry, ...apiArgs] = shape.api.command;
  const env = { ...shape.api.env, DATABASE_URL: databaseUrl };
  docker(["run", "--detach", "--name", `${name}-api`, "--network", name, ...shape.api.opts,
    ...Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`]),
    "--volume", `${name}-keys:${shape.api.keysPath}:ro`, "--volume", `${name}-scopes:${shape.api.scopesPath}:ro`,
    "--publish", `127.0.0.1::${shape.api.port}`, "--entrypoint", apiEntry, image, ...apiArgs]);

  const published = docker(["port", `${name}-api`, `${shape.api.port}/tcp`]).trim().split("\n")[0] ?? "";
  const hostPort = Number(published.slice(published.lastIndexOf(":") + 1));
  if (!published.startsWith("127.0.0.1:") || !Number.isInteger(hostPort) || hostPort <= 0) {
    throw new Error(`the API of ${name} is not published on 127.0.0.1: ${JSON.stringify(published)}`);
  }
  const url = `http://127.0.0.1:${hostPort}`;
  try {
    await until(attempts, intervalMs, sleep, `the API of ${name} never answered /healthz`, async () => {
      try {
        const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
        return res.ok && (await res.json())?.status === "ok";
      } catch {
        return false;
      }
    });
  } catch (err) {
    throw new Error(`${err.message}; its log:\n${docker(["logs", `${name}-api`], { check: false })}`);
  }
  return { url, keysDir, principals: who };
}

async function until(attempts, intervalMs, sleep, failure, ready) {
  for (let i = 0; i < attempts; i++) {
    if (await ready()) return;
    if (i < attempts - 1) await sleep(intervalMs);
  }
  throw new Error(`${failure} after ${attempts} attempts`);
}

/** Removes everything deployCandidate created for NAME; what is already gone is skipped. */
export function removeCandidate({ name, docker = realDocker }) {
  if (!NAME.test(String(name ?? ""))) throw new Error(`candidate name ${JSON.stringify(name)} is not lc-candidate-<id>`);
  docker(["rm", "--force", "--volumes", `${name}-api`, `${name}-migrate`, `${name}-config`, `${name}-db`], { check: false });
  docker(["volume", "rm", "--force", `${name}-keys`, `${name}-scopes`], { check: false });
  docker(["network", "rm", name], { check: false });
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
    removeCandidate({ name: args[0] });
    console.log(`candidate ${args[0]} removed`);
    return;
  }
  console.error("usage: deploy-candidate.mjs up IMAGE NAME | down NAME");
  process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.log(`::error::${err.message}`);
    process.exitCode = 1;
  });
}
