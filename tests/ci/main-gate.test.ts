// COND-276 acceptance (policy main-stays-green v1): every job ci.yml runs on a
// push to main is proven on the pull request. ci.yml runs on pull_request,
// and its `ci-result` job needs every other ci.yml job, including
// `manifests`, so the one required status check on main (`ci-result`, strict;
// docs/EXTERNAL-REVIEW.md "Enforcement map") fails when any of them fails, is
// cancelled or is skipped. The gate step's own script, as ci.yml has it, is
// run with bash against controlled dependency results; nothing here reaches
// GitHub or a runner.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
type Obj = Record<string, any>;

/** The job branch protection on main requires. */
export const RESULT_JOB = "ci-result";

function ci(): Obj {
  return parse(readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8")) as Obj;
}

function triggers(wf: Obj): string[] {
  const on = wf["on"];
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.map(String);
  return Object.keys(on ?? {});
}

/** Why `result` does not gate on every other job, or null when it does. */
export function gateGap(jobs: Obj): string | null {
  const result = jobs[RESULT_JOB] as Obj | undefined;
  if (!result) return `no ${RESULT_JOB} job`;
  const needs: unknown[] = Array.isArray(result["needs"]) ? result["needs"] : result["needs"] ? [result["needs"]] : [];
  const missing = Object.keys(jobs).filter((j) => j !== RESULT_JOB && !needs.includes(j));
  if (missing.length) return `${RESULT_JOB} does not need ${missing.join(", ")}`;
  // It must run (and fail) when a needed job fails, is cancelled or skipped;
  // a skipped required check would otherwise count as passing.
  if (!/\balways\(\)/.test(String(result["if"] ?? ""))) return `${RESULT_JOB} does not run if: always()`;
  return null;
}

test("ci.yml runs on pull requests and on push to main", () => {
  const on = triggers(ci());
  assert.ok(on.includes("pull_request"), "ci.yml runs on pull_request");
  assert.ok(!on.includes("pull_request_target"), "never pull_request_target");
  assert.ok(on.includes("push"), "ci.yml runs on push to main");
});

test("the required ci-result job needs every ci.yml job, manifests included", () => {
  const jobs = ci()["jobs"] as Obj;
  assert.ok(jobs["manifests"], "ci.yml has the manifests job");
  assert.equal(gateGap(jobs), null);
  const result = jobs[RESULT_JOB] as Obj;
  // No job is skipped on a pull request, so the required check covers it there.
  for (const [name, job] of Object.entries(jobs)) {
    if (name === RESULT_JOB) continue;
    assert.equal((job as Obj)["if"], undefined, `${name} runs unconditionally, on pull requests too`);
  }
  assert.deepEqual(result["permissions"], {}, `${RESULT_JOB} needs no token scope`);
});

test("a gap in the gate is caught", () => {
  const ok = { a: {}, manifests: {}, [RESULT_JOB]: { needs: ["a", "manifests"], if: "always()" } };
  assert.equal(gateGap(ok), null);
  assert.match(gateGap({ a: {}, manifests: {} })!, /no ci-result/);
  assert.match(gateGap({ ...ok, [RESULT_JOB]: { ...ok[RESULT_JOB], needs: ["a"] } })!, /manifests/);
  assert.match(gateGap({ ...ok, [RESULT_JOB]: { ...ok[RESULT_JOB], if: undefined } })!, /always/);
});

/** The ci-result step that decides the check: its script and how GitHub runs it. */
function gateStep(): { run: string; shell: string; results: string } {
  const steps = ((ci()["jobs"] as Obj)[RESULT_JOB]["steps"] ?? []) as Obj[];
  assert.equal(steps.length, 1, `${RESULT_JOB} has exactly one step, the gate`);
  const step = steps[0] as Obj;
  return { run: String(step["run"] ?? ""), shell: String(step["shell"] ?? ""), results: String(step["env"]?.["RESULTS"] ?? "") };
}

/** GitHub's toJSON of needs.*.result: a pretty-printed array, one entry per need. */
function toJSON(results: string[]): string {
  return JSON.stringify(results, null, 2);
}

/** Runs the gate script exactly as ci.yml has it, the way `shell: bash` runs it on the runner. */
function runGate(run: string, results: string): number {
  const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", run], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", RESULTS: results },
    encoding: "utf8",
  });
  assert.equal(r.error, undefined, String(r.error));
  return r.status ?? -1;
}

/** Why the gate script `run` does not pass exactly when all `needs` results are success, or null. */
function gateFlaw(run: string, needs: number): string | null {
  const allPass = Array<string>(needs).fill("success");
  if (runGate(run, toJSON(allPass)) !== 0) return "fails when every needed job succeeded";
  const bad: [string, string][] = [];
  for (const outcome of ["failure", "cancelled", "skipped"]) {
    for (let i = 0; i < needs; i++) {
      const one = [...allPass];
      one[i] = outcome;
      bad.push([toJSON(one), `needed job ${i} ${outcome}`]);
    }
    bad.push([toJSON(Array(needs).fill(outcome)), `every needed job ${outcome}`]);
  }
  bad.push(
    [toJSON([]), "no results"],
    ["", "RESULTS unset"],
    [toJSON([...allPass.slice(1), ""]), "an empty result"],
    [toJSON([...allPass.slice(1), "successful"]), "a result other than exactly success"],
  );
  for (const [results, what] of bad) if (runGate(run, results) === 0) return `passes with ${what}`;
  return null;
}

test("the ci-result step passes only when every needed job succeeded", () => {
  const { run, shell, results } = gateStep();
  assert.equal(shell, "bash");
  assert.equal(results.replace(/\s+/g, ""), "${{toJSON(needs.*.result)}}", "RESULTS carries every needed job's result");
  assert.ok(!run.includes("${{"), "the script decides from RESULTS alone, so what runs here is what runs on the runner");

  const needs = ((ci()["jobs"] as Obj)[RESULT_JOB]["needs"] as string[]).length;
  assert.equal(gateFlaw(run, needs), null);
});

test("a gate script that only reports results, or misses one outcome, is caught", () => {
  assert.match(gateFlaw('echo "needed job results: $RESULTS"', 3)!, /failure/);
  assert.match(gateFlaw('case "$RESULTS" in *failure*) exit 1;; esac', 3)!, /cancelled/);
  assert.match(gateFlaw("false", 3)!, /every needed job succeeded/);
});
