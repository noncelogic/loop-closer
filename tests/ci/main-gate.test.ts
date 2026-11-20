// COND-276 acceptance (policy main-stays-green v1): every job ci.yml runs on a
// push to main is proven on the pull request. ci.yml runs on pull_request,
// and its result job `gate` needs every other ci.yml job, including
// `manifests`, so the one required status check on main (`gate`, strict;
// docs/EXTERNAL-REVIEW.md "Enforcement map") fails when any of them fails, is
// cancelled or is skipped. The gate's decision script itself is exercised in
// tests/ci/required-gate.test.ts. Nothing here reaches GitHub or a runner.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
type Obj = Record<string, any>;

/** The job branch protection on main requires. */
export const RESULT_JOB = "gate";

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

test("the required gate job needs every ci.yml job, manifests included", () => {
  const jobs = ci()["jobs"] as Obj;
  assert.ok(jobs["manifests"], "ci.yml has the manifests job");
  assert.equal(gateGap(jobs), null);
  // No job is skipped on a pull request, so the required check covers it there.
  for (const [name, job] of Object.entries(jobs)) {
    if (name === RESULT_JOB) continue;
    assert.equal((job as Obj)["if"], undefined, `${name} runs unconditionally, on pull requests too`);
  }
});

test("a gap in the gate is caught", () => {
  const ok = { a: {}, manifests: {}, [RESULT_JOB]: { needs: ["a", "manifests"], if: "always()" } };
  assert.equal(gateGap(ok), null);
  assert.match(gateGap({ a: {}, manifests: {} })!, /no gate/);
  assert.match(gateGap({ ...ok, [RESULT_JOB]: { ...ok[RESULT_JOB], needs: ["a"] } })!, /manifests/);
  assert.match(gateGap({ ...ok, [RESULT_JOB]: { ...ok[RESULT_JOB], if: undefined } })!, /always/);
});
