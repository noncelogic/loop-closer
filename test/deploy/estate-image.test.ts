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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse, parseAllDocuments } from "yaml";

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
