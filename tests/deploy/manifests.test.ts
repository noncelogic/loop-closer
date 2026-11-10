// LC-D1 acceptance: the deploy/ kustomize package for aks-obs-01 renders, and
// the API Deployment's environment matches the frozen config contract
// (src/config.ts: PORT, DATABASE_URL).
//
// Renders with a real kustomize: $KUSTOMIZE if set, else `kustomize` on PATH,
// else `kubectl kustomize`. Nothing here talks to a cluster.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
  return execFileSync("kubectl", ["kustomize", dir], { encoding: "utf8" });
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
