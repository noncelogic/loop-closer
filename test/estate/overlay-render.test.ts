// LC-EST-OVERLAY-ABSENT-STATE acceptance: the aks-obs-01 overlay renders
// through one helper (test/estate/overlay-render.ts) that uses kustomize when
// it is on PATH and falls back to `kubectl kustomize`. With neither binary on
// PATH the helper throws one named could-not-run error that names both
// binaries and the overlay path, so the test fails as an environment gap
// ("Could not run" is not "failed"), never skips and never passes silently.
//
// Every case runs the real binaries; nothing here is a shim. Nothing here
// talks to a cluster.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseObjects, type Obj } from "../../tests/deploy/manifest-check.ts";
import {
  AKS_OBS_01_OVERLAY,
  OVERLAY_RENDER_COULD_NOT_RUN,
  OverlayRenderCouldNotRun,
  findOnPath,
  renderOverlay,
} from "./overlay-render.ts";

function one(objs: Obj[], kind: string, name: string): Obj {
  const found = objs.filter((o) => o["kind"] === kind && o["metadata"]?.["name"] === name);
  assert.equal(found.length, 1, `expected exactly one ${kind}/${name}`);
  return found[0]!;
}

/** What the aks-obs-01 overlay test asserts about the rendered manifests. */
function assertAksObs01Manifests(manifests: string): void {
  const objs = parseObjects(manifests);
  const api = one(objs, "Deployment", "loopcloser");
  const tick = one(objs, "CronJob", "loopcloser-tick");
  one(objs, "CronJob", "loopcloser-listings-read");
  one(objs, "Job", "loopcloser-schema");
  one(objs, "Cluster", "loopcloser-db");
  assert.equal(api["metadata"]["namespace"], "loop-closer");
  assert.equal(tick["spec"]["suspend"], false, "the overlay unsuspends the tick CronJob");
  assert.match(
    api["spec"]["template"]["spec"]["containers"][0]["image"],
    /^noncelogicci\.azurecr\.io\/loopcloser@sha256:[0-9a-f]{64}$/,
    "the overlay pins the estate-registry loopcloser image",
  );
}

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "overlay-render-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the aks-obs-01 overlay renders through the render helper", () => {
  const render = renderOverlay(AKS_OBS_01_OVERLAY);
  assert.equal(render.overlay, AKS_OBS_01_OVERLAY);
  assertAksObs01Manifests(render.manifests);
});

test("with neither kustomize nor kubectl on PATH the overlay render throws the could-not-run error naming both binaries and the overlay path", () => {
  withTempDir((empty) => {
    assert.throws(
      () => renderOverlay(AKS_OBS_01_OVERLAY, empty),
      (err: unknown) => {
        assert.ok(err instanceof OverlayRenderCouldNotRun, `expected OverlayRenderCouldNotRun, got ${String(err)}`);
        assert.equal(err.name, OVERLAY_RENDER_COULD_NOT_RUN);
        assert.deepEqual(err.missing, ["kustomize", "kubectl"]);
        assert.equal(err.overlay, AKS_OBS_01_OVERLAY);
        assert.match(err.message, /^Could not run:/);
        assert.ok(err.message.includes("kustomize"), err.message);
        assert.ok(err.message.includes("kubectl"), err.message);
        assert.ok(err.message.includes(AKS_OBS_01_OVERLAY), err.message);
        return true;
      },
    );
  });
});

test("with only kubectl on PATH the overlay render returns the aks-obs-01 manifests through kubectl kustomize", () => {
  // The real kubectl from this runner's PATH, alone in a directory that is
  // then the whole PATH. Without a kubectl here this case could not run, and
  // says so with the same named error.
  const kubectl = findOnPath("kubectl");
  if (kubectl === undefined) throw new OverlayRenderCouldNotRun(AKS_OBS_01_OVERLAY, ["kubectl"]);
  withTempDir((onlyKubectl) => {
    symlinkSync(kubectl, join(onlyKubectl, "kubectl"));
    assert.equal(findOnPath("kustomize", onlyKubectl), undefined, "kustomize is not on the restricted PATH");
    const render = renderOverlay(AKS_OBS_01_OVERLAY, onlyKubectl);
    assert.equal(render.renderer, "kubectl kustomize");
    assert.equal(render.binary, join(onlyKubectl, "kubectl"));
    assertAksObs01Manifests(render.manifests);
  });
});
