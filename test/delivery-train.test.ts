// LC-TRAIN-SERVING acceptance (CLOSER-345, DELIVERY-GUARANTEE-CHECK; Rule:
// policies/placement-defaults.yaml#estate, Argo CD from Git): delivery-train.yaml
// declares serving.argocd, the Argo CD Application that serves loop-closer, so
// the check can measure which revision serves it. The Application is
// loop-closer in namespace argocd on aks-obs-01, tracking main at
// deploy/overlays/aks-obs-01, and that path is an overlay that exists here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
type Obj = Record<string, any>;

/** Why a delivery-train declaration does not name an Argo CD serving application with an existing overlay, or null when it does. */
export function servingGap(d: Obj, root: string): string | null {
  const argocd = d?.["serving"]?.["argocd"] as Obj | undefined;
  if (!argocd || typeof argocd !== "object") return "no serving.argocd";
  for (const k of ["application", "namespace", "cluster", "repo", "revision", "path"]) {
    if (typeof argocd[k] !== "string" || argocd[k].trim() === "") return `serving.argocd.${k} is not a non-empty string`;
  }
  const path = argocd["path"] as string;
  if (path.startsWith("/") || path.split("/").includes("..")) return `serving.argocd.path ${path} is not inside the repository`;
  const dir = join(root, path);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return `serving.argocd.path ${path} is not a directory`;
  if (!existsSync(join(dir, "kustomization.yaml"))) return `serving.argocd.path ${path} has no kustomization.yaml`;
  return null;
}

test("delivery-train.yaml declares serving.argocd naming application loop-closer in namespace argocd, and its path equals the overlay directory deploy/overlays/aks-obs-01 that exists in the repository", () => {
  const train = parse(readFileSync(join(repoRoot, "delivery-train.yaml"), "utf8")) as Obj;
  assert.equal(servingGap(train, repoRoot), null);
  const argocd = train["serving"]["argocd"] as Obj;
  assert.equal(argocd["application"], "loop-closer");
  assert.equal(argocd["namespace"], "argocd");
  assert.equal(argocd["cluster"], "aks-obs-01");
  assert.equal(argocd["repo"], "noncelogic/loop-closer");
  assert.equal(argocd["revision"], "main");
  assert.equal(argocd["path"], "deploy/overlays/aks-obs-01");
  // The overlay Argo CD syncs is tracked in Git on the revision it follows.
  const tracked = execFileSync("git", ["ls-files", "--", `${argocd["path"]}/kustomization.yaml`], { cwd: repoRoot, encoding: "utf8" }).trim();
  assert.equal(tracked, `${argocd["path"]}/kustomization.yaml`);
});

test("a declaration without serving.argocd, or with a path that is not an overlay in the repository, is a gap", () => {
  const good = { application: "loop-closer", namespace: "argocd", cluster: "aks-obs-01", repo: "noncelogic/loop-closer", revision: "main", path: "deploy/overlays/aks-obs-01" };
  assert.equal(servingGap({ serving: { argocd: good } }, repoRoot), null);
  assert.equal(servingGap({}, repoRoot), "no serving.argocd");
  assert.equal(servingGap({ serving: { release: {} } }, repoRoot), "no serving.argocd");
  assert.match(servingGap({ serving: { argocd: { ...good, application: "" } } }, repoRoot) ?? "", /application/);
  assert.match(servingGap({ serving: { argocd: { ...good, path: "deploy/overlays/missing" } } }, repoRoot) ?? "", /not a directory/);
  assert.match(servingGap({ serving: { argocd: { ...good, path: "deploy" } } }, repoRoot) ?? "", /no kustomization/);
  assert.match(servingGap({ serving: { argocd: { ...good, path: "../elsewhere" } } }, repoRoot) ?? "", /not inside/);
});
