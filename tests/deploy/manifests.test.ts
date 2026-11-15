// LC-D1 acceptance: the deploy/ kustomize package for aks-obs-01 renders, and
// the API Deployment's environment matches the frozen config contract
// (src/config.ts: PORT, DATABASE_URL).
//
// LC-M3-MANIFEST-CHECK acceptance: every kustomize overlay in the repository
// renders and passes kubectl client-side dry-run validation, and every rendered
// object validates against its pinned Kubernetes or CRD schema. CI runs this
// file with its own pinned kubectl, kustomize and kubeconform ($KUBECTL,
// $KUSTOMIZE, $KUBECONFORM); see .github/workflows/ci.yml and
// .github/scripts/install-k8s-tools.sh.
//
// Renders with a real kustomize: $KUSTOMIZE if set, else `kustomize` on PATH,
// else `kubectl kustomize`. Dry-runs with $KUBECTL if set, else `kubectl` on
// PATH. Schema-validates with $KUBECONFORM if set, else `kubeconform` on PATH.
// A missing tool fails the test; it never skips. Nothing here talks to a
// cluster or reads a secret.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseAllDocuments } from "yaml";
import { CONFIG_ENV, DEFAULT_PORT, loadConfig } from "../../src/config.ts";

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const deployDir = join(repoRoot, "deploy");

const NAMESPACE = "loop-closer";
const IMAGE = "ghcr.io/noncelogic/loop-closer";
const DB_CLUSTER = "loopcloser-db";
// CloudNativePG publishes the app-role connection string as `<cluster>-app`/uri.
const DB_SECRET = `${DB_CLUSTER}-app`;

type Obj = Record<string, any>;

function onPath(bin: string): boolean {
  try {
    execFileSync(bin, ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function kustomizeBuild(dir: string): string {
  const explicit = process.env["KUSTOMIZE"];
  if (explicit) return execFileSync(explicit, ["build", dir], { encoding: "utf8" });
  if (onPath("kustomize")) return execFileSync("kustomize", ["build", dir], { encoding: "utf8" });
  return execFileSync(process.env["KUBECTL"] || "kubectl", ["kustomize", dir], { encoding: "utf8" });
}

const KUSTOMIZATION_FILES = new Set(["kustomization.yaml", "kustomization.yml", "Kustomization"]);

// Every directory holding a kustomization, tracked or new (gitignored paths
// such as node_modules/ are excluded).
function overlays(): string[] {
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .split("\0")
    .filter((f) => f !== "" && KUSTOMIZATION_FILES.has(basename(f)));
  return [...new Set(files.map((f) => dirname(f)))].sort();
}

// The environment every validator runs in: no kubeconfig and no in-cluster
// service variables, so there is no cluster to reach and no credential to
// read even by accident.
function offlineEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, KUBECONFIG: join(repoRoot, ".no-kubeconfig") };
  delete env["KUBERNETES_SERVICE_HOST"];
  delete env["KUBERNETES_SERVICE_PORT"];
  return env;
}

// kubectl's client-side dry-run in its offline form: `--local` decodes and
// maps every object without asking an API server, and `--dry-run=client`
// guarantees nothing is sent. This catches undecodable documents (bad YAML, no
// kind) but works on unstructured objects, so it does not check field types;
// kubeconformValidate below does. Throws (with kubectl's stderr) on any object
// kubectl rejects.
function kubectlDryRun(manifests: string): Obj[] {
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

// Schemas are pinned to fixed commits, so the check cannot drift with upstream
// edits. Built-in kinds validate against the Kubernetes OpenAPI schema for
// KUBERNETES_VERSION (strict: unknown fields fail too); CRD kinds (CloudNativePG
// Cluster, ExternalSecret, ...) against the CRDs-catalog extraction of the
// operator's own CRD schema. A kind with no schema fails; nothing is skipped.
const KUBERNETES_VERSION = "1.34.1";
const SCHEMA_LOCATIONS = [
  "https://raw.githubusercontent.com/yannh/kubernetes-json-schema/2bfaff3898a7a4fa4e4760da3d2656211c9b4c71/{{ .NormalizedKubernetesVersion }}-standalone{{ .StrictSuffix }}/{{ .ResourceKind }}{{ .KindSuffix }}.json",
  "https://raw.githubusercontent.com/datreeio/CRDs-catalog/3e8a8916ca1b7af6464606c2c2f5869dbafa9653/{{ .Group }}/{{ .ResourceKind }}_{{ .ResourceAPIVersion }}.json",
];

type KubeconformResult = { kind: string; name: string; version: string; status: string; msg: string };

// Schema validation without an API server: kubeconform checks each object's
// fields and types against its pinned schema (a Deployment with
// `spec.replicas: "invalid"` fails here, though kubectl's dry-run accepts it).
// Returns the identity of every object it found valid; throws with
// kubeconform's findings when any object is invalid, errors, or is skipped.
function kubeconformValidate(manifests: string): string[] {
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
    throw new Error(`kubeconform rejected the manifests: ${e.stdout || ""}${e.stderr || ""}${e.stdout || e.stderr ? "" : e.message}`);
  }
  const report = JSON.parse(out) as { resources: KubeconformResult[] };
  const notValid = report.resources.filter((r) => r.status !== "statusValid");
  if (notValid.length > 0) throw new Error(`kubeconform did not validate: ${JSON.stringify(notValid)}`);
  return report.resources.map((r) => `${r.version} ${r.kind} ${r.name}`);
}

// Both validators, as the overlay check applies them.
function validate(manifests: string): Obj[] {
  const validated = kubectlDryRun(manifests);
  const schemaValid = kubeconformValidate(manifests);
  assert.deepEqual(
    schemaValid.sort(),
    validated.map((o) => `${o["apiVersion"]} ${o["kind"]} ${o["metadata"]?.["name"]}`).sort(),
    "kubeconform schema-validated exactly the objects kubectl decoded",
  );
  return validated;
}

function identity(o: Obj): string {
  return `${o["apiVersion"]} ${o["kind"]} ${o["metadata"]?.["namespace"] ?? ""}/${o["metadata"]?.["name"]}`;
}

function render(): Obj[] {
  assert.ok(existsSync(join(deployDir, "kustomization.yaml")), "deploy/kustomization.yaml must exist");
  return parseAllDocuments(kustomizeBuild(deployDir))
    .map((doc) => {
      assert.equal(doc.errors.length, 0, String(doc.errors[0]));
      return doc.toJS() as Obj | null;
    })
    .filter((o): o is Obj => o !== null);
}

function one(objs: Obj[], kind: string, name: string): Obj {
  const found = objs.filter((o) => o["kind"] === kind && o["metadata"]?.["name"] === name);
  assert.equal(found.length, 1, `expected exactly one ${kind}/${name}`);
  return found[0]!;
}

test("kustomize build renders and the Deployment env matches the frozen config contract (PORT, database URL)", () => {
  const objs = render();

  // Namespace, and everything namespaced lands in it.
  one(objs, "Namespace", NAMESPACE);
  for (const o of objs) {
    if (o["kind"] === "Namespace") continue;
    assert.equal(o["metadata"]?.["namespace"], NAMESPACE, `${o["kind"]}/${o["metadata"]?.["name"]} namespace`);
  }

  // The frozen config contract: env names and the PORT default the service uses.
  assert.deepEqual(CONFIG_ENV, { port: "PORT", host: "HOST", databaseUrl: "DATABASE_URL" });
  assert.equal(DEFAULT_PORT, 8080);

  const deploy = one(objs, "Deployment", "loopcloser");
  const containers = deploy["spec"]["template"]["spec"]["containers"] as Obj[];
  assert.equal(containers.length, 1);
  const api = containers[0]!;
  assert.match(api["image"], new RegExp(`^${IMAGE}[:@]`));
  assert.deepEqual(api["command"] ?? api["args"] ?? ["node", "dist/main.js"], ["node", "dist/main.js"]);

  const env = new Map((api["env"] as Obj[]).map((e) => [e["name"] as string, e]));
  assert.equal(env.get(CONFIG_ENV.port)?.["value"], "8080");
  assert.deepEqual(env.get(CONFIG_ENV.databaseUrl)?.["valueFrom"], {
    secretKeyRef: { name: DB_SECRET, key: "uri" },
  });
  // Every env var the container gets is one the service actually reads.
  const known = new Set<string>(Object.values(CONFIG_ENV));
  for (const name of env.keys()) assert.ok(known.has(name), `Deployment sets ${name}, which is not in the config contract`);

  // The rendered env, fed through the real loader, yields a working config.
  const loaded = loadConfig({ PORT: env.get(CONFIG_ENV.port)!["value"], DATABASE_URL: "postgresql://x@y/loopcloser" });
  assert.equal(loaded.port, 8080);
  assert.equal(loaded.databaseUrl, "postgresql://x@y/loopcloser");

  const containerPort = (api["ports"] as Obj[]).find((p) => p["name"] === "http");
  assert.equal(containerPort?.["containerPort"], 8080);
  assert.equal(api["readinessProbe"]?.["httpGet"]?.["path"], "/healthz");

  // Service: in-cluster only, targets the http port.
  const svc = one(objs, "Service", "loopcloser");
  assert.equal(svc["spec"]["type"] ?? "ClusterIP", "ClusterIP");
  assert.equal(svc["spec"]["ports"][0]["targetPort"], "http");
  assert.deepEqual(svc["spec"]["selector"], deploy["spec"]["selector"]["matchLabels"]);

  // No public ingress of any kind.
  for (const o of objs) {
    assert.ok(!["Ingress", "HTTPRoute", "Gateway", "IngressRoute"].includes(o["kind"]), `unexpected ${o["kind"]}`);
    if (o["kind"] === "Service") assert.ok(!["LoadBalancer", "NodePort"].includes(o["spec"]["type"]));
  }

  // CloudNativePG cluster on the estate operator.
  const db = one(objs, "Cluster", DB_CLUSTER);
  assert.equal(db["apiVersion"], "postgresql.cnpg.io/v1");
  assert.equal(db["spec"]["instances"], 2);
  assert.equal(db["spec"]["bootstrap"]["initdb"]["database"], "loopcloser");
  assert.equal(db["spec"]["bootstrap"]["initdb"]["owner"], "loopcloser");
  assert.equal(db["spec"]["storage"]["size"], "20Gi");
  assert.equal(db["spec"]["storage"]["storageClass"], "managed-csi-premium");

  // Per-minute tick CronJob, shipped suspended, same image and DB wiring.
  const tick = one(objs, "CronJob", "loopcloser-tick");
  assert.equal(tick["spec"]["schedule"], "* * * * *");
  assert.equal(tick["spec"]["suspend"], true);
  assert.equal(tick["spec"]["concurrencyPolicy"], "Forbid");
  const tickContainer = tick["spec"]["jobTemplate"]["spec"]["template"]["spec"]["containers"][0] as Obj;
  assert.equal(tickContainer["image"], api["image"]);
  const tickEnv = new Map((tickContainer["env"] as Obj[]).map((e) => [e["name"] as string, e]));
  assert.deepEqual(tickEnv.get(CONFIG_ENV.databaseUrl)?.["valueFrom"], env.get(CONFIG_ENV.databaseUrl)?.["valueFrom"]);

  // App API keys come from OpenBao through the ClusterSecretStore.
  const externalSecrets = objs.filter((o) => o["kind"] === "ExternalSecret");
  assert.ok(externalSecrets.length >= 1, "expected an ExternalSecret for the app API keys");
  for (const es of externalSecrets) {
    assert.equal(es["spec"]["secretStoreRef"]["kind"], "ClusterSecretStore");
    assert.equal(es["spec"]["secretStoreRef"]["name"], "openbao");
  }
});

test("Dockerfile builds on Node 24 with tsc and runs node dist/main.js", () => {
  const dockerfile = readFileSync(join(repoRoot, "Dockerfile"), "utf8");
  assert.match(dockerfile, /^FROM node:24[\w.-]*/m);
  assert.match(dockerfile, /npm run build/);
  assert.match(dockerfile, /^CMD \["node", "dist\/main\.js"\]$/m);
});

test("every kustomize overlay renders and passes kubectl client-side dry-run validation", () => {
  // Also schema-validates every rendered object (kubeconformValidate).
  const dirs = overlays();
  assert.ok(dirs.includes("deploy"), `expected deploy/ among the overlays, found ${JSON.stringify(dirs)}`);

  for (const dir of dirs) {
    let rendered: string;
    try {
      rendered = kustomizeBuild(join(repoRoot, dir));
    } catch (err) {
      assert.fail(`kustomize build ${dir} failed: ${(err as Error).message}`);
    }
    const objs = parseAllDocuments(rendered)
      .map((doc) => {
        assert.equal(doc.errors.length, 0, `${dir}: ${String(doc.errors[0])}`);
        return doc.toJS() as Obj | null;
      })
      .filter((o): o is Obj => o !== null);
    assert.ok(objs.length > 0, `${dir} renders no objects`);

    let validated: Obj[];
    try {
      validated = validate(rendered);
    } catch (err) {
      assert.fail(`validation rejected ${dir}: ${(err as Error).message}`);
    }
    // kubectl accepted every rendered object, one for one.
    assert.deepEqual(validated.map(identity).sort(), objs.map(identity).sort(), `${dir}: dry-run object set`);
  }
});

test("the manifest validation rejects an invalid manifest", () => {
  // The same call accepts valid objects, so the rejections below come from
  // validation and not from a missing or broken tool.
  const ok = validate("apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ok\n");
  assert.deepEqual(ok.map((o) => o["metadata"]?.["name"]), ["ok"]);
  const deployment = (replicas: string) =>
    [
      "apiVersion: apps/v1",
      "kind: Deployment",
      "metadata:",
      "  name: web",
      "spec:",
      `  replicas: ${replicas}`,
      "  selector:",
      "    matchLabels: {app: web}",
      "  template:",
      "    metadata:",
      "      labels: {app: web}",
      "    spec:",
      "      containers:",
      "        - name: web",
      "          image: example.invalid/web:1",
      "",
    ].join("\n");
  assert.deepEqual(validate(deployment("2")).map((o) => o["kind"]), ["Deployment"]);

  // A document kubectl cannot decode as a Kubernetes object (no kind) must
  // fail the check rather than pass silently.
  assert.throws(() => validate("apiVersion: v1\nmetadata:\n  name: no-kind\n"));
  // A document that is not valid YAML must fail too.
  assert.throws(() => validate("apiVersion: v1\nkind: ConfigMap\nmetadata: [unclosed\n"));

  // A schema-invalid object: kubectl's dry-run decodes it unstructured and
  // accepts it, so the schema validation is what must reject it.
  const badReplicas = deployment('"invalid"');
  assert.deepEqual(kubectlDryRun(badReplicas).map((o) => o["spec"]?.["replicas"]), ["invalid"]);
  assert.throws(() => validate(badReplicas), /replicas/);
  // An unknown field fails strict validation.
  assert.throws(
    () => validate("apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: x\nnotAField: 1\n"),
    /notAField|additional/i,
  );
  // A kind with no schema fails rather than being skipped.
  assert.throws(
    () => validate("apiVersion: example.invalid/v1\nkind: Nothing\nmetadata:\n  name: x\n"),
    /kubeconform/,
  );
});
