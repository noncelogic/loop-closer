// The one render helper for the aks-obs-01 overlay test
// (test/estate/overlay-render.test.ts, LC-EST-OVERLAY-ABSENT-STATE).
//
// renderOverlay(overlay, searchPath) renders a kustomize directory with
// `kustomize build` when kustomize is on PATH, else with `kubectl kustomize`.
// When neither binary is on PATH it throws OverlayRenderCouldNotRun, which
// names both binaries and the overlay path: the environment could not run
// the render, which is not a product failure. The error is thrown, so the
// test fails with it; it never skips and never passes silently.
// findOnPath(bin, searchPath) resolves an executable on a PATH string.
import { execFileSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { repoRoot } from "../../tests/deploy/manifest-check.ts";

export const AKS_OBS_01_OVERLAY = join(repoRoot, "deploy", "overlays", "aks-obs-01");
export const OVERLAY_RENDER_COULD_NOT_RUN = "OverlayRenderCouldNotRun";
export const RENDER_BINARIES = ["kustomize", "kubectl"] as const;

export type Renderer = "kustomize build" | "kubectl kustomize";
export type OverlayRender = { overlay: string; renderer: Renderer; binary: string; manifests: string };

/** The overlay render could not run here: no renderer binary on PATH. */
export class OverlayRenderCouldNotRun extends Error {
  override readonly name = OVERLAY_RENDER_COULD_NOT_RUN;
  readonly overlay: string;
  readonly missing: string[];

  constructor(overlay: string, missing: readonly string[] = RENDER_BINARIES) {
    super(
      `Could not run: rendering ${overlay} needs ${missing.join(" or ")} on PATH and none was found. ` +
        "This is an environment gap, not a product failure.",
    );
    this.overlay = overlay;
    this.missing = [...missing];
  }
}

/** The absolute path of the first executable `bin` on `searchPath`, or undefined. */
export function findOnPath(bin: string, searchPath: string = process.env["PATH"] ?? ""): string | undefined {
  for (const dir of searchPath.split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, bin);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * Renders `overlay` with kustomize if it is on `searchPath`, else with
 * `kubectl kustomize`; throws OverlayRenderCouldNotRun when neither is.
 * A renderer that runs and fails (a broken overlay) throws its own error.
 */
export function renderOverlay(
  overlay: string = AKS_OBS_01_OVERLAY,
  searchPath: string = process.env["PATH"] ?? "",
): OverlayRender {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: searchPath };
  const kustomize = findOnPath("kustomize", searchPath);
  if (kustomize !== undefined) {
    const manifests = execFileSync(kustomize, ["build", overlay], { encoding: "utf8", env });
    return { overlay, renderer: "kustomize build", binary: kustomize, manifests };
  }
  const kubectl = findOnPath("kubectl", searchPath);
  if (kubectl !== undefined) {
    const manifests = execFileSync(kubectl, ["kustomize", overlay], { encoding: "utf8", env });
    return { overlay, renderer: "kubectl kustomize", binary: kubectl, manifests };
  }
  throw new OverlayRenderCouldNotRun(overlay);
}
