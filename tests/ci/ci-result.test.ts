// COND-278 acceptance (policy main-stays-green v1): every job main runs in the
// `ci` workflow, including the main-only publish's dry run
// `estate-image-dry-run`, runs on pull requests and gates the merge through
// one result job, `ci-result`, which needs every other ci job and fails unless
// each of them succeeded. Branch protection on main requires the `ci-result`
// check (strict), so a red, cancelled or skipped job blocks the merge without
// protection having to list each job by name. Static check of ci.yml: nothing
// here reaches GitHub or a runner.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
type Obj = Record<string, any>;

const ci = parse(readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8")) as Obj;
const jobs = ci["jobs"] as Obj;
const RESULT = "ci-result";

function list(v: unknown): string[] {
  return v === undefined ? [] : Array.isArray(v) ? v.map(String) : [String(v)];
}

test("ci runs on pull requests as well as on pushes to main", () => {
  const on = ci["on"] as Obj;
  assert.ok(on && "pull_request" in on, "ci.yml must trigger on pull_request");
  assert.ok(!("pull_request_target" in on), "never pull_request_target (docs/EXTERNAL-REVIEW.md §1)");
  assert.deepEqual(list((on["push"] as Obj)["branches"]), ["main"]);
});

test("estate-image-dry-run runs on pull requests (no event or branch guard)", () => {
  const dry = jobs["estate-image-dry-run"] as Obj;
  assert.ok(dry, "ci.yml has job estate-image-dry-run");
  assert.equal(dry["if"], undefined, "estate-image-dry-run must not be skipped on pull requests");
});

test("ci-result needs every other ci job, estate-image-dry-run included", () => {
  const result = jobs[RESULT] as Obj;
  assert.ok(result, `ci.yml has job ${RESULT}`);
  const others = Object.keys(jobs).filter((j) => j !== RESULT).sort();
  assert.deepEqual([...list(result["needs"])].sort(), others);
  assert.ok(list(result["needs"]).includes("estate-image-dry-run"));
});

test("ci-result always reports and fails unless every needed job succeeded", () => {
  const result = jobs[RESULT] as Obj;
  assert.equal(result["name"] ?? RESULT, RESULT, "the check name branch protection requires");
  assert.match(String(result["if"]), /^\s*(\$\{\{\s*)?always\(\)(\s*\}\})?\s*$/, "runs even when a needed job fails, so the check is never skipped");
  assert.deepEqual(result["runs-on"], ["self-hosted", "aks"]);
  assert.deepEqual(result["permissions"], {});
  const steps = result["steps"] as Obj[];
  const failing = steps.find((s) => /\bexit 1\b/.test(String(s["run"] ?? "")));
  assert.ok(failing, "a step fails the job");
  const cond = String(failing["if"]);
  for (const r of ["failure", "cancelled", "skipped"]) {
    assert.ok(cond.includes(`contains(needs.*.result, '${r}')`), `fails when a needed job's result is ${r}`);
  }
});
