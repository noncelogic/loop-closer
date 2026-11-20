// COND-277 acceptance (policy main-stays-green v1): every job main runs in
// .github/workflows/ci.yml is proven on the pull request. ci runs on
// pull_request as well as on pushes to main, and its result job `gate`
// needs every other ci job, so the one required status check `gate` on main's
// strict branch protection covers them all, `image` included. `image` builds
// on the pull request without pushing; only a push to main publishes. Static
// check of the workflow file: nothing here reaches GitHub, a runner or a registry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

test(`the required result job ${REQUIRED_CHECK} needs every ci job and fails unless all succeeded`, () => {
  const jobs = ci()["jobs"] as Obj;
  const gate = jobs[REQUIRED_CHECK] as Obj;
  assert.ok(gate, `ci has the result job ${REQUIRED_CHECK}`);
  assert.equal(gate["name"], undefined, `its check name is the job id ${REQUIRED_CHECK}`);
  const others = Object.keys(jobs).filter((j) => j !== REQUIRED_CHECK).sort();
  assert.ok(others.includes("image"), "image is among the gated jobs");
  assert.deepEqual([...needsOf(gate)].sort(), others, `${REQUIRED_CHECK} needs every other ci job`);
  assert.equal(gate["if"], "${{ always() }}", `${REQUIRED_CHECK} reports even when a needed job fails or is skipped`);
  assert.deepEqual(gate["runs-on"], ["self-hosted", "aks"]);
  assert.deepEqual(gate["permissions"], {}, `${REQUIRED_CHECK} needs no token scope`);
  const steps = gate["steps"] as Obj[];
  assert.equal(steps.length, 1);
  const s = steps[0]!;
  assert.equal(s["uses"], undefined, "no action, no checkout: it reads only the needed jobs' results");
  for (const r of ["failure", "cancelled", "skipped"]) {
    assert.ok(String(s["if"]).includes(`contains(needs.*.result, '${r}')`), `${REQUIRED_CHECK} fails when a needed job is ${r}`);
  }
  assert.match(String(s["run"]), /exit 1/);
});
