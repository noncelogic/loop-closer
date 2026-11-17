// LC-EST-TICK acceptance: deploy/overlays/aks-obs-01 renders the loopcloser
// tick CronJob unsuspended, on its every-minute schedule (TECH-STACK.md §6)
// and on the overlay's pinned estate-registry loopcloser:sha-<commit> image,
// so armed Whens fire on the estate without any harness being awake. The
// base package keeps it suspended (tests/deploy/manifests.test.ts); only the
// estate overlay turns it on.
//
// Renders with a real kustomize and validates with the offline schema check
// (tests/deploy/manifest-check.ts). Nothing here talks to a cluster.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { kustomizeBuild, parseObjects, repoRoot, validate, type Obj } from "./manifest-check.ts";

const OVERLAY = join(repoRoot, "deploy", "overlays", "aks-obs-01");
const TICK = "loopcloser-tick";
const API = "loopcloser";
const SCHEMA_JOB = "loopcloser-schema";
const ESTATE_IMAGE = /^[a-z0-9.-]+(?::[0-9]+)?(?:\/[a-z0-9._-]+)*\/loopcloser:sha-[0-9a-f]{40}$/;

function one(objs: Obj[], kind: string, name: string): Obj {
  const found = objs.filter((o) => o["kind"] === kind && o["metadata"]?.["name"] === name);
  assert.equal(found.length, 1, `expected exactly one ${kind}/${name}`);
  return found[0]!;
}

function wave(o: Obj): number {
  return Number(o["metadata"]?.["annotations"]?.["argocd.argoproj.io/sync-wave"] ?? "0");
}

test("the aks-obs-01 overlay renders the tick CronJob unsuspended on the pinned loopcloser image", () => {
  const rendered = kustomizeBuild(OVERLAY);
  const objs = parseObjects(rendered);
  const tick = one(objs, "CronJob", TICK);
  const api = one(objs, "Deployment", API);
  const job = one(objs, "Job", SCHEMA_JOB);

  // Enabled, every minute, never overlapping.
  assert.equal(tick["spec"]["suspend"], false, "the tick CronJob is unsuspended on the estate");
  assert.equal(tick["spec"]["schedule"], "* * * * *", "the tick runs every minute");
  assert.equal(tick["spec"]["concurrencyPolicy"], "Forbid");

  // The tick entrypoint on the one pinned image the API runs.
  const pod = tick["spec"]["jobTemplate"]["spec"]["template"]["spec"] as Obj;
  assert.equal((pod["containers"] as Obj[]).length, 1);
  const c = pod["containers"][0] as Obj;
  assert.match(c["image"], ESTATE_IMAGE, "pinned <estate registry>/loopcloser:sha-<commit>, never a floating tag");
  assert.equal(c["image"], api["spec"]["template"]["spec"]["containers"][0]["image"], "the API's image");
  assert.deepEqual(c["command"], ["node", "dist/tick.js"]);
  assert.deepEqual(
    (c["env"] as Obj[]).find((e) => e["name"] === "DATABASE_URL")?.["valueFrom"],
    { secretKeyRef: { name: "loopcloser-db-app", key: "uri" } },
  );
  assert.deepEqual(pod["imagePullSecrets"], [{ name: "loopcloser-registry-pull" }]);

  // A live tick claims due Whens, so it syncs only after the schema Job has migrated the database.
  assert.ok(wave(tick) > wave(job), `the tick (wave ${wave(tick)}) syncs after the schema Job (wave ${wave(job)})`);

  // The enabled CronJob still passes the offline schema check.
  assert.ok(
    validate(rendered).some((o) => o["kind"] === "CronJob" && o["metadata"]?.["name"] === TICK),
    "the tick CronJob is schema-validated",
  );
});

// LC-D1b-PULL-CRED-DEPLOY acceptance: the overlay's registry-pull
// ExternalSecret, as rendered for aks-obs-01, reads exactly
// kv/loopcloser/registry-pull with the `registry`, `username` and `password`
// properties: the path and properties the DevOps route populates in OpenBao
// through delegated.openbao (docs/ops/registry-pull.md), so the pull Secret
// the loopcloser Pods list in imagePullSecrets resolves on the estate.
test("the registry-pull ExternalSecret reads exactly kv/loopcloser/registry-pull with the registry, username and password properties", () => {
  const objs = parseObjects(kustomizeBuild(OVERLAY));
  const es = one(objs, "ExternalSecret", "loopcloser-registry-pull");

  assert.equal(es["metadata"]["namespace"], "loop-closer");
  assert.deepEqual(es["spec"]["secretStoreRef"], { kind: "ClusterSecretStore", name: "openbao" });
  assert.equal(es["spec"]["target"]["name"], "loopcloser-registry-pull");
  assert.equal(es["spec"]["target"]["template"]["type"], "kubernetes.io/dockerconfigjson");
  assert.equal(es["spec"]["dataFrom"], undefined, "no dataFrom: only the named properties are read");

  const data = es["spec"]["data"] as Obj[];
  assert.deepEqual(
    data.map((d) => ({ secretKey: d["secretKey"], ...d["remoteRef"] })).sort((a, b) => a.property.localeCompare(b.property)),
    ["password", "registry", "username"].map((p) => ({ secretKey: p, key: "kv/loopcloser/registry-pull", property: p })),
    "exactly kv/loopcloser/registry-pull, properties registry, username and password",
  );
});
