// LC-EST-TICK acceptance: deploy/overlays/aks-obs-01 renders the loopcloser
// tick CronJob unsuspended, on its every-minute schedule (TECH-STACK.md §6)
// and on the overlay's pinned estate-registry loopcloser image (its
// sha-<commit> tag, or the verified digest the publish run pushed),
// so armed Whens fire on the estate without any harness being awake. The
// base package keeps it suspended (tests/deploy/manifests.test.ts); only the
// estate overlay turns it on.
//
// Renders with a real kustomize and validates with the offline schema check
// (tests/deploy/manifest-check.ts). Nothing here talks to a cluster.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { kustomizeBuild, parseObjects, repoRoot, validate, type Obj } from "./manifest-check.ts";
import {
  assertVerifiedEvidence,
  overlayImageEntry,
  PINNED_ESTATE_IMAGE,
  readEvidence,
  type ImageEvidence,
} from "./estate-image-pin.ts";

const OVERLAY = join(repoRoot, "deploy", "overlays", "aks-obs-01");
const TICK = "loopcloser-tick";
const API = "loopcloser";
const SCHEMA_JOB = "loopcloser-schema";

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
  assert.match(c["image"], PINNED_ESTATE_IMAGE, "pinned <estate registry>/loopcloser by sha-<commit> or digest, never a floating tag");
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

// LC-EST-IMAGE-READY acceptance: the overlay pins the loopcloser image by the
// sha256 digest .github/workflows/estate-image.yml pushed (its publish job's
// `Record pushed digest` step), and only after that digest was pulled on
// aks-obs-01 with kv/loopcloser/registry-pull through the DevOps route, as
// recorded, without secrets, in deploy/overlays/aks-obs-01/image-evidence.json.
// Promotion is that file plus the overlay's `digest:` in one change, so Argo CD
// never syncs an image nobody has pulled. Until a publish run has pushed a
// digest and the pull of it is verified, no evidence exists and this test is
// reported as todo (unmet), never as passing; once the evidence is recorded it
// gates like any other test.
const EVIDENCE = readEvidence();

function publishJob(): Obj[] {
  const wf = parse(readFileSync(join(repoRoot, ".github", "workflows", "estate-image.yml"), "utf8")) as Obj;
  return wf["jobs"]["publish"]["steps"] as Obj[];
}

test(
  "the overlay pins the loopcloser image by the digest the publish workflow pushed",
  { todo: EVIDENCE ? false : "no estate-image publish run has a verified aks-obs-01 pull recorded in deploy/overlays/aks-obs-01/image-evidence.json yet" },
  () => {
    assert.ok(EVIDENCE, "deploy/overlays/aks-obs-01/image-evidence.json records the publish run and the verified pull");
    assertVerifiedEvidence(EVIDENCE);

    // The publish workflow reports the digest the registry returned for its push.
    const steps = publishJob();
    const push = steps.findIndex((s) => String(s["uses"] ?? "").startsWith("docker/build-push-action@"));
    assert.equal(steps[push]?.["id"], "push");
    const record = steps.findIndex((s) => s["name"] === "Record pushed digest");
    assert.ok(record > push, "the publish job records the digest after pushing");
    assert.equal(steps[record]!["env"]["DIGEST"], "${{ steps.push.outputs.digest }}");
    assert.equal(steps[record]!["env"]["IMAGE"], "${{ vars.ESTATE_REGISTRY }}/loopcloser");

    // The overlay pins exactly that digest of that repository, with no tag.
    const entry = overlayImageEntry();
    assert.equal(entry["newName"], EVIDENCE.image, "the repository the publish run pushed to");
    assert.equal(entry["digest"], EVIDENCE.digest, "the digest the publish run pushed and aks-obs-01 pulled");
    assert.equal(entry["newTag"], undefined, "pinned by digest, not by a mutable tag");

    // Every rendered loopcloser container runs that digest.
    const want = `${EVIDENCE.image}@${EVIDENCE.digest}`;
    const objs = parseObjects(kustomizeBuild(OVERLAY));
    const workloads = objs.filter((o) => ["Deployment", "Job", "CronJob"].includes(o["kind"]));
    assert.ok(workloads.length > 0);
    for (const o of workloads) {
      const pod = o["kind"] === "CronJob" ? o["spec"]["jobTemplate"]["spec"]["template"]["spec"] : o["spec"]["template"]["spec"];
      for (const c of pod["containers"] as Obj[]) assert.equal(c["image"], want, `${o["kind"]}/${o["metadata"]["name"]} image`);
      assert.deepEqual(pod["imagePullSecrets"], [{ name: "loopcloser-registry-pull" }]);
    }
  },
);

// Gates now: a digest enters the overlay only with the verified evidence for
// that digest, and recorded evidence is promoted in the same change.
test("the overlay pins a digest only together with the verified publish and pull evidence for that digest", () => {
  const entry = overlayImageEntry();
  if (entry["digest"] === undefined) {
    assert.equal(EVIDENCE, undefined, "recorded evidence is promoted into the overlay's digest in the same change");
    assert.match(String(entry["newTag"]), /^sha-[0-9a-f]{40}$/, "until then the overlay pins a sha-<commit> tag");
    return;
  }
  assert.ok(EVIDENCE, `digest ${entry["digest"]} is pinned without image-evidence.json: no verified pull precedes the sync`);
  assertVerifiedEvidence(EVIDENCE);
  assert.equal(entry["digest"], EVIDENCE.digest);
  assert.equal(entry["newTag"], undefined);
});

// The evidence check is real: a complete record passes, and each gap fails.
test("the image evidence check rejects a record without a matching verified pull or with a secret", () => {
  // Synthetic values for the checker only; never copied into the overlay.
  const digest = `sha256:${"a".repeat(64)}`;
  const good: ImageEvidence = {
    image: "noncelogicci.azurecr.io/loopcloser",
    digest,
    publish: { workflow: "estate-image", job: "publish", run: 1, sourceCommit: "b".repeat(40) },
    pull: {
      cluster: "aks-obs-01",
      namespace: "loop-closer",
      credential: "kv/loopcloser/registry-pull",
      pullSecret: "loopcloser-registry-pull",
      route: "DevOps",
      digest,
      verifiedAt: "2026-11-18T00:00:00Z",
      evidence: "synthetic",
    },
  };
  assertVerifiedEvidence(good);
  const bad: [string, ImageEvidence][] = [
    ["another digest pulled", { ...good, pull: { ...good.pull, digest: `sha256:${"c".repeat(64)}` } }],
    ["another credential", { ...good, pull: { ...good.pull, credential: "kv/passband/ghcr-pull" } }],
    ["another cluster", { ...good, pull: { ...good.pull, cluster: "aks-dev-01" } }],
    ["not a digest", { ...good, digest: "sha-" + "b".repeat(40) }],
    ["no publish run", { ...good, publish: { ...good.publish, run: 0 } }],
    ["short commit", { ...good, publish: { ...good.publish, sourceCommit: "bbbbbbb" } }],
    ["no pull evidence", { ...good, pull: { ...good.pull, evidence: " " } }],
    ["a secret value", { ...good, pull: { ...good.pull, password: "x" } as ImageEvidence["pull"] }],
  ];
  for (const [why, e] of bad) assert.throws(() => assertVerifiedEvidence(e), `${why} is rejected`);
});
