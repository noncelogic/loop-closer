// LC-EST-SYNC acceptance: Argo CD syncs deploy/overlays/aks-obs-01 on
// aks-obs-01 (Rule: policies/placement-defaults.yaml#estate, Argo CD from Git),
// and the loopcloser schema completes before any API pod rolls out, so neither
// the API nor a scheduled job runs against an incomplete schema.
//
// Argo CD applies a sync phase wave by wave and starts a wave only once every
// resource of the earlier waves is healthy; a Job hook is healthy only when it
// has completed. So the schema Job (`node dist/migrate.js`) must be a Sync-phase
// hook in a wave strictly earlier than every workload that runs loopcloser
// code: the API Deployment, every CronJob, and any other pod-creating resource.
// None of those may itself be a hook (a PreSync hook would run before the
// schema Job whatever its wave).
//
// Renders the overlay with a real kustomize (tests/deploy/manifest-check.ts).
// Nothing here talks to a cluster, a registry or Argo CD.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { kustomizeBuild, parseObjects, repoRoot, type Obj } from "../../tests/deploy/manifest-check.ts";

const OVERLAY = join(repoRoot, "deploy", "overlays", "aks-obs-01");
const SCHEMA_JOB = "loopcloser-schema";
const API = "loopcloser";
const WORKLOAD_KINDS = new Set(["Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Pod", "Job", "CronJob"]);

function name(o: Obj): string {
  return `${o["kind"]}/${o["metadata"]?.["name"]}`;
}

function annotations(o: Obj): Record<string, string> {
  return (o["metadata"]?.["annotations"] ?? {}) as Record<string, string>;
}

function wave(o: Obj): number {
  const w = annotations(o)["argocd.argoproj.io/sync-wave"] ?? "0";
  assert.match(w, /^-?[0-9]+$/, `${name(o)} sync-wave is an integer`);
  return Number(w);
}

test("the schema migration runs in an earlier sync wave than the API Deployment and every CronJob", () => {
  const objs = parseObjects(kustomizeBuild(OVERLAY));

  const jobs = objs.filter((o) => o["kind"] === "Job" && o["metadata"]?.["name"] === SCHEMA_JOB);
  assert.equal(jobs.length, 1, `exactly one Job/${SCHEMA_JOB}`);
  const job = jobs[0]!;
  const migrate = job["spec"]["template"]["spec"]["containers"] as Obj[];
  assert.deepEqual(
    migrate.map((c) => c["command"]),
    [["node", "dist/migrate.js"]],
    "the schema Job runs only the migrate entrypoint",
  );
  // A Sync-phase hook: Argo CD runs it in its wave and waits for it to complete
  // before the next wave; a failed migration fails the sync and nothing later applies.
  assert.equal(annotations(job)["argocd.argoproj.io/hook"], "Sync", "the schema Job is a Sync-phase hook");

  const workloads = objs.filter((o) => WORKLOAD_KINDS.has(o["kind"]) && o !== job);
  const deployments = workloads.filter((o) => o["kind"] === "Deployment");
  const cronJobs = workloads.filter((o) => o["kind"] === "CronJob");
  assert.ok(
    deployments.some((o) => o["metadata"]["name"] === API),
    `the overlay renders the API Deployment/${API}`,
  );
  assert.ok(cronJobs.length >= 2, "the overlay renders the tick and listings-read CronJobs");

  for (const o of workloads) {
    assert.equal(annotations(o)["argocd.argoproj.io/hook"], undefined, `${name(o)} is a synced resource, not a hook`);
    assert.ok(
      wave(o) > wave(job),
      `${name(o)} (wave ${wave(o)}) syncs after the schema Job (wave ${wave(job)})`,
    );
  }
});

test("npm test runs this acceptance file", () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as Obj;
  const script = String(pkg["scripts"]["test"]);
  const self = relative(repoRoot, fileURLToPath(import.meta.url));
  const dir = self.split("/").slice(0, -1).join("/");
  assert.ok(script.includes(`"${dir}/**/*.test.ts"`), `the npm test script globs ${dir}/**/*.test.ts (${self})`);
});
