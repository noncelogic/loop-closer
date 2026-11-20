// COND-277 acceptance (policy main-stays-green v1): every job main runs in
// .github/workflows/ci.yml is proven on the pull request. ci runs on
// pull_request as well as on pushes to main, and its result job `gate`
// needs every other ci job, so the one required status check `gate` on main's
// strict branch protection covers them all, `image` included. `image` builds
// on the pull request without pushing; only a push to main publishes. Static
// check of the workflow file, plus runs of the gate step's own command
// (.github/scripts/ci-gate.sh) with controlled needed-job results: nothing here
// reaches GitHub, a runner or a registry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
type Obj = Record<string, any>;

/** The required status check on main: the result job of ci.yml. */
export const REQUIRED_CHECK = "gate";

function ci(): Obj {
  return parse(readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8")) as Obj;
}

function needsOf(job: Obj): string[] {
  const n = job["needs"];
  return n === undefined ? [] : Array.isArray(n) ? n : [n];
}

test("ci runs every job on pull requests as well as on pushes to main", () => {
  const wf = ci();
  const on = wf["on"] as Obj;
  assert.ok("pull_request" in on, "ci runs on pull_request");
  assert.equal(on["pull_request"], null, "on every pull request, with no branch or path filter");
  assert.ok(!("pull_request_target" in on), "never pull_request_target");
  assert.deepEqual(on["push"], { branches: ["main"] });
  for (const [name, job] of Object.entries(wf["jobs"] as Obj)) {
    const cond = String((job as Obj)["if"] ?? "");
    assert.ok(!/github\.(event_name|ref)/.test(cond), `job ${name} is not skipped on pull requests (if: ${cond})`);
  }
});

test("image builds on the pull request and pushes only from main", () => {
  const image = (ci()["jobs"] as Obj)["image"] as Obj;
  assert.ok(image, "ci has the image job");
  const build = (image["steps"] as Obj[]).find((s) => String(s["uses"] ?? "").startsWith("docker/build-push-action@"));
  assert.ok(build, "image builds with docker/build-push-action");
  assert.equal(build!["if"], undefined, "the build itself runs on every event");
  assert.equal(
    build!["with"]["push"],
    "${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}",
    "the image is pushed only on pushes to main",
  );
});

/** The expression the gate step passes its needed jobs' results with. */
const RESULTS_EXPR = "${{ join(needs.*.result, ' ') }}";

function gateJob(): Obj {
  const gate = (ci()["jobs"] as Obj)[REQUIRED_CHECK] as Obj;
  assert.ok(gate, `ci has the result job ${REQUIRED_CHECK}`);
  return gate;
}

/**
 * Runs the gate step's own `run` command, as the runner would, with GitHub's
 * expansion of RESULTS_EXPR replaced by the given needed-job results.
 */
function runGate(results: string[]): { status: number | null; output: string } {
  const step = (gateJob()["steps"] as Obj[]).find((s) => s["run"] !== undefined)!;
  const run = String(step["run"]);
  assert.ok(run.includes(RESULTS_EXPR), `the gate step passes every needed job's result (${RESULTS_EXPR})`);
  const r = spawnSync("bash", ["-c", run.split(RESULTS_EXPR).join(results.join(" "))], { cwd: repoRoot, encoding: "utf8" });
  return { status: r.status, output: r.stdout + r.stderr };
}

test(`the required result job ${REQUIRED_CHECK} needs every ci job and always reports`, () => {
  const jobs = ci()["jobs"] as Obj;
  const gate = gateJob();
  assert.equal(gate["name"], undefined, `its check name is the job id ${REQUIRED_CHECK}`);
  const others = Object.keys(jobs).filter((j) => j !== REQUIRED_CHECK).sort();
  assert.ok(others.includes("image"), "image is among the gated jobs");
  assert.deepEqual([...needsOf(gate)].sort(), others, `${REQUIRED_CHECK} needs every other ci job`);
  assert.equal(gate["if"], "${{ always() }}", `${REQUIRED_CHECK} reports even when a needed job fails or is skipped`);
  assert.deepEqual(gate["runs-on"], ["self-hosted", "aks"]);
  assert.deepEqual(gate["permissions"], { contents: "read" }, `${REQUIRED_CHECK} only reads the repository`);
  for (const s of gate["steps"] as Obj[]) {
    assert.equal(s["if"], undefined, `every ${REQUIRED_CHECK} step runs, whatever the needed jobs' results`);
  }
});

test(`${REQUIRED_CHECK} passes when every needed job succeeded`, () => {
  const n = needsOf(gateJob()).length;
  const r = runGate(Array(n).fill("success"));
  assert.equal(r.status, 0, r.output);
});

for (const bad of ["failure", "cancelled", "skipped"]) {
  test(`${REQUIRED_CHECK} fails when a needed job is ${bad}`, () => {
    const needs = needsOf(gateJob());
    for (let i = 0; i < needs.length; i++) {
      const results = needs.map((_, j) => (j === i ? bad : "success"));
      const r = runGate(results);
      assert.equal(r.status, 1, `${needs[i]} ${bad}: ${r.output}`);
      assert.match(r.output, /did not succeed/);
    }
  });
}

test(`${REQUIRED_CHECK} fails when it is given no results`, () => {
  assert.equal(runGate([]).status, 1);
});
