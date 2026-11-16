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
