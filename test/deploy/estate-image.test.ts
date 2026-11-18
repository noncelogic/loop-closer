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

  // An image without the entrypoint fails the check: the base image the build
  // starts from has node but no dist/portal-read.js.
  const base = /^FROM\s+(\S+)\s*$/m.exec(readFileSync(join(repoRoot, "Dockerfile"), "utf8"))?.[1];
  assert.ok(base, "the Dockerfile names its base image");
  const missing = smoke(base, command);
  assert.notEqual(missing.status, 0, `the smoke check fails on an image without the entrypoint:\n${missing.output}`);
});
