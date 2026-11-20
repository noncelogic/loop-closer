// LC-SENSE-LISTING-BINDINGS acceptance: the suspended listings-read CronJob in
// deploy/overlays/aks-obs-01 carries no listing URL and mounts no listing-URL
// ConfigMap. The scheduled read takes its targets from the graph (the
// source_binding of each armed event When in an open directory-listing loop,
// test/sensors/listings-read-targets.test.ts), so a listing is tracked through
// intake and no deploy change carries a listing URL.
//
// Rendered-manifest checks only (a real kustomize, tests/deploy/manifest-check.ts);
// nothing here reads a listing page, a cluster or a secret.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { kustomizeBuild, parseObjects, repoRoot, type Obj } from "../../tests/deploy/manifest-check.ts";

const OVERLAY = join(repoRoot, "deploy", "overlays", "aks-obs-01");
const LISTINGS_READ = "loopcloser-listings-read";
const URL_RE = /https?:\/\/[^\s"'<>)\]\\]+/g;

function one(objs: Obj[], kind: string, name: string): Obj {
  const found = objs.filter((o) => o["kind"] === kind && o["metadata"]?.["name"] === name);
  assert.equal(found.length, 1, `expected exactly one ${kind}/${name}`);
  return found[0]!;
}

/** Every ConfigMap name a pod spec reaches: env, envFrom and volumes (including projected sources). */
function configMapRefs(pod: Obj): string[] {
  const names: string[] = [];
  for (const c of [...((pod["containers"] as Obj[]) ?? []), ...((pod["initContainers"] as Obj[]) ?? [])]) {
    for (const e of (c["env"] as Obj[]) ?? []) {
      const ref = e["valueFrom"]?.["configMapKeyRef"];
      if (ref) names.push(ref["name"]);
    }
    for (const e of (c["envFrom"] as Obj[]) ?? []) if (e["configMapRef"]) names.push(e["configMapRef"]["name"]);
  }
  for (const v of (pod["volumes"] as Obj[]) ?? []) {
    if (v["configMap"]) names.push(v["configMap"]["name"]);
    for (const s of (v["projected"]?.["sources"] as Obj[]) ?? []) if (s["configMap"]) names.push(s["configMap"]["name"]);
  }
  return names;
}

test("the aks-obs-01 listings-read CronJob stays suspended and mounts no listing-URL ConfigMap", () => {
  const objs = parseObjects(kustomizeBuild(OVERLAY));
  const cron = one(objs, "CronJob", LISTINGS_READ);
  assert.equal(cron["spec"]["suspend"], true, "the listings-read CronJob stays suspended");

  const pod = cron["spec"]["jobTemplate"]["spec"]["template"]["spec"] as Obj;
  assert.deepEqual(configMapRefs(pod), [], "the CronJob reaches no ConfigMap");
  const containers = pod["containers"] as Obj[];
  assert.equal(containers.length, 1);
  const env = ((containers[0]!["env"] as Obj[]) ?? []).map((e) => e["name"] as string);
  assert.deepEqual(env, ["DATABASE_URL"], "the graph is the read's only input");
  assert.equal(containers[0]!["args"], undefined, "no URL passed as an argument");
  assert.deepEqual(JSON.stringify(cron).match(URL_RE) ?? [], [], "the CronJob names no URL");

  // The overlay renders no listing-URL ConfigMap at all, and no listings component object besides the CronJob.
  for (const o of objs) {
    if (o["metadata"]?.["labels"]?.["app.kubernetes.io/component"] !== "listings-read") continue;
    assert.equal(o["kind"], "CronJob", `${o["kind"]}/${o["metadata"]["name"]} is not part of the listings read`);
  }
  for (const config of objs.filter((o) => o["kind"] === "ConfigMap")) {
    assert.match(config["metadata"]["name"], /^loopcloser-api-scopes-[a-z0-9]+$/);
    assert.deepEqual(Object.keys(config["data"]), ["hermes"], "the API scope map holds only principal grants");
    assert.deepEqual(JSON.stringify(config).match(URL_RE) ?? [], [], "the API scope map contains no listing URL");
  }
});
