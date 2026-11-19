// LC-EST-PULL-REGISTRY acceptance: deploy/overlays/aks-obs-01 pulls the
// loopcloser image from the registry .github/workflows/estate-image.yml
// pushes it to, `<ESTATE_REGISTRY>/loopcloser`, and the registry-pull runbook
// (docs/ops/registry-pull.md) writes kv/loopcloser/registry-pull for that same
// host. ESTATE_REGISTRY is a repository variable; its value is recorded in
// docs/ops/estate-image.md ("Repository variables"). Were the overlay or the
// pull credential to name another registry (ghcr.io), the cluster would pull
// from a registry the published image is not in.
// Rule: policies/placement-defaults.yaml#credentials (per-product, pull-only).
//
// Renders the overlay with a real kustomize and reads repository files only:
// nothing here reaches a registry, OpenBao or a cluster.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { kustomizeBuild, parseObjects, repoRoot, type Obj } from "./manifest-check.ts";
import { OVERLAY_DIR, PINNED_ESTATE_IMAGE, overlayImageEntry } from "./estate-image-pin.ts";

// The estate registry the publish job pushes to (repository variable
// ESTATE_REGISTRY on noncelogic/loop-closer).
const ESTATE_REGISTRY = "noncelogicci.azurecr.io";

function read(...path: string[]): string {
  return readFileSync(join(repoRoot, ...path), "utf8");
}

// The repository `<registry>/<name>` the publish job pushes, with the registry
// host left as the `${{ vars.ESTATE_REGISTRY }}` expression.
function publishedRepository(): string {
  const wf = parse(read(".github", "workflows", "estate-image.yml")) as Obj;
  const tags = (wf["jobs"]["publish"]["steps"] as Obj[])
    .map((s) => s["with"]?.["tags"])
    .filter((t): t is string => typeof t === "string");
  assert.equal(tags.length, 1, "the publish job pushes one tag");
  const m = /^\$\{\{ vars\.ESTATE_REGISTRY \}\}\/(?<name>[a-z0-9._/-]+):sha-\$\{\{ github\.sha \}\}$/.exec(tags[0]!);
  assert.ok(m, `the publish job pushes <ESTATE_REGISTRY>/<name>:sha-<commit>, not ${tags[0]}`);
  return m.groups!["name"]!;
}

// The ESTATE_REGISTRY value the runbook records: `(`<host>`)` in its row.
function recordedEstateRegistry(): string {
  const m = /^\| `ESTATE_REGISTRY` \|[^\n]*\(`([^`]+)`\)[^\n]*\|$/m.exec(read("docs", "ops", "estate-image.md"));
  assert.ok(m, "docs/ops/estate-image.md records the ESTATE_REGISTRY host");
  return m[1]!;
}

// The registry host kv/loopcloser/registry-pull holds (property `registry`).
function pullRegistry(): string {
  const doc = read("docs", "ops", "registry-pull.md");
  const m = /^\| `registry` \| [^|]*\(`([^`]+)`\)/m.exec(doc);
  assert.ok(m, "docs/ops/registry-pull.md records the pull registry host");
  const writes = [...doc.matchAll(/\bregistry=(\S+)/g)].map((w) => w[1]!);
  assert.deepEqual(writes, [m[1]], "the runbook's write block stores the same registry host");
  return m[1]!;
}

function podSpec(o: Obj): Obj {
  return o["kind"] === "CronJob" ? o["spec"]["jobTemplate"]["spec"]["template"]["spec"] : o["spec"]["template"]["spec"];
}

test("the aks-obs-01 overlay pulls loopcloser from the registry the estate-image publish job pushes to", () => {
  const name = publishedRepository();
  const registry = recordedEstateRegistry();
  assert.equal(registry, ESTATE_REGISTRY, "the recorded ESTATE_REGISTRY is the estate registry");
  const published = `${registry}/${name}`;

  // The overlay's images entry rewrites the base image to the published repository.
  assert.equal(overlayImageEntry()["newName"], published, "the overlay's newName is <ESTATE_REGISTRY>/loopcloser");

  // Every rendered workload container runs an image from the published repository.
  const workloads = parseObjects(kustomizeBuild(OVERLAY_DIR)).filter((o) => ["Deployment", "Job", "CronJob"].includes(o["kind"]));
  assert.ok(workloads.length > 0, "the overlay renders workloads");
  for (const o of workloads) {
    for (const c of podSpec(o)["containers"] as Obj[]) {
      const where = `${o["kind"]}/${o["metadata"]["name"]} container ${c["name"]}`;
      const m = PINNED_ESTATE_IMAGE.exec(c["image"] as string);
      assert.ok(m, `${where} image ${c["image"]} is pinned`);
      assert.equal(m.groups!["repo"], published, `${where} pulls from the published repository`);
      assert.doesNotMatch(c["image"] as string, /^ghcr\.io\//, `${where} never pulls from ghcr.io`);
    }
  }

  // The pull credential the overlay's imagePullSecrets sync covers that registry.
  assert.equal(pullRegistry(), registry, "kv/loopcloser/registry-pull is written for the ESTATE_REGISTRY host");
  assert.doesNotMatch(read("docs", "ops", "registry-pull.md"), /ghcr\.io/, "the registry-pull runbook never names ghcr.io");
});
