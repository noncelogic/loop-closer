// LC-D1b acceptance: on merge to main, .github/workflows/estate-image.yml
// builds the loopcloser image on the estate's self-hosted runners and pushes
// it, tagged sha-<commit>, to the estate registry that aks-obs-01 pulls from.
// The registry push credential is read from OpenBao (GitHub OIDC -> OpenBao
// JWT auth), never from GitHub secrets. Static check of the workflow file:
// nothing here runs a build, reaches a registry or reads a secret.
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

test("the estate image workflow runs only on self-hosted runners and reads the registry credential from OpenBao, never from GitHub secrets", () => {
  const { text, wf } = load();

  // Trigger: pushes to main only. No pull_request / pull_request_target /
  // workflow_run: self-hosted runners hold estate credentials and must never
  // be reachable from unmerged code (docs/EXTERNAL-REVIEW.md §1).
  const on = wf["on"] as Obj;
  assert.deepEqual(Object.keys(on), ["push"], "only `push` triggers the estate image workflow");
  assert.deepEqual(on["push"], { branches: ["main"] }, "only pushes to main");

  // Least privilege: read the repo, mint an OIDC token for OpenBao; nothing else.
  assert.deepEqual(wf["permissions"], { contents: "read", "id-token": "write" });

  const jobs = wf["jobs"] as Obj;
  assert.ok(Object.keys(jobs).length > 0, "the workflow has jobs");
  for (const [name, job] of Object.entries(jobs)) {
    const runsOn = job["runs-on"];
    const labels: unknown[] = Array.isArray(runsOn) ? runsOn : [runsOn];
    assert.ok(labels.includes("self-hosted"), `job ${name} runs on self-hosted runners (got ${JSON.stringify(runsOn)})`);
    for (const l of labels) {
      assert.equal(typeof l, "string", `job ${name}: runner labels are literal strings, not expressions`);
      assert.ok(!String(l).includes("${{"), `job ${name}: runner labels are not computed`);
      assert.ok(!/^(ubuntu|windows|macos)-/.test(String(l)), `job ${name}: no GitHub-hosted runner label (${l})`);
    }
    assert.equal(job["permissions"], undefined, `job ${name} does not widen workflow permissions`);
  }

  // Never GitHub secrets: no `secrets.` context (not even GITHUB_TOKEN), no
  // `secrets: inherit`, no github.token used as a credential.
  assert.ok(!/\bsecrets\s*\./.test(text), "the workflow never reads the GitHub `secrets` context");
  assert.ok(!/secrets\s*:\s*inherit/.test(text), "the workflow never inherits secrets");
  assert.ok(!/github\.token/.test(text), "the workflow never uses github.token");

  const [jobName, job] = Object.entries(jobs).find(([, j]) =>
    steps(j as Obj).some((s) => String(s["uses"] ?? "").startsWith("docker/build-push-action@")),
  ) ?? assert.fail("a job builds and pushes the image");
  const all = steps(job as Obj);

  // OpenBao read: JWT auth with the job's GitHub OIDC token; the KV path,
  // address and role are repository variables (configuration, not secrets).
  const baoIdx = all.findIndex((s) => String(s["uses"] ?? "").startsWith("hashicorp/vault-action@"));
  assert.ok(baoIdx >= 0, `job ${jobName} reads the registry credential from OpenBao`);
  const bao = all[baoIdx]!;
  const baoWith = bao["with"] as Obj;
  assert.equal(baoWith["method"], "jwt", "OpenBao login uses GitHub OIDC (JWT), no static token");
  assert.equal(baoWith["url"], "${{ vars.OPENBAO_ADDR }}");
  assert.equal(baoWith["exportEnv"], false, "the credential is not exported to every later step's environment");
  const baoSecrets = String(baoWith["secrets"]);
  assert.match(baoSecrets, /\bvars\.ESTATE_REGISTRY_OPENBAO_PATH\b.*\busername\s*\|\s*REGISTRY_USERNAME\b/);
  assert.match(baoSecrets, /\bvars\.ESTATE_REGISTRY_OPENBAO_PATH\b.*\bpassword\s*\|\s*REGISTRY_PASSWORD\b/);
  assert.equal(baoWith["role"], "${{ vars.ESTATE_REGISTRY_OPENBAO_ROLE }}");
  for (const key of ["token", "roleId", "secretId", "jwtPrivateKey"]) {
    assert.equal(baoWith[key], undefined, `OpenBao login takes no static ${key}`);
  }

  // Registry login uses exactly what OpenBao returned.
  const loginIdx = all.findIndex((s) => String(s["uses"] ?? "").startsWith("docker/login-action@"));
  assert.ok(loginIdx > baoIdx, "registry login comes after the OpenBao read");
  const login = all[loginIdx]!["with"] as Obj;
  const baoId = String(bao["id"]);
  assert.equal(login["registry"], "${{ vars.ESTATE_REGISTRY }}");
  assert.equal(login["username"], `\${{ steps.${baoId}.outputs.REGISTRY_USERNAME }}`);
  assert.equal(login["password"], `\${{ steps.${baoId}.outputs.REGISTRY_PASSWORD }}`);
  assert.ok(!all.some((s) => String(s["uses"] ?? "").startsWith("docker/login-action@") && (s["with"] as Obj)?.["registry"] === "ghcr.io"));

  // Build and push, tagged sha-<commit>, to the estate registry only.
  const build = all.find((s) => String(s["uses"] ?? "").startsWith("docker/build-push-action@"))!["with"] as Obj;
  assert.equal(build["push"], true);
  assert.equal(build["tags"], "${{ vars.ESTATE_REGISTRY }}/loopcloser:sha-${{ github.sha }}");

  // Checkout leaves no token behind on the self-hosted runner.
  const checkout = all.find((s) => String(s["uses"] ?? "").startsWith("actions/checkout@"));
  assert.ok(checkout, "the job checks out the merged commit");
  assert.equal((checkout["with"] as Obj)?.["persist-credentials"], false);
});

// Placement: every label a job asks for must be carried by an online estate
// runner, or the job queues forever and blocks the `estate-image` concurrency
// group. The estate's self-hosted runner is the passband-ci ARC scale set on
// AKS, labelled [passband-ci, aks, self-hosted]; it carries no `linux` label
// (run 43924808173 queued on [self-hosted, linux]).
const ESTATE_RUNNER_LABELS = ["passband-ci", "aks", "self-hosted"];

test("every estate image job asks only for labels the passband-ci runner carries", () => {
  const { wf } = load();
  for (const [name, job] of Object.entries(wf["jobs"] as Obj)) {
    const runsOn = (job as Obj)["runs-on"];
    const labels: unknown[] = Array.isArray(runsOn) ? runsOn : [runsOn];
    for (const l of labels) {
      assert.ok(
        ESTATE_RUNNER_LABELS.includes(String(l)),
        `job ${name}: runner label ${JSON.stringify(l)} is not carried by passband-ci ${JSON.stringify(ESTATE_RUNNER_LABELS)}`,
      );
    }
    assert.ok(labels.includes("passband-ci"), `job ${name} targets the passband-ci scale set by name`);
  }
});

// LC-D1b-PUSH: the ops runbook names (never the values of) every repository
// variable the workflow reads and the OpenBao KV fields it pulls, so the
// estate side provisions exactly what the workflow expects. The runbook's
// "Repository variables" table must match the workflow's `vars.*` set exactly.
const RUNBOOK = join(repoRoot, "docs", "ops", "estate-image.md");

function workflowVars(text: string): Set<string> {
  return new Set([...text.matchAll(/\bvars\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!));
}

function runbookSection(doc: string, heading: string): string {
  const start = doc.indexOf(`\n## ${heading}\n`);
  assert.ok(start >= 0, `docs/ops/estate-image.md has a "## ${heading}" section`);
  const rest = doc.slice(start + heading.length + 5);
  const end = rest.search(/\n## /);
  return end < 0 ? rest : rest.slice(0, end);
}

test("every repository variable and OpenBao path the estate-image workflow reads is named in docs/ops/estate-image.md", () => {
  const { text, wf } = load();
  const doc = readFileSync(RUNBOOK, "utf8");

  const read = workflowVars(text);
  assert.ok(read.size > 0, "the workflow reads repository variables");

  // Table rows of the "Repository variables" section: | `NAME` | ... |
  const table = runbookSection(doc, "Repository variables");
  const documented = new Set(
    [...table.matchAll(/^\|\s*`([A-Za-z_][A-Za-z0-9_]*)`\s*\|/gm)].map((m) => m[1]!),
  );
  assert.deepEqual(
    [...documented].sort(),
    [...read].sort(),
    "the runbook's repository-variable table names exactly the variables the workflow reads",
  );

  // OpenBao: the KV path and JWT role the workflow logs in with, and every
  // field it reads at that path, are named in the OpenBao section.
  const job = Object.values(wf["jobs"] as Obj).find((j) =>
    steps(j as Obj).some((s) => String(s["uses"] ?? "").startsWith("hashicorp/vault-action@")),
  ) as Obj;
  const bao = steps(job).find((s) => String(s["uses"] ?? "").startsWith("hashicorp/vault-action@"))!["with"] as Obj;
  const openbao = runbookSection(doc, "OpenBao");
  const pathVar = /vars\.([A-Za-z0-9_]+)/.exec(String(bao["secrets"]))![1]!;
  const roleVar = /vars\.([A-Za-z0-9_]+)/.exec(String(bao["role"]))![1]!;
  const addrVar = /vars\.([A-Za-z0-9_]+)/.exec(String(bao["url"]))![1]!;
  for (const name of [pathVar, roleVar, addrVar]) {
    assert.ok(openbao.includes(`\`${name}\``), `the OpenBao section names \`${name}\``);
  }
  assert.ok(/\bjwt\b/i.test(openbao), "the OpenBao section names the JWT auth method");
  const fields = [...String(bao["secrets"]).matchAll(/\}\}\s+([A-Za-z0-9_]+)\s*\|/g)].map((m) => m[1]!);
  assert.ok(fields.length > 0, "the workflow reads fields at the OpenBao path");
  for (const f of fields) {
    assert.ok(openbao.includes(`\`${f}\``), `the OpenBao section names the KV field \`${f}\``);
  }

  // The published tag the workflow pushes is the one the runbook promises.
  assert.ok(doc.includes("loopcloser:sha-<commit>"), "the runbook names the published tag loopcloser:sha-<commit>");
  assert.ok(doc.includes(".github/workflows/estate-image.yml"), "the runbook points at the workflow it describes");
});
