// The manifest check shared by tests/deploy/manifests.test.ts and
// tests/deploy/overlay.test.ts: render a kustomize directory with a real
// kustomize, dry-run it with kubectl offline, and schema-validate it with
// kubeconform against the vendored schemas only. A missing tool fails; it
// never skips. Nothing here talks to a cluster or reads a secret.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";

export const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

export type Obj = Record<string, any>;

function onPath(bin: string): boolean {
  try {
    execFileSync(bin, ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function kustomizeBuild(dir: string): string {
  const explicit = process.env["KUSTOMIZE"];
  if (explicit) return execFileSync(explicit, ["build", dir], { encoding: "utf8" });
  if (onPath("kustomize")) return execFileSync("kustomize", ["build", dir], { encoding: "utf8" });
  return execFileSync(process.env["KUBECTL"] || "kubectl", ["kustomize", dir], { encoding: "utf8" });
}


// The environment every validator runs in: no kubeconfig and no in-cluster
// service variables, so there is no cluster to reach and no credential to
// read even by accident; and every HTTP(S) request goes to a proxy that does
// not exist, so a validator that tried to fetch anything would fail loudly
// rather than depend on the network.
export const DEAD_PROXY = "http://127.0.0.1:9";
export function offlineEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, KUBECONFIG: join(repoRoot, ".no-kubeconfig") };
  delete env["KUBERNETES_SERVICE_HOST"];
  delete env["KUBERNETES_SERVICE_PORT"];
  for (const v of ["NO_PROXY", "no_proxy"]) delete env[v];
  for (const v of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) env[v] = DEAD_PROXY;
  return env;
}

// kubectl's client-side dry-run in its offline form: `--local` decodes and
// maps every object without asking an API server, and `--dry-run=client`
// guarantees nothing is sent. This catches undecodable documents (bad YAML, no
// kind) but works on unstructured objects, so it does not check field types;
// kubeconformValidate below does. Throws (with kubectl's stderr) on any object
// kubectl rejects.
export function kubectlDryRun(manifests: string): Obj[] {
  const kubectl = process.env["KUBECTL"] || "kubectl";
  const env = offlineEnv();
  const out = execFileSync(
    kubectl,
    [
      "annotate",
      "--local",
      "--dry-run=client",
      "--filename=-",
      "--output=yaml",
      "manifest-check.loopcloser.dev/validated=true",
    ],
    { input: manifests, encoding: "utf8", env, stdio: ["pipe", "pipe", "pipe"] },
  );
  const docs = parseAllDocuments(out)
    .map((doc) => {
      assert.equal(doc.errors.length, 0, String(doc.errors[0]));
      return doc.toJS() as Obj | null;
    })
    .filter((o): o is Obj => o !== null);
  return docs.flatMap((o) => (o["kind"] === "List" ? (o["items"] as Obj[]) : [o]));
}

// Schemas are checked in under tests/deploy/schemas/ (copied from fixed
// upstream commits; see its README.md and SHA256SUMS), so validation reads
// local files only and cannot drift with upstream edits or fail on a network
// error. Built-in kinds validate against the Kubernetes OpenAPI schema for
// KUBERNETES_VERSION (strict: unknown fields fail too); CRD kinds (CloudNativePG
// Cluster, ExternalSecret) against the CRDs-catalog extraction of the
// operator's own CRD schema. A kind with no schema fails; nothing is skipped.
export const KUBERNETES_VERSION = "1.34.1";
export const SCHEMA_DIR = join(repoRoot, "tests", "deploy", "schemas");
export const SCHEMA_LOCATIONS = [
  join(SCHEMA_DIR, "kubernetes", "{{ .NormalizedKubernetesVersion }}-standalone{{ .StrictSuffix }}", "{{ .ResourceKind }}{{ .KindSuffix }}.json"),
  join(SCHEMA_DIR, "crds", "{{ .Group }}", "{{ .ResourceKind }}_{{ .ResourceAPIVersion }}.json"),
];

export type KubeconformResult = {
  kind: string;
  name: string;
  version: string;
  status: string;
  msg: string;
  validationErrors?: { path: string; msg: string }[];
};

// Runs kubeconform, offline, over the manifests and returns its verdict on
// every object (statusValid, statusInvalid, statusError, statusSkipped, ...).
// kubeconform exits non-zero when any object is not valid but still prints
// its JSON report; only a run with no parseable report (tool missing, crash)
// throws here, so callers can tell a schema rejection from a broken tool.
export function kubeconformReport(manifests: string): KubeconformResult[] {
  const kubeconform = process.env["KUBECONFORM"] || "kubeconform";
  const args = [
    "-strict",
    "-summary",
    "-verbose",
    "-output=json",
    `-kubernetes-version=${KUBERNETES_VERSION}`,
    ...SCHEMA_LOCATIONS.map((l) => `-schema-location=${l}`),
    "-",
  ];
  let out: string;
  try {
    out = execFileSync(kubeconform, args, {
      input: manifests,
      encoding: "utf8",
      env: offlineEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    const e = err as Error & { stdout?: string; stderr?: string };
    try {
      return (JSON.parse(e.stdout ?? "") as { resources: KubeconformResult[] }).resources;
    } catch {
      throw new Error(`kubeconform rejected the manifests: ${e.stdout || ""}${e.stderr || ""}${e.stdout || e.stderr ? "" : e.message}`);
    }
  }
  return (JSON.parse(out) as { resources: KubeconformResult[] }).resources;
}

// Schema validation without an API server: kubeconform checks each object's
// fields and types against its pinned schema (a Deployment with
// `spec.replicas: "invalid"` fails here, though kubectl's dry-run accepts it).
// Returns the identity of every object it found valid; throws with
// kubeconform's findings when any object is invalid, errors, or is skipped.
export function kubeconformValidate(manifests: string): string[] {
  const resources = kubeconformReport(manifests);
  const notValid = resources.filter((r) => r.status !== "statusValid");
  if (notValid.length > 0) throw new Error(`kubeconform did not validate: ${JSON.stringify(notValid)}`);
  return resources.map((r) => `${r.version} ${r.kind} ${r.name}`);
}

// Both validators, as the overlay check applies them.
export function validate(manifests: string): Obj[] {
  const validated = kubectlDryRun(manifests);
  const schemaValid = kubeconformValidate(manifests);
  assert.deepEqual(
    schemaValid.sort(),
    validated.map((o) => `${o["apiVersion"]} ${o["kind"]} ${o["metadata"]?.["name"]}`).sort(),
    "kubeconform schema-validated exactly the objects kubectl decoded",
  );
  return validated;
}

// The objects of a rendered multi-document manifest.
export function parseObjects(rendered: string): Obj[] {
  return parseAllDocuments(rendered)
    .map((doc) => {
      assert.equal(doc.errors.length, 0, String(doc.errors[0]));
      return doc.toJS() as Obj | null;
    })
    .filter((o): o is Obj => o !== null);
}
