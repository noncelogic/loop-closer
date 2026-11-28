// COND-342 acceptance (owner INTENTS I67, DELIVERY-GUARANTEE-CHECK; Rule:
// policies/placement-defaults.yaml#gates): loop-closer has a deploy workflow
// that is its deploy queue. Once per batch (tests/delivery/batch.test.ts) its
// deploy job builds the batch head's image, deploys that candidate, runs the
// E2E suite and the journeys against it, and always tears it down. delivery.yaml
// `deploy` names the workflow, the job and the journeys command; the journeys
// are their own selection (tests/journeys/**/*.journey.ts) that no per-merge
// workflow runs. A pull request that changes what either of the queue's jobs
// (`batch`, `deploy`) executes or reads runs both as a dry run
// (delivery.yaml `deploy.dry_run`): the same jobs and steps, on a candidate
// of its own that is always torn down. The deploy itself is exercised through
// .github/scripts/deploy-candidate.mjs with a strict fake docker and a fake
// /healthz: the candidate runs as deploy/base/deployment.yaml and the schema
// Job declare it. Nothing here reaches docker, GitHub or a cluster.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, constants as fsConstants, cpSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, matchesGlob } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parse, stringify } from "yaml";
import { CANDIDATE_INPUTS, deployCandidate, dockerCli, removeCandidate, type Docker, type SetTimer } from "../../.github/scripts/deploy-candidate.mjs";
import { repoRoot, runCommands, testSelection, words } from "./selection.ts";

type Obj = Record<string, any>;

function yamlFile(...parts: string[]): Obj {
  return parse(readFileSync(join(repoRoot, ...parts), "utf8")) as Obj;
}

const delivery = yamlFile("delivery.yaml");
const scripts = (JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as Obj)["scripts"] as Record<string, string>;
const repoFiles = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: repoRoot, encoding: "utf8" })
  .split("\0")
  .filter(Boolean);

test("delivery.yaml names the deploy workflow, its job and the journeys, and the queue's E2E runs in that job", () => {
  const d = delivery["deploy"] as Obj;
  assert.ok(d && typeof d === "object", "delivery.yaml has no deploy section");
  assert.equal(d["workflow"], ".github/workflows/deploy.yml");
  assert.equal(yamlFile(d["workflow"])["name"], "deploy");
  // The deploy queue's batch E2E is this job's: one job deploys the candidate and verifies it.
  assert.equal(delivery["e2e"]["workflow"], d["workflow"]);
  assert.equal(delivery["e2e"]["job"], d["job"]);
  assert.equal(typeof d["journeys"]?.["command"], "string");
});

test("the deploy job builds the batch head, deploys it, runs its E2E and journeys, and always tears it down", () => {
  const d = delivery["deploy"] as Obj;
  const job = (yamlFile(d["workflow"])["jobs"] as Obj)[d["job"]] as Obj;
  assert.ok(job, `no ${d["job"]} job`);
  const steps = job["steps"] as Obj[];
  const image = job["env"]?.["CANDIDATE_IMAGE"];
  assert.equal(image, "loopcloser:candidate-${{ github.sha }}", "the candidate is the batch head's image");
  assert.match(String(job["env"]?.["CANDIDATE_NAME"]), /^lc-candidate-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}$/);

  const at = (pred: (s: Obj) => boolean, what: string): number => {
    const i = steps.findIndex(pred);
    assert.ok(i >= 0, `the ${d["job"]} job has no step that ${what}`);
    return i;
  };
  const run = (s: Obj): string[] => (typeof s["run"] === "string" ? words(s["run"].trim()) : []);
  const build = at(
    (s) => String(s["uses"]).startsWith("docker/build-push-action@") && s["with"]?.["push"] === false &&
      s["with"]?.["load"] === true && s["with"]?.["tags"] === "${{ env.CANDIDATE_IMAGE }}",
    "builds the candidate image without pushing it",
  );
  const up = at((s) => run(s).join(" ") === "node .github/scripts/deploy-candidate.mjs up $CANDIDATE_IMAGE $CANDIDATE_NAME", "deploys the candidate");
  const e2e = at((s) => s["run"]?.trim() === delivery["e2e"]["command"], "runs the E2E suite");
  const journeys = at((s) => s["run"]?.trim() === d["journeys"]["command"], "runs the journeys");
  const down = at((s) => run(s).join(" ") === "node .github/scripts/deploy-candidate.mjs down $CANDIDATE_NAME", "tears the candidate down");
  assert.ok(build < up && up < e2e && e2e < journeys && journeys < down, "build, deploy, E2E, journeys, teardown in that order");
  // The E2E suite boots its Postgres replica with `docker compose` (tests/schema/replica.ts,
  // tests/foundation/local-replica.e2e.ts), so the job provisions the Compose plugin before it runs.
  const compose = at((s) => String(s["uses"]).startsWith("docker/setup-compose-action@"), "provisions the Docker Compose plugin");
  assert.ok(compose < e2e, "Compose is provisioned before the E2E suite runs");
  assert.equal(down, steps.length - 1, "teardown is the last step");
  assert.match(String(steps[down]!["if"]), /^\$\{\{\s*always\(\)\s*\}\}$|^always\(\)$/, "teardown runs even when a check failed");
  assert.deepEqual(job["permissions"], { contents: "read" }, "the deploy job reads the repository and nothing else");
});

test("the journeys are their own selection, run only by the deploy job", () => {
  const repoJourneys = repoFiles.filter((f) => f.endsWith(".journey.ts")).sort();
  assert.ok(repoJourneys.length > 0, "the repository has no journey");
  assert.deepEqual(testSelection(delivery["deploy"]["journeys"]["command"], scripts), repoJourneys, "the journeys command selects every journey and only those");
  assert.deepEqual(testSelection("npm test", scripts).filter((f) => f.endsWith(".journey.ts")), [], "npm test selects a journey");

  for (const f of readdirSync(join(repoRoot, ".github", "workflows"))) {
    for (const { job, run } of runCommands(yamlFile(".github", "workflows", f))) {
      const ran = testSelection(run, scripts).filter((x) => repoJourneys.includes(x));
      const deployJob = job === delivery["deploy"]["job"];
      if (deployJob && [delivery["deploy"]["workflow"], delivery["deploy"]["dry_run"]?.["workflow"]].includes(`.github/workflows/${f}`)) continue;
      assert.deepEqual(ran, [], `${f} job ${job} runs journeys without a deployed candidate`);
    }
  }
});

const NAME = "lc-candidate-42-1";
const IMAGE = "loopcloser:candidate-abc";
const PW = "pw0";
const SUPER_PW = "superpw1";
const DB_URL = `postgres://loopcloser:${PW}@${NAME}-db:5432/loopcloser`;

/**
 * A fake docker that answers only the calls a candidate deploy and its removal make and throws on any other.
 * `pgReadyAfter` failed readiness probes come first. Listings answer with `listed(kind)` (nothing by default): the
 * container, volume and network names docker would still show.
 */
function fakeDocker(
  calls: string[][],
  opts: { pgReadyAfter?: number; port?: string; listed?: (kind: "ps" | "volume" | "network") => string[] } = {},
): Docker {
  let probes = 0;
  return async (args, o) => {
    calls.push(o?.check === false ? [...args, "#nocheck"] : args);
    const [cmd, sub] = args;
    const listing = (kind: "ps" | "volume" | "network"): string => `${(opts.listed?.(kind) ?? []).map((n) => `${n}\n`).join("")}`;
    if (cmd === "exec" && args.includes("pg_isready")) {
      if (probes++ < (opts.pgReadyAfter ?? 0)) throw new Error("no response");
      return "127.0.0.1:5432 - accepting connections\n";
    }
    if (cmd === "exec" && args[2] === "psql" && args.includes("ON_ERROR_STOP=1")) return "";
    if (cmd === "port") return `${opts.port ?? "127.0.0.1:49153"}\n`;
    if (cmd === "logs") return "api log line\n";
    if (cmd === "ps" && args.join(" ") === `ps --all --format {{.Names}} --filter name=${filteredName(args)}`) return listing("ps");
    if ((cmd === "volume" || cmd === "network") && sub === "ls" && args.join(" ") === `${cmd} ls --format {{.Name}} --filter name=${filteredName(args)}`) return listing(cmd);
    if (cmd === "network" && (sub === "create" || sub === "rm")) return "";
    if (cmd === "volume" && (sub === "create" || sub === "rm")) return "";
    if (["create", "cp", "start", "run", "rm"].includes(cmd!)) return "";
    throw new Error(`unexpected docker call: ${args.join(" ")}`);
  };
}

/** The candidate a listing filters on: the value of its trailing `--filter name=<candidate>`. */
function filteredName(args: string[]): string {
  const filter = args.at(-1) ?? "";
  assert.equal(args.at(-2), "--filter", `a listing without a name filter: ${args.join(" ")}`);
  assert.match(filter, /^name=lc-candidate-/, `a listing filtered on something other than a candidate: ${filter}`);
  return filter.slice("name=".length);
}

/** The listing calls removeCandidate reads back after removing NAME. */
const listings = (name: string): string[][] => [
  ["ps", "--all", "--format", "{{.Names}}", "--filter", `name=${name}`],
  ["volume", "ls", "--format", "{{.Name}}", "--filter", `name=${name}`],
  ["network", "ls", "--format", "{{.Name}}", "--filter", `name=${name}`],
];

/** A fake API that answers only the candidate's /healthz, failing `failures` times first. */
function fakeApi(url: string, seen: string[], failures = 0) {
  let n = 0;
  return async (u: string | URL): Promise<Response> => {
    seen.push(String(u));
    if (String(u) !== `${url}/healthz`) throw new Error(`unexpected request ${String(u)}`);
    if (n++ < failures) throw new Error("connection refused");
    return new Response(JSON.stringify({ service: "loopcloser", status: "ok" }), { status: 200 });
  };
}

const noSleep = async (): Promise<void> => {};

test("a candidate is deployed as the estate runs it: Postgres, the schema Job's migrate, then the API Deployment", async () => {
  const keysRoot = mkdtempSync(join(tmpdir(), "lc-deploy-test-"));
  try {
    const calls: string[][] = [];
    const seen: string[] = [];
    let n = 0;
    const out = await deployCandidate({
      image: IMAGE,
      name: NAME,
      docker: fakeDocker(calls, { pgReadyAfter: 2 }),
      fetch: fakeApi("http://127.0.0.1:49153", seen, 1),
      sleep: noSleep,
      random: () => [PW, SUPER_PW][n++] ?? `key${n}`,
      keysRoot,
    });
    assert.equal(out.url, "http://127.0.0.1:49153");
    assert.deepEqual(out.principals, ["joe", "hermes"]);
    // Each principal gets its own fresh key, in a new directory under keysRoot.
    assert.equal(basename(join(out.keysDir, "..")), basename(keysRoot));
    assert.deepEqual(readdirSync(out.keysDir).sort(), ["hermes", "joe"]);
    assert.equal(readFileSync(join(out.keysDir, "joe"), "utf8"), "key3\n");
    assert.equal(readFileSync(join(out.keysDir, "hermes"), "utf8"), "key4\n");
    assert.deepEqual(seen, ["http://127.0.0.1:49153/healthz", "http://127.0.0.1:49153/healthz"]);

    // The bootstrap superuser only probes and bootstraps, over the socket; database.yaml's initdb owner role,
    // not a superuser, owns the database, and the migrations and the API connect as it.
    const probe = ["exec", `${NAME}-db`, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "postgres"];
    const psql = (db: string) => ["exec", `${NAME}-db`, "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", db];
    const hardened = ["--user", "1000:1000", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges"];
    assert.deepEqual(calls, [
      ["network", "create", NAME],
      ["create", "--name", `${NAME}-db`, "--network", NAME,
        "--env", "POSTGRES_USER=postgres", "--env", `POSTGRES_PASSWORD=${SUPER_PW}`, "--env", "POSTGRES_DB=postgres", "pgvector/pgvector:pg17"],
      ["start", `${NAME}-db`],
      probe, probe, probe,
      [...psql("postgres"),
        "-c", `CREATE ROLE "loopcloser" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${PW}'`,
        "-c", `CREATE DATABASE "loopcloser" OWNER "loopcloser"`,
        "-c", "CREATE ROLE loopcloser_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;"],
      [...psql("loopcloser"), "-c", "CREATE EXTENSION IF NOT EXISTS vector;"],
      ["volume", "create", `${NAME}-keys`],
      ["volume", "create", `${NAME}-scopes`],
      ["create", "--name", `${NAME}-config`, "--volume", `${NAME}-keys:/keys`, "--volume", `${NAME}-scopes:/scopes`, IMAGE],
      ["cp", `${out.keysDir}/.`, `${NAME}-config:/keys/`],
      ["cp", `${join(repoRoot, "deploy", "base", "api-scopes")}/.`, `${NAME}-config:/scopes/`],
      ["rm", `${NAME}-config`],
      ["create", "--rm", "--name", `${NAME}-migrate`, "--network", NAME, ...hardened,
        "--env", `DATABASE_URL=${DB_URL}`, "--entrypoint", "node", IMAGE, "dist/migrate.js"],
      ["start", "--attach", `${NAME}-migrate`],
      ["create", "--name", `${NAME}-api`, "--network", NAME, ...hardened,
        "--env", "PORT=8080", "--env", `DATABASE_URL=${DB_URL}`,
        "--volume", `${NAME}-keys:/etc/loopcloser/api-keys:ro`, "--volume", `${NAME}-scopes:/etc/loopcloser/api-scopes:ro`,
        "--publish", "127.0.0.1::8080", "--entrypoint", "node", IMAGE, "dist/main.js"],
      ["start", `${NAME}-api`],
      ["port", `${NAME}-api`, "8080/tcp"],
    ]);
  } finally {
    rmSync(keysRoot, { recursive: true, force: true });
  }
});

test("a candidate whose API never turns healthy fails with the API's log", async () => {
  const keysRoot = mkdtempSync(join(tmpdir(), "lc-deploy-test-"));
  try {
    const calls: string[][] = [];
    const seen: string[] = [];
    await assert.rejects(
      deployCandidate({ image: IMAGE, name: NAME, docker: fakeDocker(calls), fetch: fakeApi("http://127.0.0.1:49153", seen, 99), sleep: noSleep, keysRoot, attempts: 3 }),
      /never answered \/healthz after 3 attempts; its log:\napi log line/,
    );
    assert.equal(seen.length, 3);
    assert.deepEqual(calls.at(-1), ["logs", `${NAME}-api`, "#nocheck"]);
  } finally {
    rmSync(keysRoot, { recursive: true, force: true });
  }
});

test("a candidate whose Postgres never comes up, or whose API is not published on loopback, fails", async () => {
  const keysRoot = mkdtempSync(join(tmpdir(), "lc-deploy-test-"));
  try {
    const none = async (u: string | URL): Promise<Response> => {
      throw new Error(`unexpected request ${String(u)}`);
    };
    await assert.rejects(
      deployCandidate({ image: IMAGE, name: NAME, docker: fakeDocker([], { pgReadyAfter: 99 }), fetch: none, sleep: noSleep, keysRoot, attempts: 4 }),
      /Postgres of lc-candidate-42-1 is not ready after 4 attempts/,
    );
    await assert.rejects(
      deployCandidate({ image: IMAGE, name: NAME, docker: fakeDocker([], { port: "0.0.0.0:49153" }), fetch: none, sleep: noSleep, keysRoot }),
      /not published on 127\.0\.0\.1/,
    );
    await assert.rejects(deployCandidate({ image: IMAGE, name: "prod", docker: fakeDocker([]), fetch: none, keysRoot }), /not lc-candidate-<id>/);
    await assert.rejects(deployCandidate({ image: "", name: NAME, docker: fakeDocker([]), fetch: none, keysRoot }), /no candidate image/);
  } finally {
    rmSync(keysRoot, { recursive: true, force: true });
  }
});

test("a cancelled deploy stops: no docker command after the abort, its Postgres wait and health probe end, and it rejects", { timeout: 10_000 }, async () => {
  const keysRoot = mkdtempSync(join(tmpdir(), "lc-deploy-test-"));
  try {
    /** Rejects once `signal` aborts, as a real wait or request does; never resolves on its own. */
    const untilAborted = (signal: AbortSignal | null | undefined, what: string): Promise<never> =>
      new Promise((_, reject) => {
        if (!signal) return; // a wait or probe that cannot be cancelled hangs, and the test times out
        if (signal.aborted) return reject(new Error(`${what} aborted`));
        signal.addEventListener("abort", () => reject(new Error(`${what} aborted`)), { once: true });
      });

    /**
     * Aborts `caller` with `reason` and reports what the deploy's wait or probe signal shows at that same moment,
     * synchronously, before any timer (the probe's own five-second timeout included) could have run: the reason
     * it was aborted with, or undefined if the caller's abort did not reach it.
     */
    const abortAndObserve = (caller: AbortController, reason: Error, signal: AbortSignal | null | undefined): unknown => {
      assert.ok(signal && !signal.aborted, "the wait or probe started without a live signal");
      caller.abort(reason);
      return signal.aborted ? signal.reason : undefined;
    };

    // Cancelled while it waits for Postgres: the caller's abort ends the wait and no further docker command runs.
    const waiting = new AbortController();
    const waitReason = new Error("test cancelled");
    const pgCalls: string[][] = [];
    let atAbort = -1;
    let sleepSaw: unknown = "the wait never ran";
    const none = async (u: string | URL): Promise<Response> => {
      throw new Error(`unexpected request ${String(u)}`);
    };
    await assert.rejects(
      deployCandidate({
        image: IMAGE, name: NAME, docker: fakeDocker(pgCalls, { pgReadyAfter: 99 }), fetch: none, keysRoot, attempts: 90,
        sleep: (_ms, signal) => {
          atAbort = pgCalls.length;
          sleepSaw = abortAndObserve(waiting, waitReason, signal);
          return untilAborted(signal, "sleep");
        },
        signal: waiting.signal,
      }),
      /the deploy of lc-candidate-42-1 was cancelled: test cancelled/,
    );
    assert.equal(sleepSaw, waitReason, "the caller's abort did not reach the Postgres wait's signal");
    assert.equal(pgCalls.length, atAbort, "a docker command ran after the deploy was cancelled");

    // Cancelled while a /healthz probe is in flight: the caller's abort, not the probe's timeout, aborts the probe's
    // signal the moment it happens; the probe ends and the deploy does not fetch the API's log.
    const probing = new AbortController();
    const probeReason = new Error("test cancelled");
    const calls: string[][] = [];
    const seen: string[] = [];
    let probeSaw: unknown = "the probe never ran";
    await assert.rejects(
      deployCandidate({
        image: IMAGE, name: NAME, docker: fakeDocker(calls), sleep: noSleep, keysRoot, attempts: 90,
        fetch: (u, init) => {
          seen.push(String(u));
          if (String(u) !== "http://127.0.0.1:49153/healthz") throw new Error(`unexpected request ${String(u)}`);
          atAbort = calls.length;
          probeSaw = abortAndObserve(probing, probeReason, init?.signal);
          return untilAborted(init?.signal, "probe");
        },
        signal: probing.signal,
      }),
      /was cancelled: test cancelled/,
    );
    assert.equal(probeSaw, probeReason, "the caller's abort did not reach the health probe's signal");
    assert.deepEqual(seen, ["http://127.0.0.1:49153/healthz"]);
    assert.equal(calls.length, atAbort, "a docker command ran after the deploy was cancelled");

    // Cancelled before it starts: nothing is created.
    const early: string[][] = [];
    await assert.rejects(
      deployCandidate({ image: IMAGE, name: NAME, docker: fakeDocker(early), fetch: none, sleep: noSleep, keysRoot, signal: AbortSignal.abort(new Error("gone")) }),
      /was cancelled: gone/,
    );
    assert.deepEqual(early, []);
  } finally {
    rmSync(keysRoot, { recursive: true, force: true });
  }
});

test("the candidate follows the manifests: a Deployment env the candidate cannot supply is refused, a new literal env is passed", async () => {
  const root = mkdtempSync(join(tmpdir(), "lc-deploy-root-"));
  try {
    for (const p of ["compose.yaml", "infra", "deploy"]) cpSync(join(repoRoot, p), join(root, p), { recursive: true });
    const path = join(root, "deploy", "base", "deployment.yaml");
    const dep = parse(readFileSync(path, "utf8")) as Obj;
    const api = (dep["spec"]["template"]["spec"]["containers"] as Obj[]).find((c) => c["name"] === "api")!;
    api["env"].push({ name: "LOG_LEVEL", value: "debug" });
    writeFileSync(path, stringify(dep));
    const calls: string[][] = [];
    await deployCandidate({ image: IMAGE, name: NAME, docker: fakeDocker(calls), fetch: fakeApi("http://127.0.0.1:49153", []), sleep: noSleep, keysRoot: root, root });
    const apiRun = calls.find((c) => c[0] === "create" && c.includes(`${NAME}-api`))!;
    assert.ok(apiRun.includes("LOG_LEVEL=debug"), "a literal env of the Deployment reaches the candidate");

    api["env"].push({ name: "MAIL_TOKEN", valueFrom: { secretKeyRef: { name: "mail", key: "token" } } });
    writeFileSync(path, stringify(dep));
    await assert.rejects(
      deployCandidate({ image: IMAGE, name: NAME, docker: fakeDocker([]), fetch: fakeApi("http://127.0.0.1:49153", []), sleep: noSleep, keysRoot: root, root }),
      /reads MAIL_TOKEN from a source the candidate does not have/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the candidate bootstraps with CloudNativePG's initdb defaults when database.yaml leaves the database or owner unnamed", async () => {
  const root = mkdtempSync(join(tmpdir(), "lc-deploy-root-"));
  try {
    for (const p of ["compose.yaml", "deploy"]) cpSync(join(repoRoot, p), join(root, p), { recursive: true });
    const path = join(root, CANDIDATE_INPUTS.database);
    const cluster = parse(readFileSync(path, "utf8")) as Obj;
    /** Deploys with database.yaml's bootstrap set to `bootstrap` (omitted when undefined); returns the docker calls. */
    const deployWith = async (bootstrap: Obj | undefined): Promise<string[][]> => {
      const spec = { ...cluster["spec"] };
      if (bootstrap === undefined) delete spec["bootstrap"];
      else spec["bootstrap"] = bootstrap;
      writeFileSync(path, stringify({ ...cluster, spec }));
      const calls: string[][] = [];
      let n = 0;
      await deployCandidate({
        image: IMAGE, name: NAME, docker: fakeDocker(calls), fetch: fakeApi("http://127.0.0.1:49153", []), sleep: noSleep,
        random: () => [PW, SUPER_PW][n++] ?? `key${n}`, keysRoot: root, root,
      });
      return calls;
    };
    const psqlCalls = (calls: string[][]): string[][] => calls.filter((c) => c[0] === "exec" && c[2] === "psql");
    const migrateUrl = (calls: string[][]): string | undefined =>
      calls.find((c) => c[0] === "create" && c.includes(`${NAME}-migrate`))?.find((a) => a.startsWith("DATABASE_URL="));
    const bootstrapOf = (db: string, owner: string, ...post: string[]): string[] => [
      "exec", `${NAME}-db`, "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres",
      "-c", `CREATE ROLE "${owner}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${PW}'`,
      "-c", `CREATE DATABASE "${db}" OWNER "${owner}"`, ...post.flatMap((q) => ["-c", q]),
    ];

    // initdb with neither name: the database is `app`, owned by `app`.
    const postInit = cluster["spec"]["bootstrap"]["initdb"]["postInitSQL"] as string[];
    let calls = await deployWith({ initdb: { postInitSQL: postInit } });
    assert.deepEqual(psqlCalls(calls), [bootstrapOf("app", "app", ...postInit)]);
    assert.equal(migrateUrl(calls), `DATABASE_URL=postgres://app:${PW}@${NAME}-db:5432/app`);

    // A database without an owner: the owner is the database's name.
    calls = await deployWith({ initdb: { database: "records" } });
    assert.deepEqual(psqlCalls(calls), [bootstrapOf("records", "records")]);
    assert.equal(migrateUrl(calls), `DATABASE_URL=postgres://records:${PW}@${NAME}-db:5432/records`);

    // An owner without a database: the database is `app`, owned by that owner.
    calls = await deployWith({ initdb: { owner: "keeper" } });
    assert.deepEqual(psqlCalls(calls), [bootstrapOf("app", "keeper")]);
    assert.equal(migrateUrl(calls), `DATABASE_URL=postgres://keeper:${PW}@${NAME}-db:5432/app`);

    // No bootstrap section: CloudNativePG bootstraps with initdb and its defaults.
    calls = await deployWith(undefined);
    assert.deepEqual(psqlCalls(calls), [bootstrapOf("app", "app")]);

    // A bootstrap the candidate cannot reproduce, or the superuser as owner, is refused before anything runs.
    await assert.rejects(deployWith({ recovery: { source: "elsewhere" } }), /bootstraps by recovery, not initdb/);
    await assert.rejects(deployWith({ initdb: { owner: "postgres" } }), /initdb owner is the postgres superuser/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A fake docker executable whose calls matching the shell pattern `blocks` are one process from start to exit: it
 * records its pid in `pidFile`, then replaces its shell with `cat` reading the FIFO `gate`, so it stays blocked
 * until the test releases it (writes its output and closes the FIFO) or it is killed. Any other call exits 0 at once.
 */
function blockedDocker(dir: string, blocks = "*"): { bin: string; gate: string; pidFile: string } {
  const gate = join(dir, "gate");
  execFileSync("mkfifo", [gate]);
  const pidFile = join(dir, "pid");
  const bin = join(dir, "docker");
  writeFileSync(bin, `#!/bin/sh\ncase "$1" in\n  ${blocks}) echo $$ > ${JSON.stringify(pidFile)}; exec cat ${JSON.stringify(gate)} ;;\nesac\nexit 0\n`, { mode: 0o755 });
  return { bin, gate, pidFile };
}

/** The FIFO open for writing once its reader (the blocked fake) has it open, or undefined while it has none. */
function writerOf(gate: string): number | undefined {
  try {
    return openSync(gate, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENXIO") return undefined;
    throw err;
  }
}

/**
 * The readiness handshake: waits, up to `deadlineMs`, until the fake is blocked on its gate, and returns the gate's
 * writing end, which the caller holds open (no EOF reaches the fake) until the operation has settled, and the
 * fake's pid.
 */
async function blocked(fake: { gate: string; pidFile: string }, deadlineMs = 10_000): Promise<{ fd: number; pid: number }> {
  const until = Date.now() + deadlineMs;
  for (;;) {
    const fd = writerOf(fake.gate);
    if (fd !== undefined) return { fd, pid: Number(readFileSync(fake.pidFile, "utf8").trim()) };
    assert.ok(Date.now() < until, `the fake docker never blocked on its gate within ${deadlineMs} ms`);
    await delay(10);
  }
}

/**
 * Asserts the fake has exited and been reaped, at the moment this runs: no process has its pid. A killed process
 * that has not yet been reaped (its exit not yet seen) still has one.
 */
function assertExited(pid: number, what: string): void {
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
    alive = false;
  }
  assert.equal(alive, false, `${what}: the fake docker (pid ${pid}) has not exited`);
}

/** A timer the test fires itself: it records each timer armed, and `fire` runs those still armed. */
function manualTimer(): { setTimer: SetTimer; armed: number[]; fire: () => void } {
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  return {
    setTimer: (fn, ms) => {
      const t = { fn, ms, live: true };
      timers.push(t);
      return () => void (t.live = false);
    },
    get armed() {
      return timers.filter((t) => t.live).map((t) => t.ms);
    },
    fire: () => {
      for (const t of timers.filter((x) => x.live)) {
        t.live = false;
        t.fn();
      }
    },
  };
}

test("a docker command runs until it finishes unless its caller bounds it: only a given timeoutMs kills it, named in the failure", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "lc-deploy-timeout-"));
  try {
    // The deployer's docker (what `deploy-candidate.mjs up` deploys with) arms no bound and runs a command until it
    // exits: blocked, the fake is released and its output returned.
    const unboundedDir = join(dir, "unbounded");
    mkdirSync(unboundedDir);
    const unbounded = blockedDocker(unboundedDir);
    const unboundedTimer = manualTimer();
    const running = dockerCli({ bin: unbounded.bin, setTimer: unboundedTimer.setTimer })(["run", "migrate"]);
    const { fd } = await blocked(unbounded);
    assert.deepEqual(unboundedTimer.armed, [], "the deployer's docker armed a bound");
    writeSync(fd, "ran migrate\n");
    closeSync(fd);
    assert.equal(await running, "ran migrate\n", "the deployer's docker cut a command short");

    // A caller-bounded docker kills the command, blocked and never released, once its bound passes, and rejects
    // only after the command has exited. The bound passes only after the fake is known to be blocked.
    const boundedDir = join(dir, "bounded");
    mkdirSync(boundedDir);
    const bounded = blockedDocker(boundedDir);
    const timer = manualTimer();
    const timed = dockerCli({ bin: bounded.bin, timeoutMs: 300, setTimer: timer.setTimer })(["run", "migrate"]);
    const gate = await blocked(bounded);
    try {
      assert.deepEqual(timer.armed, [300]);
      timer.fire();
      await assert.rejects(timed, (err: Error) => {
        assertExited(gate.pid, "when the bounded command rejected");
        assert.equal(err.message, "docker run migrate failed: did not finish within 300 ms");
        return true;
      });
    } finally {
      closeSync(gate.fd);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a docker command is killed once its signal aborts, and rejects naming the cancellation only after it has exited", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "lc-deploy-cancel-"));
  try {
    const fake = blockedDocker(dir);
    const caller = new AbortController();
    // check: false tolerates a failed command, never a cancelled one.
    const running = dockerCli({ bin: fake.bin })(["rm", "--force", "x"], { check: false, signal: caller.signal });
    const gate = await blocked(fake);
    try {
      // The gate stays open: the fake gets no EOF and ends only by being killed.
      caller.abort(new Error("test cancelled"));
      await assert.rejects(running, (err: Error) => {
        assertExited(gate.pid, "when the cancelled command rejected");
        assert.equal(err.message, "docker rm --force x was cancelled: test cancelled");
        return true;
      });
    } finally {
      closeSync(gate.fd);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a deploy cancelled, or past its deadline, while a docker wait runs kills that command and rejects once it has exited", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "lc-deploy-inflight-"));
  try {
    const none = async (u: string | URL): Promise<Response> => {
      throw new Error(`unexpected request ${String(u)}`);
    };
    // The deploy's first wait (Postgres's readiness probe) blocks; the caller cancels while it runs.
    const cancelDir = join(dir, "cancel");
    mkdirSync(cancelDir);
    const cancelFake = blockedDocker(cancelDir, "exec");
    const caller = new AbortController();
    const cancelled = deployCandidate({
      image: IMAGE, name: NAME, docker: dockerCli({ bin: cancelFake.bin }), fetch: none, sleep: noSleep, keysRoot: cancelDir, signal: caller.signal,
    });
    const probe = await blocked(cancelFake);
    try {
      caller.abort(new Error("test cancelled"));
      await assert.rejects(cancelled, (err: Error) => {
        assertExited(probe.pid, "when the cancelled deploy rejected");
        assert.equal(err.message, "the deploy of lc-candidate-42-1 was cancelled: test cancelled");
        return true;
      });
    } finally {
      closeSync(probe.fd);
    }

    // Nobody cancels: the deploy's own deadline, passing once the probe is blocked, ends the command.
    const deadlineDir = join(dir, "deadline");
    mkdirSync(deadlineDir);
    const deadlineFake = blockedDocker(deadlineDir, "exec");
    const timer = manualTimer();
    const late = deployCandidate({
      image: IMAGE, name: NAME, docker: dockerCli({ bin: deadlineFake.bin }), fetch: none, sleep: noSleep, keysRoot: deadlineDir, deadlineMs: 300, setTimer: timer.setTimer,
    });
    const lateProbe = await blocked(deadlineFake);
    try {
      assert.deepEqual(timer.armed, [300]);
      timer.fire();
      await assert.rejects(late, (err: Error) => {
        assertExited(lateProbe.pid, "when the deploy past its deadline rejected");
        assert.equal(err.message, "the deploy of lc-candidate-42-1 was cancelled: its deadline of 300 ms passed");
        return true;
      });
      assert.deepEqual(timer.armed, [], "the deploy left its deadline armed");
    } finally {
      closeSync(lateProbe.fd);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a deploy cancelled while the daemon creates a container settles once the create is done, so the removal after it removes the container", async () => {
  const keysRoot = mkdtempSync(join(tmpdir(), "lc-deploy-test-"));
  try {
    const none = async (u: string | URL): Promise<Response> => {
      throw new Error(`unexpected request ${String(u)}`);
    };
    // A daemon that completes the Postgres container's create on its own schedule. Its CLI waits for the daemon's
    // answer; a CLI killed by a signal returns at once, while the daemon still completes the create.
    const held = new Set<string>();
    const order: string[] = [];
    let complete = (): void => assert.fail("no create was requested");
    let requested = (): void => {};
    const createRequested = new Promise<void>((r) => (requested = r));
    const docker: Docker = async (args, o) => {
      const line = args.join(" ");
      if (line === `network create ${NAME}`) return "";
      if (args[0] === "create" && args[2] === `${NAME}-db`) {
        order.push("create requested");
        const done = new Promise<string>((r) => (complete = () => {
          held.add(`${NAME}-db`);
          order.push("create completed");
          r("");
        }));
        requested();
        const signal = o?.signal;
        if (!signal) return done;
        return Promise.race([done, new Promise<string>((_, reject) => signal.addEventListener("abort", () => reject(new Error("killed")), { once: true }))]);
      }
      if (args[0] === "rm" && args[1] === "--force") {
        for (const n of args.slice(3)) held.delete(n);
        order.push("removed");
        return "";
      }
      if (line === `volume rm --force ${NAME}-keys ${NAME}-scopes` || line === `network rm ${NAME}`) return "";
      if (line === `ps --all --format {{.Names}} --filter name=${NAME}`) {
        order.push(`listed ${held.size}`);
        return [...held].map((n) => `${n}\n`).join("");
      }
      if (line === `volume ls --format {{.Name}} --filter name=${NAME}` || line === `network ls --format {{.Name}} --filter name=${NAME}`) return "";
      throw new Error(`unexpected docker call: ${line}`);
    };
    const caller = new AbortController();
    const deploying = deployCandidate({ image: IMAGE, name: NAME, docker, fetch: none, sleep: noSleep, keysRoot, signal: caller.signal });
    await createRequested;
    caller.abort(new Error("test cancelled"));
    // The gate: the daemon completes the create only once everything the abort sets off without waiting on the
    // daemon has run, as the fixture does (tests/deploy/deploy-candidate.test.ts withCandidate): the deploy
    // settling, then its removal and the removal's listing. A deploy that settled before the create completed is
    // removed, and listed empty, before the container appears.
    setImmediate(() => complete());
    await assert.rejects(deploying, /^Error: the deploy of lc-candidate-42-1 was cancelled: test cancelled$/);
    await removeCandidate({ name: NAME, docker, sleep: noSleep });
    assert.deepEqual(order, ["create requested", "create completed", "removed", "listed 0"]);
    assert.deepEqual([...held], [], "the candidate's container outlived its removal");
  } finally {
    rmSync(keysRoot, { recursive: true, force: true });
  }
});

/** Files the candidate image consumes that change what its deploy does, not only the code the batch verifies. */
const CANDIDATE_IMAGE_INPUTS = ["package-lock.json", "db/migrations"];

/**
 * The files whose change changes what the deploy queue's jobs do: both workflows, every repository script a
 * job step runs, the journeys, the declaration and npm scripts the steps resolve through, the Dockerfile the
 * candidate is built from with its lockfile and migrations, and every manifest and directory deploy-candidate.mjs reads to run the candidate.
 */
function queueFiles(): string[] {
  const d = delivery["deploy"] as Obj;
  const files = new Set<string>([d["workflow"], d["dry_run"]["workflow"], "delivery.yaml", "package.json", "Dockerfile"]);
  // What the candidate image is built from beyond the source the batch verifies: the lockfile `npm ci` installs
  // (in the job and in the Dockerfile) and the migrations the candidate's migrate applies at startup.
  for (const input of CANDIDATE_IMAGE_INPUTS) {
    const inside = repoFiles.filter((f) => f === input || f.startsWith(`${input}/`));
    assert.ok(inside.length > 0, `the candidate image input ${input} is not in the repository`);
    for (const f of inside) files.add(f);
  }
  for (const { run } of runCommands(yamlFile(d["workflow"]))) {
    for (const w of words(run.replace(/\n/g, " "))) if (w.startsWith(".github/scripts/")) files.add(w);
  }
  for (const f of testSelection(d["journeys"]["command"], scripts)) files.add(f);
  for (const input of Object.values(CANDIDATE_INPUTS)) {
    const inside = repoFiles.filter((f) => f === input || f.startsWith(`${input}/`));
    assert.ok(inside.length > 0, `the candidate input ${input} is not in the repository`);
    for (const f of inside) files.add(f);
  }
  return [...files].sort();
}

test("a pull request that changes the deploy queue runs its batch and deploy jobs as a dry run", async () => {
  const d = delivery["deploy"] as Obj;
  const path = d["dry_run"]?.["workflow"];
  assert.equal(typeof path, "string", "delivery.yaml deploy.dry_run names no workflow");
  const queue = yamlFile(d["workflow"]);
  const dry = yamlFile(path);

  // It runs on a plain pull request (never pull_request_target), only when the queue itself changes.
  assert.deepEqual(Object.keys(dry["on"] ?? {}), ["pull_request"]);
  const paths = dry["on"]["pull_request"]?.["paths"] as string[];
  assert.ok(Array.isArray(paths) && paths.length > 0, "the dry run has no paths filter, so it would run E2E on every pull request");
  const matched = (f: string): boolean => paths.some((p) => matchesGlob(f, p));
  for (const f of queueFiles()) assert.ok(matched(f), `a pull request changing ${f} does not run the dry run`);
  // An ordinary change still waits for the batch (delivery.yaml e2e.runs once_per_batch).
  for (const f of ["src/main.ts", "tests/api/loops.test.ts", "docs/EXTERNAL-REVIEW.md"]) assert.ok(!matched(f), `${f} runs the dry run`);

  // It never queues behind, or displaces, a batch waiting in the deploy group.
  assert.notEqual(String(dry["concurrency"]?.["group"]), String(queue["concurrency"]["group"]));
  assert.match(String(dry["concurrency"]?.["group"]), /\$\{\{ github\.ref \}\}/, "dry runs of different pull requests share a group");
  assert.deepEqual(dry["permissions"], queue["permissions"]);

  // The same jobs, needs, conditions, permissions and steps as the queue; each names the job it dry-runs.
  const queueJobs = queue["jobs"] as Obj;
  const dryJobs = dry["jobs"] as Obj;
  assert.deepEqual(Object.keys(dryJobs), Object.keys(queueJobs));
  for (const [name, job] of Object.entries(queueJobs) as [string, Obj][]) {
    const { env: dryEnv = {}, ...dryRest } = dryJobs[name] as Obj;
    const { env: queueEnv = {}, ...queueRest } = job;
    assert.deepEqual(dryRest, queueRest, `the dry run's ${name} job differs from the queue's`);
    assert.equal(dryEnv["DRY_RUN_OF"], name, `the dry run's ${name} job does not declare DRY_RUN_OF: ${name}`);
    const { DRY_RUN_OF: _of, CANDIDATE_NAME: dryName, ...dryOther } = dryEnv;
    const { CANDIDATE_NAME: queueName, ...queueOther } = queueEnv;
    assert.deepEqual(dryOther, queueOther, `the dry run's ${name} job env differs from the queue's`);
    assert.equal(dryName === undefined, queueName === undefined);
  }

  // Its candidate is its own: per pull request and run attempt, apart from any batch's, and a name
  // deploy-candidate.mjs accepts for teardown.
  const name = String(dryJobs[d["job"]]["env"]["CANDIDATE_NAME"]);
  assert.equal(name, "lc-candidate-pr-${{ github.event.pull_request.number }}-${{ github.run_id }}-${{ github.run_attempt }}");
  const concrete = name.replace("${{ github.event.pull_request.number }}", "89").replace("${{ github.run_id }}", "123").replace("${{ github.run_attempt }}", "2");
  assert.doesNotMatch(concrete, /^lc-candidate-\d+-\d+$/, "the dry run's candidate has a batch candidate's name");
  const calls: string[][] = [];
  await removeCandidate({ name: concrete, docker: fakeDocker(calls) });
  assert.deepEqual(calls.find((c) => c[0] === "network"), ["network", "rm", "lc-candidate-pr-89-123-2", "#nocheck"]);
});

test("the dry run's trigger covers every file the candidate is built or migrated from, including db/migrations and package-lock.json", () => {
  const paths = yamlFile(delivery["deploy"]["dry_run"]["workflow"])["on"]["pull_request"]["paths"] as string[];
  const uncovered = (trigger: string[]): string[] => queueFiles().filter((f) => !trigger.some((p) => matchesGlob(f, p)));
  const files = queueFiles();
  // The pinned inputs include the lockfile `npm ci` installs and every migration the candidate applies at startup,
  // alongside every file deploy-candidate.mjs reads (CANDIDATE_INPUTS).
  assert.ok(files.includes("package-lock.json"), "the pinned candidate inputs omit package-lock.json");
  assert.ok(files.some((f) => f.startsWith("db/migrations/")), "the pinned candidate inputs omit db/migrations");
  for (const input of Object.values(CANDIDATE_INPUTS)) assert.ok(files.some((f) => f === input || f.startsWith(`${input}/`)), `${input} is not pinned`);
  assert.deepEqual(uncovered(paths), [], "a pull request changing these does not run the dry run");
  // A trigger without either path leaves a candidate input that skips the dry run, so the guard fails.
  const without = (gone: (p: string) => boolean): string[] => paths.filter((p) => !gone(p));
  assert.ok(uncovered(without((p) => p.startsWith("db/migrations"))).some((f) => f.startsWith("db/migrations/")));
  assert.deepEqual(uncovered(without((p) => p === "package-lock.json")), ["package-lock.json"]);
});

const removal = [
  ["rm", "--force", "--volumes", `${NAME}-api`, `${NAME}-migrate`, `${NAME}-config`, `${NAME}-db`, "#nocheck"],
  ["volume", "rm", "--force", `${NAME}-keys`, `${NAME}-scopes`, "#nocheck"],
  ["network", "rm", NAME, "#nocheck"],
];

test("teardown removes the candidate's containers, volumes and network, tolerating what is already gone, then reads back that none is left", async () => {
  const calls: string[][] = [];
  // Another candidate whose name extends this one's is listed by docker's substring filter and is not this one's.
  await removeCandidate({ name: NAME, docker: fakeDocker(calls, { listed: (kind) => [`${NAME}0${kind === "ps" ? "-db" : ""}`] }) });
  assert.deepEqual(calls, [...removal, ...listings(NAME)]);
  await assert.rejects(removeCandidate({ name: "loopcloser", docker: fakeDocker([]) }), /not lc-candidate-<id>/);
});

test("teardown removes again what appears after a removal, as a daemon finishing a killed command's create does, and fails naming what is left", async () => {
  // A container the daemon was still creating for a killed `docker run` shows up after the first removal.
  const calls: string[][] = [];
  const slept: number[] = [];
  let rounds = 0;
  await removeCandidate({
    name: NAME,
    docker: fakeDocker(calls, { listed: (kind) => (kind === "ps" && rounds++ === 0 ? [`${NAME}-migrate`] : []) }),
    sleep: async (ms) => void slept.push(ms),
  });
  assert.deepEqual(calls, [...removal, ...listings(NAME), ...removal, ...listings(NAME)]);
  assert.deepEqual(slept, [1_000]);

  // What never goes away fails the teardown, named, after the given number of rounds.
  const stuck: string[][] = [];
  await assert.rejects(
    removeCandidate({
      name: NAME,
      docker: fakeDocker(stuck, { listed: (kind) => (kind === "volume" ? [`${NAME}-keys`] : kind === "network" ? [NAME] : []) }),
      sleep: noSleep,
      attempts: 3,
    }),
    /^Error: candidate lc-candidate-42-1 still has volume lc-candidate-42-1-keys, network lc-candidate-42-1 after 3 removals$/,
  );
  assert.equal(stuck.length, 3 * (removal.length + listings(NAME).length));
});

/**
 * A fake docker executable that answers only the calls a candidate deploy makes, logs each call's arguments
 * to $FAKE_DOCKER_LOG, and fails the call that starts with `$FAKE_DOCKER_FAIL` the way docker does: Docker's stderr
 * echoes the arguments, so it carries the password and the DATABASE_URL. Any other call fails as unexpected.
 */
const FAKE_DOCKER_BIN = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$*" in
  "$FAKE_DOCKER_FAIL"*) echo "Error response from daemon: cannot $1 with $*" >&2; exit 125 ;;
esac
case "$1" in
  network|volume|create|cp|start|rm) exit 0 ;;
  exec) echo "127.0.0.1:5432 - accepting connections"; exit 0 ;;
esac
echo "unexpected docker call: $*" >&2
exit 99
`;

test("a failed docker command reports the subcommand without the generated database password or DATABASE_URL credentials", () => {
  const dir = mkdtempSync(join(tmpdir(), "lc-deploy-redact-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "docker"), FAKE_DOCKER_BIN, { mode: 0o755 });
    // Postgres's create carries the superuser's generated password, the migration's the owner's (in DATABASE_URL).
    const failures = [
      { sub: `create --name ${NAME}-db`, secret: /POSTGRES_PASSWORD=(\S+)/, url: false },
      { sub: `create --rm --name ${NAME}-migrate`, secret: /postgres:\/\/loopcloser:([^@\s]+)@/, url: true },
    ];
    for (const [i, { sub, secret, url }] of failures.entries()) {
      const log = join(dir, `${i}.log`);
      const res = spawnSync(process.execPath, [join(repoRoot, ".github", "scripts", "deploy-candidate.mjs"), "up", IMAGE, NAME], {
        encoding: "utf8",
        env: { PATH: `${bin}:${process.env["PATH"]}`, RUNNER_TEMP: dir, FAKE_DOCKER_LOG: log, FAKE_DOCKER_FAIL: sub },
      });
      const printed = `${res.stdout}${res.stderr}`;
      assert.equal(res.status, 1, printed);
      const calls = readFileSync(log, "utf8");
      const password = secret.exec(calls)?.[1];
      assert.ok(password && password.length >= 32, `docker ${sub} was not given a generated password: ${calls}`);
      // The failure reached docker with the secret, as Docker's stderr echoes it.
      assert.ok(calls.split("\n").some((c) => c.startsWith(`${sub} `) && c.includes(password)));
      assert.ok(printed.split("\n").some((l) => l.startsWith(`::error::docker ${sub} `)), `the failed docker ${sub} is not named:\n${printed}`);
      assert.ok(!printed.includes(password), `docker ${sub}'s failure printed the generated password:\n${printed}`);
      assert.doesNotMatch(printed, /postgres:\/\/[^\s:@/]+:[^\s@/*]+@/, `docker ${sub}'s failure printed DATABASE_URL credentials`);
      assert.doesNotMatch(printed, /POSTGRES_PASSWORD=(?!\*)/, `docker ${sub}'s failure printed POSTGRES_PASSWORD`);
      if (url) assert.match(printed, /DATABASE_URL=postgres:\/\/loopcloser:\*\*\*@/, "the masked DATABASE_URL still names its user");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
