// How deploy/overlays/aks-obs-01 pins the loopcloser image, shared by
// tests/deploy/overlay.test.ts and tests/deploy/aks-obs-01-overlay.test.ts
// (LC-EST-IMAGE-READY).
//
// The overlay's `images` entry pins one estate-registry image either by the
// `sha-<commit>` tag .github/workflows/estate-image.yml pushes, or, once that
// push is proven pullable on aks-obs-01, by the sha256 digest the publish run
// reported. A digest goes into the overlay only together with
// deploy/overlays/aks-obs-01/image-evidence.json, the nonsecret record of the
// publish run that pushed it and the pull of it on aks-obs-01 with
// kv/loopcloser/registry-pull, so the verified pull precedes Argo CD's sync.
// Reads repository files only: nothing here reaches a registry or a cluster.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { repoRoot, type Obj } from "./manifest-check.ts";

export const OVERLAY_DIR = join(repoRoot, "deploy", "overlays", "aks-obs-01");
export const EVIDENCE_FILE = join(OVERLAY_DIR, "image-evidence.json");
export const PULL_CREDENTIAL = "kv/loopcloser/registry-pull";
export const PULL_SECRET = "loopcloser-registry-pull";

const REPO = String.raw`[a-z0-9.-]+(?::[0-9]+)?(?:\/[a-z0-9._-]+)*\/loopcloser`;
export const SHA256 = /^sha256:[0-9a-f]{64}$/;
export const COMMIT = /^[0-9a-f]{40}$/;

/** A rendered estate image, pinned by commit tag or by digest; never floating. */
export const PINNED_ESTATE_IMAGE = new RegExp(
  `^(?<repo>${REPO})(?::sha-(?<sha>[0-9a-f]{40})|@(?<digest>sha256:[0-9a-f]{64}))$`,
);

/** The overlay's one `images` entry, as written in kustomization.yaml. */
export function overlayImageEntry(): Obj {
  const k = parse(readFileSync(join(OVERLAY_DIR, "kustomization.yaml"), "utf8")) as Obj;
  const images = (k["images"] ?? []) as Obj[];
  assert.equal(images.length, 1, "the overlay has exactly one images entry");
  return images[0]!;
}

export interface ImageEvidence {
  image: string;
  digest: string;
  publish: { workflow: string; job: string; run: number; sourceCommit: string };
  pull: {
    cluster: string;
    namespace: string;
    credential: string;
    pullSecret: string;
    route: string;
    digest: string;
    verifiedAt: string;
    evidence: string;
  };
}

/** The recorded publish and pull evidence, or undefined while none is recorded. */
export function readEvidence(): ImageEvidence | undefined {
  if (!existsSync(EVIDENCE_FILE)) return undefined;
  return JSON.parse(readFileSync(EVIDENCE_FILE, "utf8")) as ImageEvidence;
}

// Keys that would mean a credential value was recorded instead of its path.
const SECRET_KEYS = /^(password|token|secret|auth|auths|dockerconfigjson|\.dockerconfigjson|username)$/i;

function secretKeys(v: unknown, path = ""): string[] {
  if (Array.isArray(v)) return v.flatMap((x, i) => secretKeys(x, `${path}[${i}]`));
  if (v === null || typeof v !== "object") return [];
  return Object.entries(v as Obj).flatMap(([k, x]) => [
    ...(SECRET_KEYS.test(k) ? [`${path}.${k}`] : []),
    ...secretKeys(x, `${path}.${k}`),
  ]);
}

/**
 * Throws unless `e` records a successful estate-image publish run, its pushed
 * digest and source commit, and a pull of that same digest on aks-obs-01 with
 * kv/loopcloser/registry-pull through the DevOps route, with no secret value.
 */
export function assertVerifiedEvidence(e: ImageEvidence): void {
  assert.deepEqual(secretKeys(e), [], "the evidence records no credential value");
  assert.match(e.image, new RegExp(`^${REPO}$`), "the evidence names the pushed loopcloser repository");
  assert.match(e.digest, SHA256, "the evidence records the pushed sha256 digest");

  assert.equal(e.publish?.workflow, "estate-image", "pushed by the estate-image workflow");
  assert.equal(e.publish.job, "publish", "pushed by its publish job");
  assert.ok(Number.isSafeInteger(e.publish.run) && e.publish.run > 0, "the publish run id");
  assert.match(e.publish.sourceCommit, COMMIT, "the publish run's source commit");

  assert.equal(e.pull?.cluster, "aks-obs-01", "the pull was verified on aks-obs-01");
  assert.equal(e.pull.namespace, "loop-closer");
  assert.equal(e.pull.credential, PULL_CREDENTIAL, `the pull used ${PULL_CREDENTIAL}`);
  assert.equal(e.pull.pullSecret, PULL_SECRET, `through the ${PULL_SECRET} Secret`);
  assert.equal(e.pull.route, "DevOps", "verified through the authorized DevOps route");
  assert.equal(e.pull.digest, e.digest, "the pulled digest is the pushed digest");
  assert.ok(!Number.isNaN(Date.parse(e.pull.verifiedAt)), "the pull's verification time");
  assert.ok(typeof e.pull.evidence === "string" && e.pull.evidence.trim() !== "", "a reference to the pull's evidence");
}
