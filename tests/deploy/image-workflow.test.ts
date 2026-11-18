// LC-D1b acceptance: on merge to main, .github/workflows/estate-image.yml
// builds the loopcloser image and pushes it, tagged sha-<commit>, to the
// estate registry that aks-obs-01 pulls from. Since LC-ESTATE-IMAGE-RUNNER it
// runs on a GitHub-hosted runner (tests/ci/estate-image-workflow.test.ts) and
// logs in to the registry with repository secrets. Static check of the
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

test("the estate image workflow publishes from main only and logs in to the estate registry with repository secrets", () => {
  const { text, wf } = load();

  // Trigger: pushes to main only. No pull_request / pull_request_target /
  // workflow_run: the registry push credential must never be reachable from
  // unmerged code (docs/EXTERNAL-REVIEW.md §1).
  const on = wf["on"] as Obj;
  assert.deepEqual(Object.keys(on), ["push"], "only `push` triggers the estate image workflow");
  assert.deepEqual(on["push"], { branches: ["main"] }, "only pushes to main");

  // Least privilege: read the repo; nothing else.
  assert.deepEqual(wf["permissions"], { contents: "read" });

  const jobs = wf["jobs"] as Obj;
  assert.ok(Object.keys(jobs).length > 0, "the workflow has jobs");
  for (const [name, job] of Object.entries(jobs)) {
    assert.equal(job["permissions"], undefined, `job ${name} does not widen workflow permissions`);
  }

  // Only the two registry-login secrets; no `secrets: inherit`, no
  // github.token used as a credential.
  const secretsRead = new Set([...text.matchAll(/\bsecrets\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!));
  assert.deepEqual([...secretsRead].sort(), ["ESTATE_REGISTRY_PASSWORD", "ESTATE_REGISTRY_USERNAME"]);
  assert.ok(!/secrets\s*:\s*inherit/.test(text), "the workflow never inherits secrets");
  assert.ok(!/github\.token/.test(text), "the workflow never uses github.token");

  const [jobName, job] = Object.entries(jobs).find(([, j]) =>
    steps(j as Obj).some((s) => String(s["uses"] ?? "").startsWith("docker/build-push-action@")),
  ) ?? assert.fail("a job builds and pushes the image");
  const all = steps(job as Obj);

  // Missing configuration fails the run loudly before anything else.
  const check = all[0]!;
  assert.equal(check["name"], "Check estate registry configuration", `job ${jobName} checks its configuration first`);
  assert.deepEqual(Object.keys(check["env"] as Obj).sort(), [
    "ESTATE_REGISTRY",
    "ESTATE_REGISTRY_PASSWORD",
    "ESTATE_REGISTRY_USERNAME",
  ]);

  // Registry login uses exactly the repository secrets.
  const loginIdx = all.findIndex((s) => String(s["uses"] ?? "").startsWith("docker/login-action@"));
  assert.ok(loginIdx > 0, "the job logs in to the registry");
  const login = all[loginIdx]!["with"] as Obj;
  assert.equal(login["registry"], "${{ vars.ESTATE_REGISTRY }}");
  assert.equal(login["username"], "${{ secrets.ESTATE_REGISTRY_USERNAME }}");
  assert.equal(login["password"], "${{ secrets.ESTATE_REGISTRY_PASSWORD }}");

  // Build and push, tagged sha-<commit>, to the estate registry only.
  const buildIdx = all.findIndex((s) => String(s["uses"] ?? "").startsWith("docker/build-push-action@"));
  assert.ok(buildIdx > loginIdx, "the push comes after the registry login");
  const build = all[buildIdx]!["with"] as Obj;
  assert.equal(build["push"], true);
  assert.equal(build["tags"], "${{ vars.ESTATE_REGISTRY }}/loopcloser:sha-${{ github.sha }}");

  // Checkout leaves no token behind on the runner.
  const checkout = all.find((s) => String(s["uses"] ?? "").startsWith("actions/checkout@"));
  assert.ok(checkout, "the job checks out the merged commit");
  assert.equal((checkout["with"] as Obj)?.["persist-credentials"], false);
});

// LC-D1b-PUSH: the ops runbook names (never the values of) every repository
// variable and secret the workflow reads, so the estate side provisions
// exactly what the workflow expects. The runbook's "Repository variables" and
// "Repository secrets" tables must match the workflow's `vars.*` and
// `secrets.*` sets exactly.
const RUNBOOK = join(repoRoot, "docs", "ops", "estate-image.md");

function workflowRefs(text: string, context: "vars" | "secrets"): Set<string> {
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

test("every repository variable and secret the estate-image workflow reads is named in docs/ops/estate-image.md", () => {
  const { text } = load();
  const doc = readFileSync(RUNBOOK, "utf8");

  for (const [context, heading] of [["vars", "Repository variables"], ["secrets", "Repository secrets"]] as const) {
    const read = workflowRefs(text, context);
    assert.ok(read.size > 0, `the workflow reads repository ${context}`);
    assert.deepEqual(
      tableNames(runbookSection(doc, heading)),
      [...read].sort(),
      `the runbook's "${heading}" table names exactly the ${context} the workflow reads`,
    );
  }

  // The published tag the workflow pushes is the one the runbook promises.
  assert.ok(doc.includes("loopcloser:sha-<commit>"), "the runbook names the published tag loopcloser:sha-<commit>");
  assert.ok(doc.includes(".github/workflows/estate-image.yml"), "the runbook points at the workflow it describes");
});
