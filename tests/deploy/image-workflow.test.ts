// LC-D1b acceptance: on merge to main, .github/workflows/estate-image.yml
// builds the loopcloser image and pushes it, tagged sha-<commit>, to the
// estate registry that aks-obs-01 pulls from. Since LC-EST-PUBLISH-RUNNER it
// runs on the ARC org scale set [self-hosted, aks] (tests/workflows/runners.test.ts); since
// LC-EST-IMAGE-PUBLISH it logs in to the registry with loop-closer's push
// credential from OpenBao, never repository secrets. Static check of the
// workflow file: nothing here runs a build, reaches a registry or reads a
// secret.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const WORKFLOW = join(repoRoot, ".github", "workflows", "estate-image.yml");

type Obj = Record<string, any>;

function load(): { text: string; wf: Obj } {
  const text = readFileSync(WORKFLOW, "utf8");
  return { text, wf: parse(text) as Obj };
}

function steps(job: Obj): Obj[] {
  return (job["steps"] ?? []) as Obj[];
}

test("the estate image workflow publishes from main only and logs in to the estate registry without repository secrets", () => {
  const { text, wf } = load();

  // Trigger: pushes to main only. No pull_request / pull_request_target /
  // workflow_run: the registry push credential must never be reachable from
  // unmerged code (docs/EXTERNAL-REVIEW.md §1).
  const on = wf["on"] as Obj;
  assert.deepEqual(Object.keys(on), ["push"], "only `push` triggers the estate image workflow");
  assert.deepEqual(on["push"], { branches: ["main"] }, "only pushes to main");

  // Least privilege: read the repo; only the publish job may also mint the
  // OIDC token OpenBao's JWT auth accepts.
  assert.deepEqual(wf["permissions"], { contents: "read" });

  const jobs = wf["jobs"] as Obj;
  assert.ok(Object.keys(jobs).length > 0, "the workflow has jobs");
  for (const [name, job] of Object.entries(jobs)) {
    const perms = job["permissions"];
    assert.ok(
      perms === undefined || (name === "publish" && JSON.stringify(perms) === JSON.stringify({ contents: "read", "id-token": "write" })),
      `job ${name} widens workflow permissions only to id-token: write on publish`,
    );
  }

  // No repository secret at all, no `secrets: inherit`, no github.token used
  // as a credential.
  assert.ok(!/\bsecrets\./.test(text), "the workflow reads no repository secret");
  assert.ok(!/secrets\s*:\s*inherit/.test(text), "the workflow never inherits secrets");
  assert.ok(!/github\.token/.test(text), "the workflow never uses github.token");

  const [jobName, job] = Object.entries(jobs).find(([, j]) =>
    steps(j as Obj).some((s) => String(s["uses"] ?? "").startsWith("docker/build-push-action@")),
  ) ?? assert.fail("a job builds and pushes the image");
  const all = steps(job as Obj);

  // Registry login: the OpenBao-backed script, which fails loudly naming any
  // missing input before anything is pushed.
  const loginIdx = all.findIndex((s) => String(s["run"] ?? "").trim() === "node .github/scripts/estate-registry-credential.mjs login");
  assert.ok(loginIdx > 0, `job ${jobName} logs in to the registry with the OpenBao push credential`);
  assert.deepEqual(Object.keys(all[loginIdx]!["env"] as Obj).sort(), ["ESTATE_REGISTRY", "OPENBAO_ADDR"]);
  assert.ok(!all.some((s) => String(s["uses"] ?? "").startsWith("docker/login-action@")), "no docker/login-action");

  // Build and push, tagged sha-<commit>, to the estate registry only.
  const buildIdx = all.findIndex((s) => String(s["uses"] ?? "").startsWith("docker/build-push-action@"));
  assert.ok(buildIdx > loginIdx, "the push comes after the registry login");
  const build = all[buildIdx]!["with"] as Obj;
  assert.equal(build["tags"], "${{ vars.ESTATE_REGISTRY }}/loopcloser:sha-${{ github.sha }}");
  // The push itself is the bounded-retry step after the build (LC-EST-PUBLISH-BOUNDED-WAIT).
  const pushIdx = all.findIndex((s) => s["id"] === "push");
  assert.ok(pushIdx > buildIdx, "the image is pushed after it is built");
  assert.equal(String(all[pushIdx]!["run"]).trim(), 'node .github/scripts/estate-registry-retry.mjs push "$IMAGE_REF"');
  assert.deepEqual(all[pushIdx]!["env"], { IMAGE_REF: build["tags"] });

  // Checkout leaves no token behind on the runner.
  const checkout = all.find((s) => String(s["uses"] ?? "").startsWith("actions/checkout@"));
  assert.ok(checkout, "the job checks out the merged commit");
  assert.equal((checkout["with"] as Obj)?.["persist-credentials"], false);
});

// LC-D1b-PUSH: the ops runbook names (never the values of) every repository
// variable the workflow reads and the OpenBao path of the push credential, so
// the estate side provisions exactly what the workflow expects. The runbook's
// "Repository variables" table must match the workflow's `vars.*` set exactly;
// the workflow reads no repository secret (LC-EST-IMAGE-PUBLISH).
const RUNBOOK = join(repoRoot, "docs", "ops", "estate-image.md");

function workflowRefs(text: string, context: "vars"): Set<string> {
  return new Set([...text.matchAll(new RegExp(`\\b${context}\\.([A-Za-z_][A-Za-z0-9_]*)`, "g"))].map((m) => m[1]!));
}

function runbookSection(doc: string, heading: string): string {
  const start = doc.indexOf(`\n## ${heading}\n`);
  assert.ok(start >= 0, `docs/ops/estate-image.md has a "## ${heading}" section`);
  const rest = doc.slice(start + heading.length + 5);
  const end = rest.search(/\n## /);
  return end < 0 ? rest : rest.slice(0, end);
}

function tableNames(section: string): string[] {
  return [...section.matchAll(/^\|\s*`([A-Za-z_][A-Za-z0-9_]*)`\s*\|/gm)].map((m) => m[1]!).sort();
}

test("every repository variable the estate-image workflow reads, and the OpenBao push credential path, is named in docs/ops/estate-image.md", () => {
  const { text } = load();
  const doc = readFileSync(RUNBOOK, "utf8");

  const read = workflowRefs(text, "vars");
  assert.ok(read.size > 0, "the workflow reads repository variables");
  assert.deepEqual(
    tableNames(runbookSection(doc, "Repository variables")),
    [...read].sort(),
    `the runbook's "Repository variables" table names exactly the variables the workflow reads`,
  );
  assert.ok(!doc.includes("## Repository secrets"), "the runbook lists no repository secret: the workflow reads none");
  assert.ok(runbookSection(doc, "OpenBao push credential").includes("`kv/loop-closer/registry-push`"), "the runbook names the push credential path");

  // The published tag the workflow pushes is the one the runbook promises.
  assert.ok(doc.includes("loopcloser:sha-<commit>"), "the runbook names the published tag loopcloser:sha-<commit>");
  assert.ok(doc.includes(".github/workflows/estate-image.yml"), "the runbook points at the workflow it describes");
});
