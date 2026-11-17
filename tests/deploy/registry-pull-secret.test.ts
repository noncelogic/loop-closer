// LC-D1b-PULL-CRED acceptance: the ops runbook (docs/ops/registry-pull.md)
// records the exact OpenBao path and property names that the PR #45
// loopcloser registry-pull ExternalSecret reads, so the credential written by
// the delegated OpenBao ops AppRole is the one the cluster syncs. Static check
// of the runbook against the deploy/ package's ExternalSecret: nothing here talks to OpenBao or a
// cluster, and no Secret is read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse, parseAllDocuments } from "yaml";

type Obj = Record<string, any>;

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const deployDir = join(repoRoot, "deploy");
const RUNBOOK = join(repoRoot, "docs", "ops", "registry-pull.md");
const PULL_SECRET = "loopcloser-registry-pull";

// The package's ExternalSecrets as kustomize would emit them: the source file
// is a listed resource and the kustomization carries no patch that could
// rewrite a remoteRef, so the source documents are the rendered ones. Read
// directly so the check needs no kustomize binary.
function externalSecrets(): Obj[] {
  const kustomization = parse(readFileSync(join(deployDir, "kustomization.yaml"), "utf8")) as Obj;
  assert.ok((kustomization["resources"] as string[]).includes("external-secrets.yaml"), "external-secrets.yaml is a package resource");
  for (const k of ["patches", "patchesStrategicMerge", "patchesJson6902", "replacements", "components"])
    assert.equal(kustomization[k], undefined, `the kustomization has no ${k} that could rewrite the ExternalSecret`);
  return parseAllDocuments(readFileSync(join(deployDir, "external-secrets.yaml"), "utf8"))
    .map((doc) => {
      assert.equal(doc.errors.length, 0, String(doc.errors[0]));
      return doc.toJS() as Obj | null;
    })
    .filter((o): o is Obj => o !== null && o["kind"] === "ExternalSecret");
}

function section(text: string, heading: string): string {
  const marker = `## ${heading}\n`;
  const start = text.indexOf(marker);
  assert.ok(start >= 0, `docs/ops/registry-pull.md has a "## ${heading}" section`);
  const rest = text.slice(start + marker.length);
  const end = rest.search(/^## /m);
  return end >= 0 ? rest.slice(0, end) : rest;
}

// The runbook's OpenBao section: one `- **KV path:** `<path>`` line and a
// property table whose first column is each property name in backticks.
function runbookCredential(): { path: string; properties: string[]; text: string } {
  const text = readFileSync(RUNBOOK, "utf8");
  const bao = section(text, "OpenBao");
  const paths = [...bao.matchAll(/^- \*\*KV path:\*\* `([^`]+)`/gm)].map((m) => m[1]!);
  assert.equal(paths.length, 1, "the runbook names exactly one KV path for the pull credential");
  const properties = [...section(text, "Properties").matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1]!);
  return { path: paths[0]!, properties, text };
}

test("the ops runbook's registry pull credential path and properties match the loopcloser registry-pull ExternalSecret", () => {
  const found = externalSecrets().filter((o) => o["spec"]?.["target"]?.["name"] === PULL_SECRET);
  assert.equal(found.length, 1, `exactly one ExternalSecret targets ${PULL_SECRET}`);
  const data = found[0]!["spec"]["data"] as Obj[];
  const esPaths = [...new Set(data.map((d) => d["remoteRef"]["key"] as string))];
  assert.equal(esPaths.length, 1, "the ExternalSecret reads one OpenBao path");
  const esProperties = data.map((d) => d["remoteRef"]["property"] as string);

  const rb = runbookCredential();
  assert.equal(rb.path, esPaths[0], "the runbook path is the path the ExternalSecret reads");
  assert.deepEqual([...rb.properties].sort(), [...esProperties].sort(), "the runbook properties are the ExternalSecret's");
  assert.deepEqual([...rb.properties].sort(), ["password", "registry", "username"]);

  // Policy placement-defaults#credentials: per product, under the product path
  // on the kv/passband/ghcr-pull pattern, never shared across products.
  assert.match(rb.path, /^kv\/loopcloser\//, "under the loop-closer product path");
  assert.doesNotMatch(rb.path, /passband|shared|estate/, "never a shared or another product's path");

  // The write is the delegated OpenBao ops AppRole's, the credential is
  // pull-only, and the runbook never puts the password on a command line.
  assert.match(rb.text, /decisions-expire-with-default/, "names the delegated ops AppRole policy");
  assert.match(rb.text, /read:packages/, "the credential is pull-only (read:packages)");
  assert.match(rb.text, /password=-/, "the password is read from stdin, never passed as an argument");
  assert.doesNotMatch(rb.text, /ghp_|gho_|github_pat_|[A-Za-z0-9+/]{40,}={0,2}/, "no token-shaped literal");
});
