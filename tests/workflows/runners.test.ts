// LC-EST-PUBLISH-RUNNER acceptance: every job in .github/workflows runs on the
// self-hosted ARC org scale set noncelogic-org (runs-on [self-hosted, aks]),
// never on a GitHub-hosted runner (Rule: policies/placement-defaults.yaml#estate,
// policy no-github-hosted-runners). A GitHub-hosted runner cannot reach the
// estate OpenBao, so the estate-image publish could not log in for its push
// credential. The scale set's runner image has no node and no system python,
// so every job that runs node or npm installs node with actions/setup-node
// first. Static check of the workflow files: nothing here reaches GitHub, a
// runner, a registry or OpenBao.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const WORKFLOWS = join(repoRoot, ".github", "workflows");
type Obj = Record<string, any>;

/** The labels of the ARC org scale set noncelogic-org (meta-harness devops/aks/ci-runners/arc/org-values.yaml). */
export const ORG_SCALE_SET = ["self-hosted", "aks"] as const;

// GitHub-hosted runner labels (Linux, Windows, macOS, larger runners).
const GITHUB_HOSTED = /^(ubuntu|windows|macos)-/;

function workflows(): [string, Obj][] {
  return readdirSync(WORKFLOWS)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((f) => [f, parse(readFileSync(join(WORKFLOWS, f), "utf8")) as Obj]);
}

/** Why a job does not run on the org scale set, or null when it does. */
export function offScaleSet(job: Obj): string | null {
  const runsOn = job["runs-on"];
  if (runsOn === undefined) return "no runs-on";
  if (typeof runsOn === "object" && !Array.isArray(runsOn)) return `runs-on ${JSON.stringify(runsOn)} is not a label list`;
  const ls: unknown[] = Array.isArray(runsOn) ? runsOn : [runsOn];
  for (const l of ls) {
    if (typeof l !== "string") return `label ${JSON.stringify(l)} is not a literal string`;
    if (l.includes("${{")) return `label ${l} is computed`;
    if (GITHUB_HOSTED.test(l)) return `label ${l} is a GitHub-hosted runner`;
  }
  if (ls.length !== ORG_SCALE_SET.length || ORG_SCALE_SET.some((l, i) => ls[i] !== l)) {
    return `runs-on ${JSON.stringify(runsOn)} is not the org scale set ${JSON.stringify(ORG_SCALE_SET)}`;
  }
  return null;
}

/**
 * Index of the first step whose shell runs node, npm or npx on the runner
 * itself (as a command, not as an argument such as a container's command), or -1.
 */
function firstNodeStep(steps: Obj[]): number {
  return steps.findIndex((s) => /(^|[;&|(]|\$\()\s*(node|npm|npx)\s/m.test(String(s["run"] ?? "")));
}

test("no workflow job runs on a GitHub-hosted runner", () => {
  const all = workflows();
  const names = all.map(([f]) => f);
  for (const expected of ["ci.yml", "estate-image.yml"]) assert.ok(names.includes(expected), `${expected} exists`);

  let jobs = 0;
  for (const [file, wf] of all) {
    for (const [name, job] of Object.entries((wf["jobs"] ?? {}) as Obj)) {
      jobs++;
      const why = offScaleSet(job as Obj);
      assert.equal(why, null, `${file} job ${name}: ${why}`);

      // The scale set's runner image ships no node: a job that runs node or
      // npm installs it first.
      const steps = ((job as Obj)["steps"] ?? []) as Obj[];
      const nodeIdx = firstNodeStep(steps);
      if (nodeIdx >= 0) {
        const setupIdx = steps.findIndex((s) => String(s["uses"] ?? "").startsWith("actions/setup-node@"));
        assert.ok(setupIdx >= 0 && setupIdx < nodeIdx, `${file} job ${name} runs node, so it sets up node first`);
      }
    }
  }
  assert.ok(jobs > 0, "the workflows have jobs");

  // The publish that deploy step CLOSER-249 waits on is one of them.
  const publish = ((all.find(([f]) => f === "estate-image.yml")![1]["jobs"] as Obj)["publish"]) as Obj;
  assert.deepEqual(publish["runs-on"], [...ORG_SCALE_SET]);
});

test("a job off the org scale set is caught", () => {
  for (const runsOn of [
    "ubuntu-latest",
    "ubuntu-24.04",
    ["ubuntu-latest"],
    "windows-latest",
    "macos-14",
    ["self-hosted", "ubuntu-latest"],
    ["self-hosted"],
    "self-hosted",
    ["self-hosted", "passband-ci"],
    ["self-hosted", "aks", "passband-ci"],
    ["aks", "self-hosted"],
    "${{ vars.RUNNER }}",
    { group: "large" },
    undefined,
  ]) {
    assert.notEqual(offScaleSet({ "runs-on": runsOn }), null, `runs-on ${JSON.stringify(runsOn)} is rejected`);
  }
  assert.equal(offScaleSet({ "runs-on": ["self-hosted", "aks"] }), null);
});
