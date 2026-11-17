// A private compiled output for each entrypoint test.
//
// `npm test` runs test files in parallel. A test that compiles into the shared
// `dist/` and runs its child from there can load a module another worker is
// rewriting at that moment. Each caller here gets its own directory, written by
// its own build and by no other, and removes it at teardown.
//
// The directory sits beside `dist/` at the repo root (and matches the
// `dist-*/` ignore pattern) so the build keeps its layout:
// src/contracts/index.ts resolves `contracts/` two levels up from the emitted
// module, and package.json/node_modules resolve the same way as from `dist/`.
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { repoRoot } from "../schema/replica.ts";

const execFileAsync = promisify(execFile);

/** The directory `tsconfig.build.json` emits to and the deploy manifests run from. */
export const SHARED_DIST = join(repoRoot, "dist");

export interface EntrypointBuild {
  /** The private output directory; it plays the role `dist/` plays in the image. */
  readonly outDir: string;
  /** Absolute path of an emitted module, given its path relative to the output root (e.g. `tick.js`). */
  path(relative: string): string;
  /** Removes the output directory. */
  remove(): void;
}

/**
 * Runs the production build (`npm run build`) into a fresh directory that no
 * other caller shares, and resolves once that build has completed.
 */
export async function buildEntrypoints(label: string): Promise<EntrypointBuild> {
  const outDir = mkdtempSync(join(repoRoot, `dist-${label}-`));
  try {
    await execFileAsync("npm", ["run", "build", "--", "--outDir", outDir], { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 });
  } catch (err) {
    rmSync(outDir, { recursive: true, force: true });
    const e = err as { stdout?: string; stderr?: string; message: string };
    throw new Error(`entrypoint build into ${outDir} failed: ${e.message}\n${e.stdout ?? ""}${e.stderr ?? ""}`);
  }
  return {
    outDir,
    path: (relative) => join(outDir, relative),
    remove: () => rmSync(outDir, { recursive: true, force: true }),
  };
}

/**
 * Maps a deploy manifest's `dist/<file>` script onto a private build, so a test
 * runs the same emitted file the image would, without touching `dist/`.
 */
export function manifestScriptIn(build: EntrypointBuild, script: string): string {
  const match = /^dist\/(.+)$/.exec(script);
  if (!match) throw new Error(`manifest script ${script} is not build output under dist/`);
  return build.path(match[1]!);
}
