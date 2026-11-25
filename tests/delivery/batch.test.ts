// COND-344 acceptance (owner INTENTS I67, DELIVERY-GUARANTEE-CHECK; Rule:
// policies/placement-defaults.yaml#gates): loop-closer's delivery guarantee is
// `batch`. delivery.yaml declares deploy_queue.interval_seconds, one fixed
// interval for the product, and the end-to-end suite runs once per batch: the
// delivery-batch workflow fires on that interval (its cron is derived from the
// declared seconds), its runs never overlap, and its E2E job runs only when
// main moved since the last successful batch, never per push or per pull
// request: the test files each workflow step executes are resolved from
// package.json's scripts and node --test patterns, and no ci.yml or
// estate-image.yml step selects an E2E file. The interval is an estimate, so the declaration carries its basis
// and the measurement that revisits it (estimates-are-measured-and-revisited).
// The batch decision is exercised through .github/scripts/delivery-batch.mjs
// with a strict fake transport; nothing here reaches GitHub or a runner.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { batchDecision, BATCH_WORKFLOW } from "../../.github/scripts/delivery-batch.mjs";

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
type Obj = Record<string, any>;

function yamlFile(...parts: string[]): Obj {
  return parse(readFileSync(join(repoRoot, ...parts), "utf8")) as Obj;
}

/** The schedule a fixed interval in seconds runs on, as a GitHub cron line; throws when cron cannot express it exactly. */
export function cronFor(seconds: number): string {
  if (!Number.isInteger(seconds) || seconds <= 0) throw new Error(`interval ${seconds} is not a positive integer`);
  if (seconds % 60 !== 0) throw new Error(`interval ${seconds}s is not a whole number of minutes`);
  const minutes = seconds / 60;
  // GitHub runs schedules no more often than every 5 minutes.
  if (minutes < 5) throw new Error(`interval ${seconds}s is below GitHub's 5-minute schedule floor`);
  if (minutes < 60) {
    if (60 % minutes !== 0) throw new Error(`interval ${minutes}m does not divide an hour`);
    return `*/${minutes} * * * *`;
  }
  if (minutes % 60 !== 0) throw new Error(`interval ${minutes}m is not a whole number of hours`);
  const hours = minutes / 60;
  if (hours === 1) return "0 * * * *";
  if (hours < 24 && 24 % hours === 0) return `0 */${hours} * * *`;
  if (hours === 24) return "0 0 * * *";
  throw new Error(`interval ${hours}h does not divide a day`);
}

/** Why a delivery declaration does not state a batch guarantee with a fixed interval, or null when it does. */
export function declarationGap(d: Obj): string | null {
  if (d["delivery_guarantee"] !== "batch") return `delivery_guarantee is ${JSON.stringify(d["delivery_guarantee"])}, not batch`;
  const q = d["deploy_queue"] as Obj | undefined;
  if (!q || typeof q !== "object") return "no deploy_queue";
  const s = q["interval_seconds"];
  if (typeof s !== "number" || !Number.isInteger(s) || s <= 0) return "deploy_queue.interval_seconds is not a positive integer";
  try {
    cronFor(s);
  } catch (err) {
    return (err as Error).message;
  }
  for (const k of ["basis", "revisit"]) {
    if (typeof q[k] !== "string" || !q[k].trim()) return `deploy_queue.${k} is not stated`;
  }
  const e2e = d["e2e"] as Obj | undefined;
  if (!e2e || e2e["runs"] !== "once_per_batch") return "e2e.runs is not once_per_batch";
  if (typeof e2e["workflow"] !== "string" || typeof e2e["job"] !== "string") return "e2e names no workflow job";
  return null;
}

/** Why a workflow does not run its E2E job once per batch at `seconds`, or null when it does. */
export function batchGap(wf: Obj, job: string, seconds: number): string | null {
  const on = (wf["on"] ?? {}) as Obj;
  const triggers = typeof on === "string" ? [on] : Object.keys(on);
  const extra = triggers.filter((t) => t !== "schedule" && t !== "workflow_dispatch");
  if (extra.length) return `runs on ${extra.join(", ")}, not only on its schedule`;
  const crons = ((on["schedule"] ?? []) as Obj[]).map((s) => s["cron"]);
  if (crons.length !== 1 || crons[0] !== cronFor(seconds)) {
    return `schedule ${JSON.stringify(crons)} is not the declared interval's ${JSON.stringify(cronFor(seconds))}`;
  }
  const c = wf["concurrency"] as Obj | undefined;
  if (!c || !c["group"] || String(c["group"]).includes("${{") || c["cancel-in-progress"] !== false) {
    return "batches are not serialised in one fixed concurrency group that never cancels a run in progress";
  }
  const e2e = ((wf["jobs"] ?? {}) as Obj)[job] as Obj | undefined;
  if (!e2e) return `no ${job} job`;
  const needs: unknown[] = Array.isArray(e2e["needs"]) ? e2e["needs"] : e2e["needs"] ? [e2e["needs"]] : [];
  if (!needs.includes("batch")) return `${job} does not need the batch job`;
  if (!/needs\.batch\.outputs\.run\s*==\s*'true'/.test(String(e2e["if"] ?? ""))) return `${job} does not run only on a non-empty batch`;
  if (e2e["strategy"]) return `${job} has a matrix, so it runs more than once per batch`;
  return null;
}

test("delivery.yaml declares a batch guarantee with a fixed deploy_queue interval", () => {
  const d = yamlFile("delivery.yaml");
  assert.equal(declarationGap(d), null);
  assert.equal(d["e2e"]["workflow"], `.github/workflows/${BATCH_WORKFLOW}`);
});

test("the delivery-batch workflow runs E2E once per declared interval", () => {
  const d = yamlFile("delivery.yaml");
  const wf = yamlFile(d["e2e"]["workflow"]);
  assert.equal(batchGap(wf, d["e2e"]["job"], d["deploy_queue"]["interval_seconds"]), null);
  // The batch job asks GitHub only to read the last successful batch.
  const batch = wf["jobs"]["batch"] as Obj;
  assert.deepEqual(batch["permissions"], { actions: "read", contents: "read" });
});

/** Split a shell command line into words, honouring single and double quotes (no expansion). */
function words(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3]!);
  return out;
}

/**
 * The test files a workflow `run:` command executes: `npm test` and `npm run <script>` resolve through
 * package.json's scripts, and `node --test <patterns>` expands its patterns the way node does (fs.globSync
 * from the repository root). Any other command executes no test file.
 */
export function testSelection(command: string, scripts: Record<string, string>, seen: string[] = []): string[] {
  const files = new Set<string>();
  for (const part of command.split(/\n|&&|\|\||;/)) {
    const w = words(part.trim());
    let script: string | undefined;
    if (w[0] === "npm" && (w[1] === "test" || w[1] === "t")) script = "test";
    else if (w[0] === "npm" && (w[1] === "run" || w[1] === "run-script") && w[2]) script = w[2];
    if (script !== undefined) {
      if (seen.includes(script)) throw new Error(`npm script ${script} runs itself`);
      const body = scripts[script];
      if (body === undefined) throw new Error(`no npm script ${script}`);
      for (const f of testSelection(body, scripts, [...seen, script])) files.add(f);
      continue;
    }
    if (w[0] === "node" && w.includes("--test")) {
      for (const arg of w.slice(1).filter((a) => !a.startsWith("-"))) {
        for (const f of globSync(arg, { cwd: repoRoot })) files.add(f.split("\\").join("/"));
      }
    }
  }
  return [...files].sort();
}

/** Every `run:` command of a workflow's jobs, keyed by job. */
function runCommands(wf: Obj): Array<{ job: string; run: string }> {
  const out: Array<{ job: string; run: string }> = [];
  for (const [job, spec] of Object.entries((wf["jobs"] ?? {}) as Obj)) {
    for (const step of ((spec as Obj)["steps"] ?? []) as Obj[]) if (typeof step["run"] === "string") out.push({ job, run: step["run"] });
  }
  return out;
}

const scripts = (JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as Obj)["scripts"] as Record<string, string>;

test("E2E runs only in the batch, never in a per-push or per-pull-request test selection", () => {
  const d = yamlFile("delivery.yaml");
  const e2eFiles = testSelection(d["e2e"]["command"], scripts);
  assert.ok(e2eFiles.length > 0, `${d["e2e"]["command"]} selects no test file`);

  // The batch's E2E job executes exactly the declared E2E selection, once.
  const batchWf = yamlFile(d["e2e"]["workflow"]);
  const byJob = new Map<string, string[]>();
  for (const { job, run } of runCommands(batchWf)) byJob.set(job, [...(byJob.get(job) ?? []), ...testSelection(run, scripts)]);
  assert.deepEqual(byJob.get(d["e2e"]["job"]), e2eFiles, `${d["e2e"]["job"]} runs the E2E selection once`);
  for (const [job, files] of byJob) if (job !== d["e2e"]["job"]) assert.deepEqual(files, [], `${job} runs no test`);

  // No per-push or per-pull-request workflow step executes any E2E file.
  let selected = 0;
  for (const f of ["ci.yml", "estate-image.yml"]) {
    for (const { job, run } of runCommands(yamlFile(".github", "workflows", f))) {
      const files = testSelection(run, scripts);
      selected += files.length;
      const overlap = files.filter((x) => e2eFiles.includes(x));
      assert.deepEqual(overlap, [], `${f} job ${job} (${JSON.stringify(run)}) runs E2E files`);
    }
    assert.equal((yamlFile(".github", "workflows", f)["jobs"] as Obj)[d["e2e"]["job"]], undefined, `${f} has no ${d["e2e"]["job"]} job`);
  }
  // The per-pull-request suite still runs (the selection is resolved, not empty).
  assert.ok(selected > 0, "ci.yml selects no test file at all");
});

test("test selection resolves npm scripts and node --test patterns", () => {
  const s = { test: 'node --test "tests/delivery/*.test.ts"', all: "npm test && npm run e2e", e2e: "node --test nope/*.e2e.ts", loop: "npm run loop" };
  assert.deepEqual(testSelection("npm test", s), ["tests/delivery/batch.test.ts"]);
  assert.deepEqual(testSelection("npm run all", s), ["tests/delivery/batch.test.ts"]);
  assert.deepEqual(testSelection("node --test tests/delivery/batch.test.ts", s), ["tests/delivery/batch.test.ts"]);
  assert.deepEqual(testSelection("npm ci --ignore-scripts\nnpm run lint", { ...s, lint: "echo lint" }), []);
  assert.throws(() => testSelection("npm run loop", s), /runs itself/);
  assert.throws(() => testSelection("npm run missing", s), /no npm script missing/);
});

test("cron is derived exactly from the interval", () => {
  assert.equal(cronFor(300), "*/5 * * * *");
  assert.equal(cronFor(1800), "*/30 * * * *");
  assert.equal(cronFor(3600), "0 * * * *");
  assert.equal(cronFor(4 * 3600), "0 */4 * * *");
  assert.equal(cronFor(86400), "0 0 * * *");
  for (const bad of [0, -60, 90, 120, 420, 5400, 5 * 3600, 2 * 86400, 1.5]) assert.throws(() => cronFor(bad), `${bad} rejected`);
});

test("a declaration or workflow that does not batch is caught", () => {
  const ok = {
    delivery_guarantee: "batch",
    deploy_queue: { interval_seconds: 3600, basis: "b", revisit: "r" },
    e2e: { runs: "once_per_batch", workflow: "w", job: "e2e" },
  };
  assert.equal(declarationGap(ok), null);
  assert.match(declarationGap({ ...ok, delivery_guarantee: "per_merge" })!, /not batch/);
  assert.match(declarationGap({ ...ok, deploy_queue: undefined })!, /no deploy_queue/);
  assert.match(declarationGap({ ...ok, deploy_queue: { ...ok.deploy_queue, interval_seconds: "1h" } })!, /positive integer/);
  assert.match(declarationGap({ ...ok, deploy_queue: { ...ok.deploy_queue, interval_seconds: 90 } })!, /minutes/);
  assert.match(declarationGap({ ...ok, deploy_queue: { ...ok.deploy_queue, revisit: "" } })!, /revisit/);
  assert.match(declarationGap({ ...ok, e2e: { ...ok.e2e, runs: "per_merge" } })!, /once_per_batch/);

  const wf = {
    on: { schedule: [{ cron: "0 * * * *" }], workflow_dispatch: {} },
    concurrency: { group: "delivery-batch", "cancel-in-progress": false },
    jobs: { batch: {}, e2e: { needs: "batch", if: "needs.batch.outputs.run == 'true'" } },
  };
  assert.equal(batchGap(wf, "e2e", 3600), null);
  assert.match(batchGap({ ...wf, on: { ...wf.on, push: {} } }, "e2e", 3600)!, /push/);
  assert.match(batchGap({ ...wf, on: { ...wf.on, pull_request: {} } }, "e2e", 3600)!, /pull_request/);
  assert.match(batchGap(wf, "e2e", 1800)!, /schedule/);
  assert.match(batchGap({ ...wf, concurrency: { group: "g", "cancel-in-progress": true } }, "e2e", 3600)!, /serialised/);
  assert.match(batchGap({ ...wf, concurrency: undefined }, "e2e", 3600)!, /serialised/);
  assert.match(batchGap({ ...wf, jobs: { batch: {}, e2e: { needs: "batch" } } }, "e2e", 3600)!, /non-empty batch/);
  assert.match(batchGap({ ...wf, jobs: { batch: {}, e2e: { if: "true" } } }, "e2e", 3600)!, /need the batch/);
  assert.match(batchGap({ ...wf, jobs: { batch: {} } }, "e2e", 3600)!, /no e2e/);
});

const REPO = "noncelogic/loop-closer";
const RUNS_URL = `https://api.github.com/repos/${REPO}/actions/workflows/${BATCH_WORKFLOW}/runs?branch=main&status=success&per_page=1`;

/** A fake GitHub that answers only the last-successful-batch read, and fails any other request. */
function github(response: { status: number; body: unknown }, seen: string[]) {
  return async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    seen.push(u);
    if (u !== RUNS_URL) throw new Error(`unexpected request ${u}`);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer t0ken");
    return new Response(JSON.stringify(response.body), { status: response.status });
  };
}

test("a batch runs E2E when main moved since the last successful batch", async () => {
  const seen: string[] = [];
  const fetch = github({ status: 200, body: { total_count: 3, workflow_runs: [{ id: 7, head_sha: "aaa" }] } }, seen);
  const d = await batchDecision({ repo: REPO, headSha: "bbb", token: "t0ken", fetch });
  assert.deepEqual(d, { run: true, since: "aaa" });
  assert.deepEqual(seen, [RUNS_URL]);
});

test("an empty batch (main unchanged since the last successful batch) skips E2E", async () => {
  const fetch = github({ status: 200, body: { total_count: 3, workflow_runs: [{ id: 7, head_sha: "bbb" }] } }, []);
  assert.deepEqual(await batchDecision({ repo: REPO, headSha: "bbb", token: "t0ken", fetch }), { run: false, since: "bbb" });
});

test("the first batch runs E2E", async () => {
  const fetch = github({ status: 200, body: { total_count: 0, workflow_runs: [] } }, []);
  assert.deepEqual(await batchDecision({ repo: REPO, headSha: "bbb", token: "t0ken", fetch }), { run: true, since: null });
});

test("an unreadable batch history fails loudly instead of guessing", async () => {
  const fetch = github({ status: 403, body: { message: "Resource not accessible" } }, []);
  await assert.rejects(batchDecision({ repo: REPO, headSha: "bbb", token: "t0ken", fetch }), /HTTP 403/);
  const malformed = github({ status: 200, body: { workflow_runs: "nope" } }, []);
  await assert.rejects(batchDecision({ repo: REPO, headSha: "bbb", token: "t0ken", fetch: malformed }), /workflow_runs/);
  await assert.rejects(batchDecision({ repo: REPO, headSha: "", token: "t0ken", fetch: malformed }), /head sha/);
});
