// LC-BUG-ENTRY-BUILD-ISOLATION acceptance: no entrypoint test compiles into or
// runs from the shared `dist/`, so test files running in parallel never load a
// module another worker is rewriting.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { repoRoot } from "../schema/replica.ts";
import { SHARED_DIST, buildEntrypoints, type EntrypointBuild } from "./entrypoint-build.ts";

/** Every file under `dir`, relative to it, with its content hash and mtime. */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = join(entry.parentPath, entry.name);
    const hash = createHash("sha256").update(readFileSync(file)).digest("hex");
    out.set(relative(dir, file).split(sep).join("/"), `${hash}@${statSync(file).mtimeMs}`);
  }
  return out;
}

/** The `.js` module every `src/**.ts` source compiles to. */
function expectedModules(): string[] {
  const src = join(repoRoot, "src");
  return readdirSync(src, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".d.ts"))
    .map((e) => relative(src, join(e.parentPath, e.name)).split(sep).join("/").replace(/\.ts$/, ".js"))
    .sort();
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

test("two concurrent entrypoint builds each produce a complete module that the other build does not rewrite", { timeout: 300_000 }, async () => {
  const builds: EntrypointBuild[] = [];
  try {
    // Each build's state is captured the moment that build completes, while
    // the other may still be compiling.
    const done = await Promise.all(
      ["isolation-a", "isolation-b"].map(async (label) => {
        const build = await buildEntrypoints(label);
        builds.push(build);
        return { build, atCompletion: snapshot(build.outDir) };
      }),
    );
    const [a, b] = done as [(typeof done)[0], (typeof done)[0]];

    assert.ok(
      !isInside(a.build.outDir, b.build.outDir) && !isInside(b.build.outDir, a.build.outDir),
      "the two builds must not share or nest an output directory",
    );
    for (const { build } of done) {
      assert.ok(!isInside(build.outDir, SHARED_DIST) && !isInside(SHARED_DIST, build.outDir), `${build.outDir} must be apart from the shared dist/`);
    }

    const modules = expectedModules();
    for (const entry of ["main.js", "migrate.js", "tick.js", "portal-read.js"]) assert.ok(modules.includes(entry));
    for (const { build, atCompletion } of done) {
      const emitted = [...atCompletion.keys()].filter((f) => f.endsWith(".js")).sort();
      assert.deepEqual(emitted, modules, `${build.outDir} must hold every compiled module`);
      // Complete: each module is non-empty JavaScript, not a truncated write.
      for (const f of modules) assert.ok(statSync(build.path(f)).size > 0, `${f} must not be empty`);
    }

    // After both builds are done, neither directory changed since its own
    // build completed: the other build wrote none of its files.
    assert.deepEqual(snapshot(a.build.outDir), a.atCompletion, "the second build must not rewrite the first build's output");
    assert.deepEqual(snapshot(b.build.outDir), b.atCompletion, "the first build must not rewrite the second build's output");

    // And each emitted entrypoint module loads from its own directory.
    for (const { build } of done) {
      const mod = (await import(build.path("contracts/index.js"))) as Record<string, unknown>;
      assert.ok(Object.keys(mod).length > 0, `${build.outDir}/contracts/index.js must load`);
    }
  } finally {
    for (const build of builds) build.remove();
  }
});

/** Every test file `npm test` runs. */
function testFiles(): string[] {
  return ["tests", join("deploy", "tests")].flatMap((root) =>
    readdirSync(join(repoRoot, root), { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".test.ts"))
      .map((e) => relative(repoRoot, join(e.parentPath, e.name)).split(sep).join("/")),
  );
}

// Writes build output somewhere: the npm build script, or tsc on the build config.
const BUILD_CALL = /["']run["']\s*,\s*["']build["']|["'](?:-p|--project)["']\s*,\s*["'][^"']*tsconfig\.build\.json|["'](?:[^"']*\/)?tsc["']/;

test("the tick and portal entrypoint tests run their compiled entrypoint from an output directory no other test file writes", () => {
  const entrypointTests = ["tests/timer/tick-entrypoint.test.ts", "tests/sensors/portal-entrypoint.test.ts"];
  for (const file of entrypointTests) {
    const source = readFileSync(join(repoRoot, file), "utf8");
    assert.match(
      source,
      /import\s*\{[^}]*\bbuildEntrypoints\b[^}]*\}\s*from\s*["']\.\.\/support\/entrypoint-build\.ts["']/,
      `${file} must build through tests/support/entrypoint-build.ts`,
    );
    assert.match(source, /buildEntrypoints\(\s*["'][a-z-]+["']\s*\)/, `${file} must call buildEntrypoints`);
    assert.doesNotMatch(source, BUILD_CALL, `${file} must not run its own build`);
    // The child is spawned from the private build, never from repoRoot/dist.
    assert.doesNotMatch(source, /join\(\s*repoRoot\s*,\s*["']dist["']|join\(\s*repoRoot\s*,\s*script\s*\)|["']dist\/[^"']+\.js["']/, `${file} must not run a module from the shared dist/`);
  }

  // No other test file builds into the repository: the only build call left is
  // the clean-checkout test, which builds inside its own temporary clone.
  const builders = testFiles().filter((f) => f !== "tests/support/entrypoint-build.test.ts" && BUILD_CALL.test(readFileSync(join(repoRoot, f), "utf8")));
  assert.deepEqual(builders, ["tests/foundation/repo-builds.test.ts"]);
  const repoBuilds = readFileSync(join(repoRoot, "tests/foundation/repo-builds.test.ts"), "utf8");
  assert.match(repoBuilds, /run\("npm", \["run", "build"\], work\)/, "repo-builds must build in its temporary clone");
  assert.match(repoBuilds, /mkdtempSync\(join\(tmpdir\(\)/, "repo-builds' clone must be a temporary directory");
});
