// LC-D1c acceptance: the aks-obs-01 package's ExternalSecret syncs the
// loopcloser API keys from OpenBao path kv/loopcloser/api, through the estate
// `openbao` ClusterSecretStore, into the `loopcloser-api-keys` Secret under
// the per-principal key names the API's boot-time loader reads
// (src/config.ts: API_KEYS_DIR, loadApiKeys: one file per agent principal).
//
// Renders deploy/ with a real kustomize: $KUSTOMIZE if set, else `kustomize`
// on PATH, else `kubectl kustomize` ($KUBECTL or `kubectl`). A missing tool
// fails the test; it never skips. Nothing here talks to a cluster or reads a
// secret: the OpenBao payload below is a made-up fixture.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";
import { API_KEYS_DIR, loadApiKeys } from "../../src/config.ts";

type Obj = Record<string, any>;

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const deployDir = join(repoRoot, "deploy");

const OPENBAO_PATH = "kv/loopcloser/api";
const STORE = { kind: "ClusterSecretStore", name: "openbao" };
const SECRET = "loopcloser-api-keys";
const PULL_SECRET = "loopcloser-registry-pull";
const PULL_OPENBAO_PATH = "kv/loopcloser/registry-pull";

function onPath(bin: string): boolean {
  try {
    execFileSync(bin, ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function render(): Obj[] {
  const explicit = process.env["KUSTOMIZE"];
  const out = explicit
    ? execFileSync(explicit, ["build", deployDir], { encoding: "utf8" })
    : onPath("kustomize")
      ? execFileSync("kustomize", ["build", deployDir], { encoding: "utf8" })
      : execFileSync(process.env["KUBECTL"] || "kubectl", ["kustomize", deployDir], { encoding: "utf8" });
  return parseAllDocuments(out)
    .map((doc) => {
      assert.equal(doc.errors.length, 0, String(doc.errors[0]));
      return doc.toJS() as Obj | null;
    })
    .filter((o): o is Obj => o !== null);
}

function apiKeysExternalSecret(objs: Obj[]): Obj {
  const found = objs.filter((o) => o["kind"] === "ExternalSecret" && o["spec"]?.["target"]?.["name"] === SECRET);
  assert.equal(found.length, 1, `expected exactly one ExternalSecret targeting ${SECRET}`);
  return found[0]!;
}

// What ESO writes into the target Secret for a given OpenBao payload, under
// the rendered spec: dataFrom.extract with no rewrite, conversion, decoding or
// template copies every property of the source under its own name.
function syncedSecretData(es: Obj, payload: Record<string, string>): Record<string, string> {
  const spec = es["spec"] as Obj;
  const extract = (spec["dataFrom"] as Obj[])[0]!["extract"] as Obj;
  assert.equal(extract["key"], OPENBAO_PATH);
  for (const field of ["property", "version", "metadataPolicy"]) assert.equal(extract[field], undefined, `extract.${field}`);
  assert.equal(extract["conversionStrategy"] ?? "Default", "Default", "property names are not converted");
  assert.equal(extract["decodingStrategy"] ?? "None", "None", "values are not decoded");
  assert.equal((spec["dataFrom"] as Obj[])[0]!["rewrite"], undefined, "property names are not rewritten");
  assert.equal(spec["target"]["template"], undefined, "no template renames or drops keys");
  return { ...payload };
}

test("the rendered ExternalSecret maps every API key name the service config requires from kv/loopcloser/api", () => {
  const objs = render();
  const es = apiKeysExternalSecret(objs);

  // The target is the Secret the API mounts, owned by the ExternalSecret.
  assert.equal(es["spec"]["target"]["name"], SECRET);
  assert.equal(es["spec"]["target"]["creationPolicy"] ?? "Owner", "Owner");

  // The Deployment mounts that Secret, whole, at the loader's directory.
  const deploys = objs.filter((o) => o["kind"] === "Deployment" && o["metadata"]?.["name"] === "loopcloser");
  assert.equal(deploys.length, 1);
  const pod = deploys[0]!["spec"]["template"]["spec"] as Obj;
  const volume = (pod["volumes"] as Obj[]).find((v) => v["secret"]?.["secretName"] === SECRET);
  assert.ok(volume, `the API pod mounts ${SECRET}`);
  assert.equal(volume["secret"]["items"], undefined, "every key of the Secret is projected, none filtered");
  const api = (pod["containers"] as Obj[]).find((c) => c["name"] === "api");
  assert.ok(api);
  const mount = (api["volumeMounts"] as Obj[]).find((m) => m["name"] === volume["name"]);
  assert.equal(mount?.["mountPath"], API_KEYS_DIR, "mounted where loadApiKeys reads");
  assert.equal(mount?.["subPath"], undefined);

  // End to end: an OpenBao payload of per-principal properties, synced and
  // projected as files, loads back as exactly those principals and keys.
  const payload = { juno: "fixture-key-juno", hermes: "fixture-key-hermes", joe: "fixture-key-joe" };
  const data = syncedSecretData(es, payload);
  const dir = mkdtempSync(join(tmpdir(), "loopcloser-api-keys-"));
  try {
    for (const [name, value] of Object.entries(data)) writeFileSync(join(dir, name), value);
    assert.deepEqual(Object.fromEntries(loadApiKeys(dir)), payload);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the ExternalSecret reads only kv/loopcloser/api through the estate OpenBao ClusterSecretStore", () => {
  const objs = render();
  const externalSecrets = objs.filter((o) => o["kind"] === "ExternalSecret");
  assert.deepEqual(
    externalSecrets.map((o) => o["spec"]?.["target"]?.["name"]).sort(),
    [SECRET, PULL_SECRET].sort(),
    "the API keys and the registry pull credential are the package's only synced secrets",
  );
  const es = apiKeysExternalSecret(objs);
  const spec = es["spec"] as Obj;

  assert.deepEqual(spec["secretStoreRef"], STORE);
  assert.equal(spec["data"], undefined, "no per-key data entries reading other paths");
  const dataFrom = spec["dataFrom"] as Obj[];
  assert.equal(dataFrom.length, 1, "one source");
  const source = dataFrom[0]!;
  assert.deepEqual(Object.keys(source), ["extract"], "an extract of one path; no find, generator or rewrite");
  assert.equal(source["extract"]["key"], OPENBAO_PATH);
  assert.equal(source["sourceRef"], undefined, "no per-source store override");
});

// LC-D1b-PULL acceptance: loop-closer's own pull-only registry credential
// (policy registry-credential-per-product v2), custodied in OpenBao under the
// loop-closer product path, is synced into a kubernetes.io/dockerconfigjson
// Secret that the loopcloser Pods name in imagePullSecrets. The manifest
// carries only OpenBao references, never a literal registry, user or token.
const PULL_TEMPLATE =
  '{{ dict "auths" (dict .registry (dict "username" .username "password" .password ' +
  '"auth" (printf "%s:%s" .username .password | b64enc))) | toJson }}';

function pullExternalSecret(objs: Obj[]): Obj {
  const found = objs.filter((o) => o["kind"] === "ExternalSecret" && o["spec"]?.["target"]?.["name"] === PULL_SECRET);
  assert.equal(found.length, 1, `expected exactly one ExternalSecret targeting ${PULL_SECRET}`);
  return found[0]!;
}

test("the registry pull ExternalSecret renders a dockerconfigjson secret from the loop-closer OpenBao pull path and no literal credential", () => {
  const es = pullExternalSecret(render());
  const spec = es["spec"] as Obj;

  assert.equal(es["metadata"]["name"], PULL_SECRET);
  assert.deepEqual(spec["secretStoreRef"], STORE);
  assert.equal(spec["dataFrom"], undefined, "reads named properties only, no bulk extract");

  // Each templated value comes from one property of the loop-closer pull path.
  const data = spec["data"] as Obj[];
  assert.deepEqual(
    data.map((d) => [d["secretKey"], d["remoteRef"]?.["key"], d["remoteRef"]?.["property"]]),
    [
      ["registry", PULL_OPENBAO_PATH, "registry"],
      ["username", PULL_OPENBAO_PATH, "username"],
      ["password", PULL_OPENBAO_PATH, "password"],
    ],
  );
  for (const d of data) {
    assert.equal(d["sourceRef"], undefined, "no per-entry store override");
    assert.match(d["remoteRef"]["key"], /^kv\/loopcloser\//, "under the loop-closer product path");
    assert.doesNotMatch(d["remoteRef"]["key"], /passband|shared|estate/, "never a shared or other product's path");
  }

  // The target is a dockerconfigjson Secret owned by the ExternalSecret, whose
  // only key is built from those properties.
  const target = spec["target"] as Obj;
  assert.equal(target["creationPolicy"] ?? "Owner", "Owner");
  const template = target["template"] as Obj;
  assert.equal(template["type"], "kubernetes.io/dockerconfigjson");
  assert.equal(template["engineVersion"] ?? "v2", "v2");
  assert.deepEqual(Object.keys(template["data"]), [".dockerconfigjson"]);
  assert.equal(template["data"][".dockerconfigjson"], PULL_TEMPLATE);

  // No literal credential anywhere in the resource: every value the template
  // emits is an OpenBao property reference, and nothing looks like a token.
  const text = JSON.stringify(es);
  assert.doesNotMatch(text, /"auths"\s*:\s*\{\s*"[^"{]/, "no literal registry host in auths");
  assert.doesNotMatch(text, /ghp_|gho_|github_pat_|glpat-|[A-Za-z0-9+/]{40,}={0,2}/, "no token-shaped literal");
  const refs = [...PULL_TEMPLATE.matchAll(/\.(\w+)/g)].map((m) => m[1]);
  for (const r of refs) assert.ok(["registry", "username", "password"].includes(r!), `template reads .${r}`);
});
