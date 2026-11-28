// COND-343 acceptance (owner INTENTS I67, DELIVERY-GUARANTEE-CHECK; Rule:
// policies/placement-defaults.yaml#gates): a required fast unit check runs on
// every pull request. delivery.yaml declares `merge.unit`: the ci.yml job that
// runs it, its command and its time budget. That job runs on every pull
// request with no guard, the required status check `gate` needs it, it does
// nothing but install dependencies and run the unit command (no image build,
// no Kubernetes tools, no Postgres), and its job timeout is the declared
// budget. The unit selection (resolved from package.json the way npm and node
// do) is non-empty, holds no E2E file or journey, and is run here for real
// with node alone on PATH (no docker, kubectl or git) and must exit 0. The
// job's timeout-minutes enforces the budget on the runner; here the declared
// budget only guards against a hang. Nothing here reaches GitHub or a runner.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { repoRoot, runCommands, testSelection } from "./selection.ts";

type Obj = Record<string, any>;

function yamlFile(...parts: string[]): Obj {
  return parse(readFileSync(join(repoRoot, ...parts), "utf8")) as Obj;
}

const scripts = (JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as Obj)["scripts"] as Record<string, string>;
const REQUIRED_CHECK = "gate";

function list(v: unknown): string[] {
  return v === undefined || v === null ? [] : Array.isArray(v) ? v.map(String) : [String(v)];
}

/** Why a `merge.unit` declaration is incomplete, or null when it names a workflow job, a command and a budget. */
export function unitDeclarationGap(d: Obj): string | null {
  const u = (d["merge"] as Obj | undefined)?.["unit"] as Obj | undefined;
  if (!u || typeof u !== "object") return "no merge.unit";
  for (const k of ["workflow", "job", "command"]) if (typeof u[k] !== "string" || !u[k].trim()) return `merge.unit.${k} is not stated`;
  if (u["required"] !== true) return "merge.unit is not required";
  const m = u["timeout_minutes"];
  if (typeof m !== "number" || !Number.isInteger(m) || m <= 0 || m > 5) return "merge.unit.timeout_minutes is not a whole number of minutes from 1 to 5";
  return null;
}

/** Why `job` of workflow `wf` is not a required, fast, pull-request unit check running `command`, or null when it is. */
export function unitJobGap(wf: Obj, job: string, command: string, minutes: number): string | null {
  const on = wf["on"] ?? {};
  const triggers = typeof on === "string" ? [on] : Array.isArray(on) ? on : Object.keys(on as Obj);
  if (!triggers.includes("pull_request")) return "the workflow does not run on pull_request";
  const jobs = (wf["jobs"] ?? {}) as Obj;
  const spec = jobs[job] as Obj | undefined;
  if (!spec) return `no ${job} job`;
  if (spec["if"] !== undefined) return `${job} is conditional (if: ${spec["if"]})`;
  const gate = jobs[REQUIRED_CHECK] as Obj | undefined;
  if (!gate || !list(gate["needs"]).includes(job)) return `the required check ${REQUIRED_CHECK} does not need ${job}`;
  if (spec["timeout-minutes"] !== minutes) return `${job} timeout-minutes is ${spec["timeout-minutes"]}, not the declared ${minutes}`;
  const steps = (spec["steps"] ?? []) as Obj[];
  const uses = steps.map((s) => s["uses"]).filter((u): u is string => typeof u === "string");
  const extra = uses.filter((u) => !/^actions\/(checkout|setup-node)@/.test(u));
  if (extra.length) return `${job} uses ${extra.join(", ")}`;
  const runs = steps.map((s) => s["run"]).filter((r): r is string => typeof r === "string").map((r) => r.trim());
  if (!runs.includes(command)) return `${job} does not run ${command}`;
  const other = runs.filter((r) => r !== command && r !== "npm ci --ignore-scripts");
  if (other.length) return `${job} also runs ${other.join("; ")}`;
  return null;
}

/**
 * Why a run of the unit selection fails the check, or null when it exited 0. Judged by exit status alone: elapsed
 * wall-clock time depends on the runner's load and clock, so the runtime budget is the CI job's timeout-minutes
 * (unitJobGap), and the spawn's timeout here is only a hang guard.
 */
export function unitRunGap(r: { status: number | null; stdout: string; stderr: string }): string | null {
  if (r.status !== 0) return `the unit selection failed with node alone on PATH (exit ${r.status}):\n${r.stdout}\n${r.stderr}`;
  return null;
}

test("delivery.yaml declares the required fast unit check", () => {
  assert.equal(unitDeclarationGap(yamlFile("delivery.yaml")), null);
});

test("ci.yml runs the declared unit check on every pull request, under the required gate, and nothing else", () => {
  const u = yamlFile("delivery.yaml")["merge"]["unit"] as Obj;
  assert.equal(u["workflow"], ".github/workflows/ci.yml");
  assert.equal(unitJobGap(yamlFile(u["workflow"]), u["job"], u["command"], u["timeout_minutes"]), null);
});

test("the unit selection is non-empty, inside the per-pull-request suite, and holds no E2E file or journey", () => {
  const u = yamlFile("delivery.yaml")["merge"]["unit"] as Obj;
  const unit = testSelection(u["command"], scripts);
  assert.ok(unit.length > 0, `${u["command"]} selects no test file`);
  assert.deepEqual(unit.filter((f) => !f.endsWith(".test.ts")), [], "the unit selection holds only *.test.ts files");
  const npmTest = testSelection("npm test", scripts);
  assert.deepEqual(unit.filter((f) => !npmTest.includes(f)), [], "every unit file is also in npm test");
  assert.ok(!unit.includes("tests/delivery/merge-unit.test.ts"), "the unit selection does not run this check of itself");
  // The job's steps select exactly the unit files.
  const wf = yamlFile(u["workflow"]);
  const selected = runCommands(wf).filter(({ job }) => job === u["job"]).flatMap(({ run }) => testSelection(run, scripts));
  assert.deepEqual(selected.sort(), unit);
});

test("the unit selection passes with node alone on PATH", () => {
  const u = yamlFile("delivery.yaml")["merge"]["unit"] as Obj;
  const unit = testSelection(u["command"], scripts);
  const bin = mkdtempSync(join(tmpdir(), "lc-unit-path-"));
  try {
    // Only node is reachable: a unit file that starts docker, kubectl, git or a Postgres client fails here.
    symlinkSync(process.execPath, join(bin, "node"));
    // The timeout is a hang guard only; the CI job's timeout-minutes enforces the budget.
    const r = spawnSync(join(bin, "node"), ["--test", ...unit], {
      cwd: repoRoot,
      env: { PATH: bin, HOME: bin, TMPDIR: tmpdir() },
      encoding: "utf8",
      timeout: u["timeout_minutes"] * 60_000,
    });
    assert.equal(unitRunGap(r), null);
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

test("a unit check that is missing, guarded, unrequired, slow or doing more is caught", () => {
  const ok = { merge: { unit: { workflow: "w", job: "unit", command: "npm run test:unit", required: true, timeout_minutes: 5 } } };
  assert.equal(unitDeclarationGap(ok), null);
  assert.match(unitDeclarationGap({})!, /no merge\.unit/);
  assert.match(unitDeclarationGap({ merge: { unit: { ...ok.merge.unit, command: "" } } })!, /command/);
  assert.match(unitDeclarationGap({ merge: { unit: { ...ok.merge.unit, required: false } } })!, /not required/);
  assert.match(unitDeclarationGap({ merge: { unit: { ...ok.merge.unit, timeout_minutes: 30 } } })!, /timeout_minutes/);

  const steps = [{ uses: "actions/checkout@v4" }, { uses: "actions/setup-node@v4" }, { run: "npm ci --ignore-scripts" }, { run: "npm run test:unit" }];
  const wf = { on: { pull_request: null }, jobs: { unit: { "timeout-minutes": 5, steps }, gate: { needs: ["unit"] } } };
  const gap = (w: Obj) => unitJobGap(w, "unit", "npm run test:unit", 5);
  assert.equal(gap(wf), null);
  assert.match(gap({ ...wf, on: { push: {} } })!, /pull_request/);
  assert.match(gap({ ...wf, jobs: { gate: { needs: [] } } })!, /no unit job/);
  assert.match(gap({ ...wf, jobs: { ...wf.jobs, unit: { ...wf.jobs.unit, if: "github.event_name == 'push'" } } })!, /conditional/);
  assert.match(gap({ ...wf, jobs: { ...wf.jobs, gate: { needs: ["test"] } } })!, /does not need unit/);
  assert.match(gap({ ...wf, jobs: { ...wf.jobs, unit: { ...wf.jobs.unit, "timeout-minutes": 15 } } })!, /timeout-minutes/);
  assert.match(gap({ ...wf, jobs: { ...wf.jobs, unit: { ...wf.jobs.unit, steps: [...steps, { uses: "docker/setup-buildx-action@v3" }] } } })!, /buildx/);
  assert.match(gap({ ...wf, jobs: { ...wf.jobs, unit: { ...wf.jobs.unit, steps: [...steps, { run: "npm test" }] } } })!, /also runs npm test/);
  assert.match(gap({ ...wf, jobs: { ...wf.jobs, unit: { ...wf.jobs.unit, steps: steps.slice(0, 3) } } })!, /does not run/);

  // A run is judged by its exit status alone: a passing selection slowed by a busy runner still passes; the job's
  // timeout-minutes (checked above) enforces the budget.
  assert.equal(unitRunGap({ status: 0, stdout: "", stderr: "" }), null);
  assert.match(unitRunGap({ status: 1, stdout: "not ok 1", stderr: "" })!, /exit 1[\s\S]*not ok 1/);
  assert.match(unitRunGap({ status: null, stdout: "", stderr: "" })!, /exit null/);
});
