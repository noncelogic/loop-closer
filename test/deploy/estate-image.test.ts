// LC-EST-PORTAL-IMAGE acceptance: the loopcloser estate image that
// .github/workflows/estate-image.yml publishes on merge to main runs the
// portal-read entrypoint the suspended listings-read CronJob starts
// (deploy/overlays/aks-obs-01/listings-read.yaml). The publish itself can only
// act on main, so ci.yml carries its
// pull-request dry run (policy main-stays-green): job `estate-image-dry-run`
// builds the same context and Dockerfile on the ARC org scale set, pushes
// nothing, and runs the CronJob's command in the built image through
// .github/scripts/estate-image-smoke.sh.
//
// This test checks that wiring, then does what the dry run does: builds the
// image with Docker and runs the smoke check against it, and against an image
// without the entrypoint, which must fail. No registry, secret or cluster is
// touched. Requires Docker.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, parseAllDocuments } from "yaml";
import { REGISTRY_ATTEMPTS, backoffMs, registryOp } from "../../.github/scripts/estate-registry-retry.mjs";

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
type Obj = Record<string, any>;

const CI = join(repoRoot, ".github", "workflows", "ci.yml");
const PUBLISH = join(repoRoot, ".github", "workflows", "estate-image.yml");
const SMOKE = join(repoRoot, ".github", "scripts", "estate-image-smoke.sh");
const SMOKE_REL = ".github/scripts/estate-image-smoke.sh";
const LISTINGS_READ = join(repoRoot, "deploy", "overlays", "aks-obs-01", "listings-read.yaml");
const DRY_RUN_JOB = "estate-image-dry-run";
const PROXY_VARS = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"];

function buildStep(job: Obj): Obj {
  const step = ((job["steps"] ?? []) as Obj[]).find((s) => String(s["uses"] ?? "").startsWith("docker/build-push-action@"));
  assert.ok(step, "the job builds with docker/build-push-action");
  return (step["with"] ?? {}) as Obj;
}

/** The command the listings-read CronJob runs (the overlay patches its image, never its command). */
function listingsReadCommand(): string[] {
  const docs = parseAllDocuments(readFileSync(LISTINGS_READ, "utf8")).map((d) => d.toJS() as Obj);
  const cron = docs.find(
    (o) => o["kind"] === "CronJob" && o["metadata"]?.["name"] === "loopcloser-listings-read",
  );
  assert.ok(cron, "the aks-obs-01 overlay carries the listings-read CronJob");
  const containers = cron["spec"]["jobTemplate"]["spec"]["template"]["spec"]["containers"] as Obj[];
  const container = containers.find((c) => c["name"] === "portal-read");
  assert.ok(container, "the listings-read CronJob has the portal-read container");
  return container["command"] as string[];
}

/** The build-args a docker/build-push-action step passes, one NAME=value per line. */
function buildArgs(step: Obj): Record<string, string> {
  const args: Record<string, string> = {};
  for (const line of String(step["build-args"] ?? "").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const eq = t.indexOf("=");
    assert.ok(eq > 0, `build-arg line is NAME=value: ${t}`);
    args[t.slice(0, eq)] = t.slice(eq + 1);
  }
  return args;
}

// An image reference: [registry[:port]/]path[:tag][@sha256:digest], lowercase path.
const IMAGE_REF =
  /^(?:[a-zA-Z0-9.-]+(?::[0-9]+)?\/)?[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*(?::\w[\w.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/;
const ARG_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * The base image of the Dockerfile's last (runtime) stage, with the ARGs
 * declared before the first FROM resolved as `docker build` resolves them: a
 * passed build-arg over the declared default. Throws, naming the argument,
 * when the reference is left unresolved or resolves to a malformed reference.
 */
function runtimeBaseImage(dockerfile: string, args: Record<string, string>): string {
  const lines = dockerfile.split("\n").map((l) => l.trim());
  const isFrom = (l: string) => /^FROM\s/i.test(l);
  const firstFrom = lines.findIndex(isFrom);
  assert.ok(firstFrom >= 0, "the Dockerfile has a FROM");
  const values = new Map<string, string | undefined>();
  for (const l of lines.slice(0, firstFrom)) {
    const m = /^ARG\s+([A-Za-z_][A-Za-z0-9_]*)(?:=(.*))?$/i.exec(l);
    if (m) values.set(m[1]!, m[2]?.replace(/^"(.*)"$/, "$1"));
  }
  for (const [k, v] of Object.entries(args)) if (values.has(k)) values.set(k, v);
  const lastFrom = lines.filter(isFrom).at(-1)!;
  const raw = /^FROM\s+(?:--platform=\S+\s+)?(\S+)/i.exec(lastFrom)![1]!;
  const used: string[] = [];
  const ref = raw.replace(ARG_REF, (_, braced: string | undefined, bare: string | undefined) => {
    const name = (braced ?? bare)!;
    const v = values.get(name);
    if (v === undefined || v === "") {
      throw new Error(
        `${name} is unresolved in the base image reference ${raw}: no ARG default before the first FROM and no build-arg`,
      );
    }
    used.push(name);
    return v;
  });
  if (!IMAGE_REF.test(ref)) {
    const what = used.length ? `${used.join(", ")} resolves to` : "the base is";
    throw new Error(`${what} a malformed image reference: ${JSON.stringify(ref)} (from ${raw})`);
  }
  return ref;
}

function smoke(image: string, command: string[]): { status: number | null; output: string } {
  const r = spawnSync("bash", [SMOKE, image, ...command], { cwd: repoRoot, encoding: "utf8" });
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
}

const tag = `loopcloser-estate-dry-run:${randomBytes(6).toString("hex")}`;
after(() => {
  spawnSync("docker", ["image", "rm", "--force", tag], { encoding: "utf8" });
});

test("the estate image built by the publish dry run starts the portal-read entrypoint", { timeout: 900_000 }, () => {
  const command = listingsReadCommand();
  assert.deepEqual(command, ["node", "dist/portal-read.js"], "the CronJob runs the portal-read entrypoint");

  // The dry run: a pull-request job, on the ARC org scale set, that builds
  // exactly what the main publish builds and pushes nothing.
  const ci = parse(readFileSync(CI, "utf8")) as Obj;
  assert.ok("pull_request" in (ci["on"] as Obj), "ci.yml runs on pull requests");
  assert.ok(!("pull_request_target" in (ci["on"] as Obj)), "never pull_request_target");
  const job = (ci["jobs"] as Obj)[DRY_RUN_JOB] as Obj | undefined;
  assert.ok(job, `ci.yml has the ${DRY_RUN_JOB} job`);
  assert.equal(job["if"], undefined, "the dry run runs on every event, pull requests included");
  assert.deepEqual(job["runs-on"], ["self-hosted", "aks"], "the dry run runs on the ARC org scale set, like the publish");
  assert.deepEqual(job["permissions"], { contents: "read" }, "the dry run can read the repo and nothing else");
  const text = JSON.stringify(job);
  assert.ok(!/secrets\.|github\.token|vars\./.test(text), "the dry run reads no secret and no estate configuration");

  const publish = parse(readFileSync(PUBLISH, "utf8")) as Obj;
  const publishBuild = buildStep((publish["jobs"] as Obj)["publish"] as Obj);
  const dryBuild = buildStep(job);
  assert.equal(dryBuild["context"], publishBuild["context"], "same build context as the publish");
  assert.equal(dryBuild["file"], publishBuild["file"], "same Dockerfile as the publish");
  assert.equal(dryBuild["push"], false, "the dry run pushes nothing");
  assert.equal(dryBuild["load"], true, "the dry run loads the image so it can run it");
  const dryTag = String(dryBuild["tags"]);
  assert.match(dryTag, /^loopcloser:sha-\$\{\{ github\.sha \}\}$/, "tagged like the publish, without a registry");

  const steps = job["steps"] as Obj[];
  const buildIdx = steps.findIndex((s) => String(s["uses"] ?? "").startsWith("docker/build-push-action@"));
  const smokeIdx = steps.findIndex((s) => String(s["run"] ?? "").includes(SMOKE_REL));
  assert.ok(smokeIdx > buildIdx, "the dry run runs the smoke check after the build");
  assert.equal(
    String(steps[smokeIdx]!["run"]).trim(),
    `bash ${SMOKE_REL} ${dryTag} ${command.join(" ")}`,
    "the smoke check runs the built image with the CronJob's command",
  );

  // What the dry run does, here: build the image from the same context and
  // Dockerfile, then run the CronJob's command in it.
  // Docker's predefined proxy build args are forwarded when the host sets them
  // (a proxied workstation); they never change what the image contains.
  const proxyArgs = PROXY_VARS.filter((v) => process.env[v]).flatMap((v) => ["--build-arg", v]);
  const built = spawnSync(
    "docker",
    ["build", "--tag", tag, ...proxyArgs, "--file", join(repoRoot, "Dockerfile"), repoRoot],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  assert.equal(built.status, 0, `docker build of the estate image failed:\n${built.stderr}`);
  const ok = smoke(tag, command);
  assert.equal(ok.status, 0, `the smoke check passes on the built image:\n${ok.output}`);
  assert.match(ok.output, /portal read failed: Error: DATABASE_URL is not set/, "the portal-read entrypoint itself ran");

  // An image without the entrypoint fails the check: the base image the
  // runtime stage starts from has node but no dist/portal-read.js. NODE_IMAGE
  // is resolved as the dry run's build resolves it (its build-args over the
  // Dockerfile's ARG default), so the case runs a real image and fails only
  // because the entrypoint is missing, never on an invalid reference
  // (LC-EST-BASE-ARG-SMOKE).
  const base = runtimeBaseImage(readFileSync(join(repoRoot, "Dockerfile"), "utf8"), buildArgs(dryBuild));
  assert.equal(base, "node:24-bookworm-slim", "the dry run keeps the Dockerfile's default node base");
  // A BuildKit build need not leave the base tag in Docker's runnable image
  // store, so the base is pulled, and the pull must succeed, before the smoke
  // run: the case never depends on the daemon's existing image cache.
  const pulled = spawnSync("docker", ["pull", base], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  assert.equal(pulled.status, 0, `docker pull of the base image ${base} failed:\n${pulled.stdout}${pulled.stderr}`);
  const missing = smoke(base, command);
  assert.equal(missing.status, 1, `the smoke check fails on an image without the entrypoint:\n${missing.output}`);
  // Docker's benign cache-miss notice ("Unable to find image ... locally") is
  // not a failure: the missing-module assertion below proves the image ran.
  assert.doesNotMatch(
    missing.output,
    /invalid reference format|pull access denied|manifest unknown/i,
    "the base image ran: the case does not pass on an image that cannot be run",
  );
  assert.match(
    missing.output,
    /Cannot find module '\S*\/dist\/portal-read\.js'/,
    "the check fails because the image has no portal-read entrypoint",
  );
  assert.match(missing.output, /did not start 'node dist\/portal-read\.js'/, "the smoke check names the failure");
});

test("the negative smoke base resolves NODE_IMAGE, and an unresolved or malformed base reference fails", () => {
  const dockerfile = readFileSync(join(repoRoot, "Dockerfile"), "utf8");
  assert.equal(runtimeBaseImage(dockerfile, {}), "node:24-bookworm-slim", "the declared ARG default");
  assert.equal(
    runtimeBaseImage(dockerfile, { NODE_IMAGE: "registry.example.invalid/node:24-bookworm-slim" }),
    "registry.example.invalid/node:24-bookworm-slim",
    "a build-arg the dry run passes overrides the default",
  );

  // Declared without a default and not passed: the reference stays unresolved.
  const noDefault = "ARG NODE_IMAGE\nFROM ${NODE_IMAGE} AS build\nFROM ${NODE_IMAGE}\n";
  assert.throws(() => runtimeBaseImage(noDefault, {}), /NODE_IMAGE is unresolved/);
  // Referenced but never declared before the first FROM.
  assert.throws(() => runtimeBaseImage("FROM $NODE_IMAGE\n", {}), /NODE_IMAGE is unresolved/);
  // A build-arg that is itself an unexpanded workflow expression.
  assert.throws(
    () => runtimeBaseImage(dockerfile, { NODE_IMAGE: "${{ vars.ESTATE_REGISTRY }}/node:24-bookworm-slim" }),
    /NODE_IMAGE resolves to a malformed image reference/,
  );
  // A malformed default.
  assert.throws(
    () => runtimeBaseImage("ARG NODE_IMAGE=Node:24 slim\nFROM ${NODE_IMAGE}\n", {}),
    /NODE_IMAGE resolves to a malformed image reference/,
  );
});

// LC-EST-PUBLISH-BOUNDED-WAIT acceptance: the main-only publish depends on two
// external registry operations, the node base pull from the estate ACR cache
// (LC-EST-BASE-FROM-ACR) and the image push. Policy main-stays-green asks its
// main step to tolerate those delays with a bounded wait: both run through
// .github/scripts/estate-registry-retry.mjs, which retries a transient
// registry failure up to a fixed attempt cap with backoff and then fails with
// the last registry error. A credential or reference error fails on the first
// attempt. The wait is injected, so these tests never sleep; the registry
// operations are the script's real `docker` calls against a stub `docker`.
const RETRY_REL = ".github/scripts/estate-registry-retry.mjs";

/**
 * A `docker` stub on PATH that fails its first `failures` calls with
 * `message` on stderr, then prints `success` and exits 0. Records each call.
 */
function flakyDocker(failures: number, message: string, success: string): { dir: string; calls: () => string[] } {
  const dir = mkdtempSync(join(tmpdir(), "lc-docker-flaky-"));
  const record = join(dir, "calls");
  writeFileSync(
    join(dir, "docker"),
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$*" >> "${record}"`,
      `n=$(wc -l < "${record}")`,
      `if [ "$n" -le ${failures} ]; then printf '%s\\n' ${JSON.stringify(message)} >&2; exit 1; fi`,
      `printf '%s\\n' ${JSON.stringify(success)}`,
      "",
    ].join("\n"),
  );
  chmodSync(join(dir, "docker"), 0o755);
  return {
    dir,
    calls: () => (existsSync(record) ? readFileSync(record, "utf8").trim().split("\n") : []),
  };
}

function stubEnv(dir: string): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${dir}:${process.env["PATH"]}` };
}

const REF = "registry.estate.example/loopcloser:sha-0123456789abcdef";
const DIGEST = `sha256:${"ab".repeat(32)}`;
const PUSHED = `sha-0123456789abcdef: digest: ${DIGEST} size: 1784`;

test("publish registry retry succeeds when a transient registry failure clears before the attempt cap", async () => {
  const stub = flakyDocker(2, "received unexpected HTTP status: 503 Service Unavailable", PUSHED);
  const waits: number[] = [];
  try {
    const result = await registryOp("push", REF, {
      env: stubEnv(stub.dir),
      sleep: async (ms) => void waits.push(ms),
      log: () => {},
    });
    assert.equal(result.attempts, 3, "two transient failures, then the push went through");
    assert.equal(result.digest, DIGEST, "the digest the registry returned for the push");
    assert.deepEqual(stub.calls(), [`push ${REF}`, `push ${REF}`, `push ${REF}`]);
    assert.deepEqual(waits, [backoffMs(1), backoffMs(2)], "one backoff wait before each retry");
    assert.ok(backoffMs(2) > backoffMs(1), "the wait backs off");
  } finally {
    rmSync(stub.dir, { recursive: true, force: true });
  }

  // The node base pull from the estate ACR cache takes the same bounded wait.
  const base = "registry.estate.example/node:24-bookworm-slim";
  const pull = flakyDocker(1, "toomanyrequests: too many requests", "Status: Downloaded newer image");
  try {
    const result = await registryOp("pull", base, { env: stubEnv(pull.dir), sleep: async () => {}, log: () => {} });
    assert.equal(result.attempts, 2);
    assert.deepEqual(pull.calls(), [`pull ${base}`, `pull ${base}`]);
  } finally {
    rmSync(pull.dir, { recursive: true, force: true });
  }
});

test("publish registry retry stops at its attempt cap and surfaces the last registry error", async () => {
  const stub = flakyDocker(100, "net/http: TLS handshake timeout", PUSHED);
  const waits: number[] = [];
  try {
    await assert.rejects(
      registryOp("push", REF, { env: stubEnv(stub.dir), sleep: async (ms) => void waits.push(ms), log: () => {} }),
      (err: Error) => {
        assert.match(err.message, new RegExp(`docker push ${REF.replace(/[.]/g, "\\.")} failed after ${REGISTRY_ATTEMPTS} attempts`));
        assert.match(err.message, /net\/http: TLS handshake timeout/, "the last registry error is surfaced");
        return true;
      },
    );
    assert.equal(stub.calls().length, REGISTRY_ATTEMPTS, "no attempt beyond the cap");
    assert.equal(waits.length, REGISTRY_ATTEMPTS - 1, "no wait after the last attempt");
    assert.ok(waits.reduce((a, b) => a + b, 0) <= 5 * 60_000, "the whole wait is bounded well inside the job's timeout");
  } finally {
    rmSync(stub.dir, { recursive: true, force: true });
  }

  // A credential or reference error is not a delay: it fails on the first
  // attempt, so a misconfigured publish is never hidden behind retries.
  for (const message of [
    "unauthorized: authentication required",
    "denied: requested access to the resource is denied",
    "manifest unknown: manifest tagged by \"24-bookworm-slim\" is not found",
    "invalid reference format",
  ]) {
    const bad = flakyDocker(100, message, PUSHED);
    try {
      await assert.rejects(
        registryOp("pull", REF, { env: stubEnv(bad.dir), sleep: async () => assert.fail("no wait"), log: () => {} }),
        (err: Error) => err.message.includes("failed on attempt 1") && err.message.includes(message),
        message,
      );
      assert.equal(bad.calls().length, 1, `${message}: one attempt only`);
    } finally {
      rmSync(bad.dir, { recursive: true, force: true });
    }
  }

  // A push that reports no digest is an error, not a success.
  const noDigest = flakyDocker(0, "", "pushed");
  try {
    await assert.rejects(
      registryOp("push", REF, { env: stubEnv(noDigest.dir), sleep: async () => {}, log: () => {} }),
      /reported no sha256 digest/,
    );
  } finally {
    rmSync(noDigest.dir, { recursive: true, force: true });
  }
});

test("the publish pulls the node base and pushes the image through the bounded registry retry", () => {
  const publish = parse(readFileSync(PUBLISH, "utf8")) as Obj;
  const steps = ((publish["jobs"] as Obj)["publish"] as Obj)["steps"] as Obj[];
  const idx = (pred: (s: Obj) => boolean) => steps.findIndex(pred);
  const login = idx((s) => String(s["run"] ?? "").includes("estate-registry-credential.mjs login"));
  const pull = idx((s) => String(s["run"] ?? "").trim() === `node ${RETRY_REL} pull "$NODE_IMAGE"`);
  const build = idx((s) => String(s["uses"] ?? "").startsWith("docker/build-push-action@"));
  const push = idx((s) => String(s["run"] ?? "").trim() === `node ${RETRY_REL} push "$IMAGE_REF"`);
  assert.ok(login >= 0 && pull > login && build > pull && push > build, "login, base pull, build, push");

  const nodeImage = "${{ vars.ESTATE_REGISTRY }}/node:24-bookworm-slim";
  const tag = "${{ vars.ESTATE_REGISTRY }}/loopcloser:sha-${{ github.sha }}";
  assert.deepEqual(steps[pull]!["env"], { NODE_IMAGE: nodeImage });
  const buildWith = steps[build]!["with"] as Obj;
  assert.equal(buildWith["push"], false, "the build pushes nothing itself; the push is retried");
  assert.equal(buildWith["load"], true, "the built image lands in the local image store for the push");
  assert.equal(buildWith["tags"], tag);
  assert.match(String(buildWith["build-args"]), new RegExp(`NODE_IMAGE=${nodeImage.replace(/[$.{}]/g, "\\$&")}`));
  // The docker driver builds from the daemon's image store, so the build uses
  // the base the retried pull fetched instead of pulling it again unretried.
  const buildx = steps.find((s) => String(s["uses"] ?? "").startsWith("docker/setup-buildx-action@"));
  assert.equal((buildx?.["with"] as Obj | undefined)?.["driver"], "docker");
  assert.equal(steps[push]!["id"], "push", "the digest record reads the retried push's output");
  assert.deepEqual(steps[push]!["env"], { IMAGE_REF: tag });
});

test("the registry retry CLI records the pushed digest as the push step's output", () => {
  const stub = flakyDocker(0, "", PUSHED);
  const out = mkdtempSync(join(tmpdir(), "lc-gh-output-"));
  const ghOutput = join(out, "output");
  writeFileSync(ghOutput, "");
  try {
    const r = spawnSync(process.execPath, [join(repoRoot, RETRY_REL), "push", REF], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...stubEnv(stub.dir), GITHUB_OUTPUT: ghOutput },
    });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.equal(readFileSync(ghOutput, "utf8"), `digest=${DIGEST}\n`);

    const usage = spawnSync(process.execPath, [join(repoRoot, RETRY_REL), "tag", REF], { cwd: repoRoot, encoding: "utf8" });
    assert.equal(usage.status, 2, "an unknown operation is a usage error");
  } finally {
    rmSync(stub.dir, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});
