// LC-ESTATE-IMAGE-RUNNER acceptance: .github/workflows/estate-image.yml runs
// on a runner noncelogic/loop-closer can actually use, so a push to main
// publishes loopcloser:sha-<commit> instead of queueing forever.
//
// The passband-ci ARC scale set is registered only for noncelogic/loopmentum
// (meta-harness devops/aks/ci-runners/README.md); estate-image runs that asked
// for it never started (run 44147944903 queued from 2026-11-17T18:26Z, later
// runs cancelled behind it in the `estate-image` concurrency group).
// loop-closer has no self-hosted runner of its own, so its workflows run on
// GitHub-hosted runners, as ci.yml does. Static check of the workflow files:
// nothing here reaches GitHub, a runner or a registry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const WORKFLOWS = join(repoRoot, ".github", "workflows");
type Obj = Record<string, any>;

// Runner labels registered only for another repository's runners. A job that
// asks for any of them never starts in loop-closer.
const OTHER_REPO_ONLY_LABELS = ["passband-ci", "aks"];

// GitHub-hosted Linux labels: available to every repository in the org.
const GITHUB_HOSTED_LINUX = /^ubuntu-(latest|\d{2}\.04)(-arm)?$/;

function load(file: string): Obj {
  return parse(readFileSync(join(WORKFLOWS, file), "utf8")) as Obj;
}

function labels(job: Obj): unknown[] {
  const runsOn = job["runs-on"];
  return Array.isArray(runsOn) ? runsOn : [runsOn];
}

/** Why a job's runs-on is not one loop-closer can use, or null when it is. */
function unavailable(job: Obj): string | null {
  const ls = labels(job);
  if (ls.length === 0 || ls[0] === undefined) return "no runs-on";
  for (const l of ls) {
    if (typeof l !== "string") return `label ${JSON.stringify(l)} is not a literal string`;
    if (l.includes("${{")) return `label ${l} is computed`;
    if (OTHER_REPO_ONLY_LABELS.includes(l)) return `label ${l} is registered only for another repository`;
  }
  if (ls.includes("self-hosted")) return "loop-closer has no self-hosted runner registered";
  if (ls.length !== 1 || !GITHUB_HOSTED_LINUX.test(String(ls[0]))) {
    return `runs-on ${JSON.stringify(job["runs-on"])} is not a single GitHub-hosted Linux label`;
  }
  return null;
}

test("the estate image job targets a runner label available to loop-closer", () => {
  const wf = load("estate-image.yml");
  const jobs = wf["jobs"] as Obj;
  assert.ok(Object.keys(jobs).length > 0, "the estate image workflow has jobs");
  for (const [name, job] of Object.entries(jobs)) {
    assert.equal(unavailable(job as Obj), null, `job ${name}: ${unavailable(job as Obj)}`);
  }

  // Same runner family as loop-closer's ci, whose jobs do start.
  const ci = load("ci.yml");
  const ciLabels = new Set(Object.values(ci["jobs"] as Obj).flatMap((j) => labels(j as Obj)));
  for (const [name, job] of Object.entries(jobs)) {
    for (const l of labels(job as Obj)) {
      assert.ok(ciLabels.has(l), `job ${name}: label ${String(l)} is one ci.yml already runs on (${[...ciLabels].join(", ")})`);
    }
  }

  // The concurrency group that serialises image pushes stays as it was.
  assert.deepEqual(wf["concurrency"], { group: "estate-image", "cancel-in-progress": false });
});

test("a job that targets a runner label registered only for another repository is caught", () => {
  for (const runsOn of [
    ["self-hosted", "passband-ci"],
    ["self-hosted", "passband-ci", "aks"],
    "passband-ci",
    ["self-hosted", "linux"],
    "${{ vars.RUNNER }}",
    ["ubuntu-latest", "passband-ci"],
  ]) {
    assert.notEqual(unavailable({ "runs-on": runsOn }), null, `runs-on ${JSON.stringify(runsOn)} is rejected`);
  }
  assert.equal(unavailable({ "runs-on": "ubuntu-latest" }), null);
  assert.equal(unavailable({ "runs-on": "ubuntu-24.04" }), null);
});
