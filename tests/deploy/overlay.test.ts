// LC-EST-OVERLAY acceptance: deploy/overlays/aks-obs-01, the overlay the
// estate's Argo CD syncs, pins the API Deployment and the schema Job to one
// estate-registry loopcloser:sha-<commit> image. The Job runs the migrate
// entrypoint with DATABASE_URL from loopcloser-db-app/uri as an Argo CD
// Sync-phase hook, in a wave after the CNPG cluster and before the API. The
// tick CronJob, unsuspended here, is checked by aks-obs-01-overlay.test.ts.
//
// Renders with a real kustomize and validates with the offline schema check
// (tests/deploy/manifest-check.ts). Nothing here talks to a cluster, a
// registry or Argo CD, and no secret is read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { kustomizeBuild, parseObjects, repoRoot, SCHEMA_DIR, validate, type Obj } from "./manifest-check.ts";

const OVERLAY = join(repoRoot, "deploy", "overlays", "aks-obs-01");
const NAMESPACE = "loop-closer";
const DB_CLUSTER = "loopcloser-db";
const DB_SECRET = `${DB_CLUSTER}-app`;
const API = "loopcloser";
const SCHEMA_JOB = "loopcloser-schema";
const PULL_SECRET = "loopcloser-registry-pull";
// .github/workflows/estate-image.yml pushes `<ESTATE_REGISTRY>/loopcloser:sha-<full commit sha>`.
const ESTATE_IMAGE = /^(?<repo>[a-z0-9.-]+(?::[0-9]+)?(?:\/[a-z0-9._-]+)*\/loopcloser):sha-(?<sha>[0-9a-f]{40})$/;

function render(): Obj[] {
  return parseObjects(kustomizeBuild(OVERLAY));
}

function one(objs: Obj[], kind: string, name: string): Obj {
  const found = objs.filter((o) => o["kind"] === kind && o["metadata"]?.["name"] === name);
  assert.equal(found.length, 1, `expected exactly one ${kind}/${name}`);
  return found[0]!;
}

function podSpec(o: Obj): Obj {
  return o["kind"] === "CronJob" ? o["spec"]["jobTemplate"]["spec"]["template"]["spec"] : o["spec"]["template"]["spec"];
}

function soleContainer(o: Obj): Obj {
  const pod = podSpec(o);
  assert.equal(pod["initContainers"], undefined, `${o["kind"]}/${o["metadata"]["name"]} has no init containers`);
  assert.equal((pod["containers"] as Obj[]).length, 1, `${o["kind"]}/${o["metadata"]["name"]} has one container`);
  return pod["containers"][0] as Obj;
}

function annotations(o: Obj): Record<string, string> {
  return (o["metadata"]?.["annotations"] ?? {}) as Record<string, string>;
}

function wave(o: Obj): number {
  const w = annotations(o)["argocd.argoproj.io/sync-wave"] ?? "0";
  assert.match(w, /^-?[0-9]+$/, `${o["kind"]}/${o["metadata"]["name"]} sync-wave is an integer`);
  return Number(w);
}

// The registry host the estate pull credential covers (docs/ops/registry-pull.md,
// property `registry`): the pinned image must come from it or the pull fails.
function pullRegistryHost(): string {
  const doc = readFileSync(join(repoRoot, "docs", "ops", "registry-pull.md"), "utf8");
  const m = /^\| `registry` \| [^|]*\(`([^`]+)`\)/m.exec(doc);
  assert.ok(m, "docs/ops/registry-pull.md records the pull registry host");
  return m[1]!;
}

test("the aks-obs-01 overlay pins the API and the schema Job to the same estate-registry sha tag with DATABASE_URL from loopcloser-db-app", () => {
  const objs = render();
  const api = one(objs, "Deployment", API);
  const job = one(objs, "Job", SCHEMA_JOB);
  const apiContainer = soleContainer(api);
  const jobContainer = soleContainer(job);

  // One image, pinned to the estate registry's sha-<commit> tag: never the
  // floating GHCR `main` tag the base package carries.
  const image = apiContainer["image"] as string;
  const m = ESTATE_IMAGE.exec(image);
  assert.ok(m, `the API image ${image} is <estate registry>/loopcloser:sha-<40-hex commit>`);
  assert.notEqual(m.groups!["repo"], "ghcr.io/noncelogic/loop-closer", "not the CI (job `image`) package");
  assert.equal(m.groups!["repo"]!.split("/")[0], pullRegistryHost(), "the registry the estate pull credential covers");
  assert.equal(jobContainer["image"], image, "the schema Job runs the API's image");

  // Every loopcloser container in the overlay runs that one image.
  for (const o of objs) {
    if (!["Deployment", "Job", "CronJob"].includes(o["kind"])) continue;
    for (const c of podSpec(o)["containers"] as Obj[]) {
      assert.equal(c["image"], image, `${o["kind"]}/${o["metadata"]["name"]} container ${c["name"]} image`);
    }
    assert.deepEqual(podSpec(o)["imagePullSecrets"], [{ name: PULL_SECRET }], `${o["kind"]}/${o["metadata"]["name"]} pulls with ${PULL_SECRET}`);
  }

  // The Job runs the migrate entrypoint against the CNPG app URI, as the API does.
  assert.deepEqual(jobContainer["command"], ["node", "dist/migrate.js"]);
  assert.equal(jobContainer["args"], undefined);
  const dbUrl = { secretKeyRef: { name: DB_SECRET, key: "uri" } };
  const jobEnv = new Map((jobContainer["env"] as Obj[]).map((e) => [e["name"] as string, e]));
  assert.deepEqual([...jobEnv.keys()], ["DATABASE_URL"], "the migrate entrypoint reads DATABASE_URL only");
  assert.deepEqual(jobEnv.get("DATABASE_URL")!["valueFrom"], dbUrl);
  const apiEnv = new Map((apiContainer["env"] as Obj[]).map((e) => [e["name"] as string, e]));
  assert.deepEqual(apiEnv.get("DATABASE_URL")?.["valueFrom"], dbUrl);
  assert.deepEqual(apiContainer["command"], ["node", "dist/main.js"]);

  // Everything namespaced lands in loop-closer, and the Job runs to completion once.
  for (const o of objs) if (o["kind"] !== "Namespace") assert.equal(o["metadata"]["namespace"], NAMESPACE, `${o["kind"]}/${o["metadata"]["name"]} namespace`);
  assert.equal(podSpec(job)["restartPolicy"], "Never");
  assert.equal(podSpec(job)["automountServiceAccountToken"], false);
});

test("the schema Job is a Sync hook ordered after the loopcloser-db cluster and before the API Deployment, with a hook delete policy", () => {
  const objs = render();
  const db = one(objs, "Cluster", DB_CLUSTER);
  const job = one(objs, "Job", SCHEMA_JOB);
  const api = one(objs, "Deployment", API);

  const a = annotations(job);
  assert.equal(a["argocd.argoproj.io/hook"], "Sync", "a Sync-phase hook");
  const policies = (a["argocd.argoproj.io/hook-delete-policy"] ?? "").split(",").map((p) => p.trim());
  assert.ok(policies.length > 0 && policies[0] !== "", "the Job has a hook delete policy");
  for (const p of policies) assert.ok(["HookSucceeded", "HookFailed", "BeforeHookCreation"].includes(p), `known hook delete policy ${p}`);
  // A re-sync replaces the previous run's Job (its image is immutable) rather than failing on it.
  assert.ok(policies.includes("BeforeHookCreation"), "BeforeHookCreation, so each sync runs a fresh Job");

  // The cluster and the API are plain synced resources, not hooks.
  assert.equal(annotations(db)["argocd.argoproj.io/hook"], undefined);
  assert.equal(annotations(api)["argocd.argoproj.io/hook"], undefined);
  assert.ok(wave(db) < wave(job), `the Job (wave ${wave(job)}) runs after the ${DB_CLUSTER} cluster (wave ${wave(db)})`);
  assert.ok(wave(job) < wave(api), `the API (wave ${wave(api)}) rolls out after the Job (wave ${wave(job)})`);

  // What the Job needs is synced in an earlier wave: its namespace and its pull secret.
  for (const o of objs.filter((o) => o["kind"] === "Namespace" || o["kind"] === "ExternalSecret")) {
    assert.ok(wave(o) < wave(job), `${o["kind"]}/${o["metadata"]["name"]} (wave ${wave(o)}) syncs before the Job`);
  }
});

// The vendored Job schema is derived from the vendored CronJob schema's
// jobTemplate (tests/deploy/schemas/README.md); it must stay exactly that.
function derivedJobSchema(): Obj {
  const k8s = join(SCHEMA_DIR, "kubernetes", "v1.34.1-standalone-strict");
  const cron = JSON.parse(readFileSync(join(k8s, "cronjob-batch-v1.json"), "utf8")) as Obj;
  const p = cron["properties"] as Obj;
  const jt = p["spec"]["properties"]["jobTemplate"]["properties"] as Obj;
  return {
    description: "Job represents the configuration of a single job.",
    properties: {
      apiVersion: p["apiVersion"],
      kind: { ...p["kind"], enum: ["Job"] },
      metadata: jt["metadata"],
      spec: jt["spec"],
    },
    type: "object",
    "x-kubernetes-group-version-kind": [{ group: "batch", kind: "Job", version: "v1" }],
    additionalProperties: false,
    $schema: cron["$schema"],
  };
}

test("the rendered aks-obs-01 overlay passes the offline schema check including the Job and the tick CronJob", () => {
  const k8s = join(SCHEMA_DIR, "kubernetes", "v1.34.1-standalone-strict");
  assert.deepEqual(JSON.parse(readFileSync(join(k8s, "job-batch-v1.json"), "utf8")), derivedJobSchema(), "job-batch-v1.json is the derived schema");

  const rendered = kustomizeBuild(OVERLAY);
  const objs = parseObjects(rendered);
  const validated = validate(rendered).map((o) => `${o["apiVersion"]} ${o["kind"]} ${o["metadata"]?.["name"]}`);
  assert.ok(validated.includes(`batch/v1 Job ${SCHEMA_JOB}`), "the schema Job is schema-validated");
  assert.ok(validated.includes(`apps/v1 Deployment ${API}`), "the API Deployment is schema-validated");
  assert.equal(validated.length, objs.length, "every rendered object is schema-validated");

  // The schema check rejects a mistyped Job field, so the Job's pass is real.
  const job = one(objs, "Job", SCHEMA_JOB);
  assert.equal(typeof job["spec"]["backoffLimit"], "number", "the rendered Job sets backoffLimit");
  const badJob = stringify({ ...job, spec: { ...job["spec"], backoffLimit: "three" } });
  assert.throws(() => validate(badJob), /backoffLimit/);

  assert.ok(validated.includes("batch/v1 CronJob loopcloser-tick"), "the tick CronJob is schema-validated");
});
