// COND-330 lock-in for the ci break fixed by PR #82 (red run 44885565349,
// green again at run 44892168374).
//
// Culprit: 04f2548 (PR #81, COND-319) added test/estate/overlay-render.test.ts,
// whose render helper looks kustomize and kubectl up on PATH. ci's `test` job
// installs the pinned tools with .github/scripts/install-k8s-tools.sh, which
// then only exported KUBECTL/KUSTOMIZE/KUBECONFORM through $GITHUB_ENV and
// never put the install directory on PATH, and the self-hosted runner image
// ships neither binary: `npm test` failed with OverlayRenderCouldNotRun.
// The author's machine had kubectl on PATH, so it passed locally.
//
// Why pull request checks missed it: they did not miss it. PR #81's own ci
// run (44883993338) failed `test` and `gate`; the PR merged anyway because
// main's branch protection had no required status check
// (required_status_checks.contexts == [], enforcement off), so the red `gate`
// did not block the merge. Requiring `gate` is a repository setting applied by
// the DevOps route (Rule: policies/placement-defaults.yaml#credentials,
// repository_settings), not a file this repository can change. What this test
// adds: the break surfaced only as a 3-minute `npm test` job failing on a
// runner without the tools; this file fails in milliseconds, anywhere, on the
// contract itself: every ci job that runs a test which looks the renderers up
// on PATH installs them first, and the installer's export step leaves them
// resolvable on PATH by the same lookup the helper uses. On 04f2548 the
// installer has no PATH export, so the last case fails.
//
// Nothing here downloads, reaches GitHub, a runner or a cluster: the tools are
// stub executables in a temp directory, and $GITHUB_PATH is applied the way
// the runner applies it (each line prepended to PATH for later steps).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { parse } from "yaml";
import { RENDER_BINARIES, findOnPath } from "../../test/estate/overlay-render.ts";

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const INSTALLER = join(repoRoot, ".github", "scripts", "install-k8s-tools.sh");
type Obj = Record<string, any>;

function ciJobs(): Obj {
  const wf = parse(readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8")) as Obj;
  return wf["jobs"] as Obj;
}

/** True when a `run:` line runs the overlay-render test: `npm test` or the file by name. */
function runsOverlayRender(run: string): boolean {
  return /\bnpm (run )?test\b/.test(run) || run.includes("test/estate/overlay-render.test.ts");
}

test("every ci job that runs the overlay-render test installs the pinned k8s tools before it", () => {
  const jobs = ciJobs();
  const runners = Object.entries(jobs).filter(([, job]) =>
    ((job as Obj)["steps"] as Obj[] | undefined)?.some((s) => runsOverlayRender(String(s["run"] ?? ""))),
  );
  assert.ok(runners.length > 0, "some ci job runs npm test");
  for (const [name, job] of runners) {
    const runs = ((job as Obj)["steps"] as Obj[]).map((s) => String(s["run"] ?? ""));
    const install = runs.findIndex((r) => r.includes(".github/scripts/install-k8s-tools.sh"));
    const tests = runs.findIndex(runsOverlayRender);
    assert.ok(install >= 0 && install < tests, `ci job ${name} installs the k8s tools before running the tests`);
  }
});

test("after the installer's export step, later steps resolve kustomize and kubectl on PATH to the pinned binaries", () => {
  const dir = mkdtempSync(join(tmpdir(), "renderers-on-path-"));
  try {
    const bin = join(dir, "k8s-tools");
    mkdirSync(bin);
    for (const tool of [...RENDER_BINARIES, "kubeconform"]) {
      const file = join(bin, tool);
      writeFileSync(file, "#!/bin/sh\nexit 0\n");
      chmodSync(file, 0o755);
    }
    const githubEnv = join(dir, "github_env");
    const githubPath = join(dir, "github_path");
    writeFileSync(githubEnv, "");
    writeFileSync(githubPath, "");
    // The runner image ships neither renderer: start from a PATH without them.
    const runnerPath = join(dir, "runner-bin");
    mkdirSync(runnerPath);
    for (const tool of RENDER_BINARIES) assert.equal(findOnPath(tool, runnerPath), undefined);

    // The installer's own export step, as install_k8s_tools runs it.
    execFileSync("bash", ["-c", 'source "$1" && export_k8s_tools "$2"', "bash", INSTALLER, bin], {
      env: { ...process.env, GITHUB_ENV: githubEnv, GITHUB_PATH: githubPath },
    });

    // The runner prepends each $GITHUB_PATH line to PATH for later steps.
    const added = readFileSync(githubPath, "utf8").split("\n").filter(Boolean).reverse();
    const nextStepPath = [...added, runnerPath].join(delimiter);
    for (const tool of RENDER_BINARIES) {
      assert.equal(findOnPath(tool, nextStepPath), join(bin, tool), `${tool} resolves on PATH in the npm test step`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
