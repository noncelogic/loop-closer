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
// LC-M3-MANIFEST-CHECK-b acceptance: the schema check, run offline, rejects a
// wrongly typed field and a field the schema does not define, and passes the
// repository's rendered manifests (docs/decisions/manifest-schema-validator.md).
//
// Renders with a real kustomize: $KUSTOMIZE if set, else `kustomize` on PATH,
// else `kubectl kustomize`. Dry-runs with $KUBECTL if set, else `kubectl` on
// PATH. Schema-validates with $KUBECONFORM if set, else `kubeconform` on PATH.
// A missing tool fails the test; it never skips. Nothing here talks to a
// cluster or reads a secret.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
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
// read even by accident; and every HTTP(S) request goes to a proxy that does
// not exist, so a validator that tried to fetch anything would fail loudly
// rather than depend on the network.
const DEAD_PROXY = "http://127.0.0.1:9";
function offlineEnv(): NodeJS.ProcessEnv {
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

// Schemas are checked in under tests/deploy/schemas/ (copied from fixed
// upstream commits; see its README.md and SHA256SUMS), so validation reads
// local files only and cannot drift with upstream edits or fail on a network
// error. Built-in kinds validate against the Kubernetes OpenAPI schema for
// KUBERNETES_VERSION (strict: unknown fields fail too); CRD kinds (CloudNativePG
// Cluster, ExternalSecret) against the CRDs-catalog extraction of the
// operator's own CRD schema. A kind with no schema fails; nothing is skipped.
const KUBERNETES_VERSION = "1.34.1";
const SCHEMA_DIR = join(repoRoot, "tests", "deploy", "schemas");
const SCHEMA_LOCATIONS = [
  join(SCHEMA_DIR, "kubernetes", "{{ .NormalizedKubernetesVersion }}-standalone{{ .StrictSuffix }}", "{{ .ResourceKind }}{{ .KindSuffix }}.json"),
  join(SCHEMA_DIR, "crds", "{{ .Group }}", "{{ .ResourceKind }}_{{ .ResourceAPIVersion }}.json"),
];

type KubeconformResult = {
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
function kubeconformReport(manifests: string): KubeconformResult[] {
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
function kubeconformValidate(manifests: string): string[] {
  const resources = kubeconformReport(manifests);
  const notValid = resources.filter((r) => r.status !== "statusValid");
  if (notValid.length > 0) throw new Error(`kubeconform did not validate: ${JSON.stringify(notValid)}`);
  return resources.map((r) => `${r.version} ${r.kind} ${r.name}`);
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

// LC-M3-MANIFEST-CHECK-b acceptance: the schema check itself, run offline.
// Each case below runs kubeconform in offlineEnv() (no kubeconfig, no
// in-cluster variables, every HTTP(S) request sent to a dead proxy) against
// the vendored schemas only, and requires kubeconform's own verdict on the
// object: statusInvalid for a schema violation, never statusError (which is
// what a missing schema or a failed fetch would produce).

// A minimal Deployment whose `spec` opens with the given line.
function deploymentWith(specLine: string): string {
  return [
    "apiVersion: apps/v1",
    "kind: Deployment",
    "metadata:",
    "  name: web",
    "spec:",
    `  ${specLine}`,
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
}

// The environment offlineEnv() gives a validator really has no cluster to
// reach, no credential to read and no network route.
function assertOffline(): void {
  const env = offlineEnv();
  assert.ok(env["KUBECONFIG"] && !existsSync(env["KUBECONFIG"]), "KUBECONFIG names no file");
  assert.equal(env["KUBERNETES_SERVICE_HOST"], undefined);
  assert.equal(env["KUBERNETES_SERVICE_PORT"], undefined);
  for (const v of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) assert.equal(env[v], DEAD_PROXY, v);
  for (const v of ["NO_PROXY", "no_proxy"]) assert.equal(env[v], undefined, v);
}

// kubeconform's single verdict on a one-object manifest.
function verdict(manifest: string): KubeconformResult {
  const resources = kubeconformReport(manifest);
  assert.equal(resources.length, 1, `one verdict expected: ${JSON.stringify(resources)}`);
  return resources[0]!;
}

test("rejects a Deployment whose spec.replicas is a string without cluster or network access", () => {
  assertOffline();
  // The same offline call passes a well-typed Deployment, so the rejection
  // comes from the schema and not from a missing tool, schema or network.
  assert.equal(verdict(deploymentWith("replicas: 2")).status, "statusValid");

  const bad = deploymentWith('replicas: "invalid"');
  // kubectl's offline dry-run alone lets it through.
  assert.deepEqual(kubectlDryRun(bad).map((o) => o["spec"]?.["replicas"]), ["invalid"]);

  const v = verdict(bad);
  assert.equal(v.status, "statusInvalid", JSON.stringify(v));
  assert.equal(v.kind, "Deployment");
  // The finding names the field (neither the kind nor the name does).
  assert.match(`${v.msg} ${JSON.stringify(v.validationErrors ?? [])}`, /replicas/, JSON.stringify(v));
  // And the check as CI applies it fails.
  assert.throws(() => validate(bad), /replicas/);
});

test("rejects a resource carrying a field its schema does not define", () => {
  assertOffline();
  // `spec.replica` (a misspelt `spec.replicas`) is not in the Deployment
  // schema; strict mode rejects it rather than ignoring it.
  const bad = deploymentWith("replica: 2");
  const v = verdict(bad);
  assert.equal(v.status, "statusInvalid", JSON.stringify(v));
  assert.match(v.msg, /replica/, JSON.stringify(v));
  assert.match(v.msg, /additional ?propert/i, JSON.stringify(v));
  assert.throws(() => validate(bad), /replica/);

  // The same holds for a top-level field on another kind.
  const extra = verdict("apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: x\nnotAField: 1\n");
  assert.equal(extra.status, "statusInvalid", JSON.stringify(extra));
  assert.match(extra.msg, /notAField/, JSON.stringify(extra));
});

test("passes the repository's rendered manifests with no kubeconfig and no network", () => {
  assertOffline();
  const dirs = overlays();
  assert.ok(dirs.includes("deploy"), `expected deploy/ among the overlays, found ${JSON.stringify(dirs)}`);
  for (const dir of dirs) {
    const rendered = kustomizeBuild(join(repoRoot, dir));
    const objs = parseAllDocuments(rendered)
      .map((doc) => doc.toJS() as Obj | null)
      .filter((o): o is Obj => o !== null);
    assert.ok(objs.length > 0, `${dir} renders no objects`);
    const resources = kubeconformReport(rendered);
    const notValid = resources.filter((r) => r.status !== "statusValid");
    assert.deepEqual(notValid, [], `${dir}: kubeconform did not validate every object`);
    assert.deepEqual(
      resources.map((r) => `${r.version} ${r.kind} ${r.name}`).sort(),
      objs.map((o) => `${o["apiVersion"]} ${o["kind"]} ${o["metadata"]?.["name"]}`).sort(),
      `${dir}: kubeconform validated every rendered object`,
    );
  }
});

// Every $ref value anywhere in a JSON document.
function refs(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(refs);
  if (node === null || typeof node !== "object") return [];
  return Object.entries(node).flatMap(([k, v]) => (k === "$ref" && typeof v === "string" ? [v] : refs(v)));
}

function schemaFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? schemaFiles(join(dir, e.name)) : e.name.endsWith(".json") ? [join(dir, e.name)] : [],
  );
}

test("schema validation uses only the checked-in schemas, with no reference that leaves them", () => {
  // kubeconform is given local paths only, never a URL.
  for (const l of SCHEMA_LOCATIONS) {
    assert.ok(l.startsWith(SCHEMA_DIR + "/"), `schema location ${l} is not under ${SCHEMA_DIR}`);
    assert.doesNotMatch(l, /:\/\//, `schema location ${l} is a URL`);
  }

  // The checked-in files are exactly the recorded upstream copies.
  const recorded = new Map(
    readFileSync(join(SCHEMA_DIR, "SHA256SUMS"), "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => {
        const m = /^([0-9a-f]{64})  (\S+)$/.exec(l);
        assert.ok(m, `malformed SHA256SUMS line: ${l}`);
        return [m[2]!, m[1]!] as const;
      }),
  );
  const files = schemaFiles(SCHEMA_DIR);
  assert.deepEqual(files.map((f) => relative(SCHEMA_DIR, f)).sort(), [...recorded.keys()].sort(), "SHA256SUMS lists every schema");
  for (const f of files) {
    const bytes = readFileSync(f);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), recorded.get(relative(SCHEMA_DIR, f)), `${f} checksum`);

    // Self-contained: every $ref (transitively, since all are fragments of the
    // same file) resolves inside the file, and the meta-schema is a draft the
    // validator has built in, so nothing is ever fetched.
    const schema = JSON.parse(bytes.toString("utf8")) as Obj;
    for (const r of refs(schema)) assert.match(r, /^#/, `${f}: $ref ${r} leaves the file`);
    const meta = schema["$schema"];
    if (meta !== undefined) assert.match(String(meta), /^https?:\/\/json-schema\.org\/(schema|draft-0[467]\/schema|draft\/20(19-09|20-12)\/schema)#?$/, `${f}: $schema`);
  }

  // Every kind the overlays and the rejection test validate has a schema here.
  for (const want of [
    "kubernetes/v1.34.1-standalone-strict/configmap-v1.json",
    "kubernetes/v1.34.1-standalone-strict/namespace-v1.json",
    "kubernetes/v1.34.1-standalone-strict/service-v1.json",
    "kubernetes/v1.34.1-standalone-strict/deployment-apps-v1.json",
    "kubernetes/v1.34.1-standalone-strict/cronjob-batch-v1.json",
    "crds/postgresql.cnpg.io/cluster_v1.json",
    "crds/external-secrets.io/externalsecret_v1.json",
  ]) {
    assert.ok(recorded.has(want), `missing schema ${want}`);
  }
});
