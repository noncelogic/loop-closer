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
// repository_settings), not a file this repository can change. What this file
// adds: the break surfaced only as a 3-minute `npm test` job failing on a
// runner without the tools; this file fails in seconds, anywhere, on the
// contract itself.
//
// The first test runs the ci job's real setup path in an isolated harness:
// every `run:` step of each job that runs the overlay-render test executes in
// order with bash, as the runner would, up to and including the test step;
// $GITHUB_ENV and $GITHUB_PATH are applied between steps the way the runner
// applies them (each $GITHUB_PATH line prepended to PATH for later steps).
// The real .github/scripts/install-k8s-tools.sh runs end to end, including its
// checksum checks, against a `curl` stub that serves stub release assets. The
// test step's `npm` is a stub that starts a fresh node process, which calls
// the real renderOverlay/findOnPath from test/estate/overlay-render.ts with
// its inherited PATH and reports which binary rendered. The base PATH is the
// host's with kubectl, kustomize, kubeconform, curl and npm removed, like the
// runner image. A step that only mentions the installer, or an installer step
// under an `if:` that is not always true, installs nothing and fails here.
// On 04f2548 the installer has no $GITHUB_PATH export, so the test process
// finds no renderer and this fails.
//
// Nothing here downloads, reaches GitHub, a runner or a cluster: `uses:`
// steps (checkout, setup-node) are not executed, the repository is already
// checked out and node is the host's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";
import { RENDER_BINARIES, findOnPath } from "../../test/estate/overlay-render.ts";

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const INSTALLER = join(repoRoot, ".github", "scripts", "install-k8s-tools.sh");
type Obj = Record<string, any>;

function ciJobs(): Obj {
  const wf = parse(readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8")) as Obj;
  return wf["jobs"] as Obj;
}

/** True when a `run:` line runs the overlay-render test: `npm test` (not another script such as test:unit) or the file by name. */
function runsOverlayRender(run: string): boolean {
  return /\bnpm (run )?test(?![\w:-])/.test(run) || run.includes("test/estate/overlay-render.test.ts");
}

// Step conditions the harness treats as true; any other `if:` may not run on
// a pull request, so its step is not executed (and installs nothing).
const ALWAYS_TRUE_IFS = new Set(["always()", "success()", "!cancelled()", "true", "${{ always() }}", "${{ success() }}", "${{ !cancelled() }}", "${{ true }}"]);
const NOT_ON_RUNNER_IMAGE = new Set(["kubectl", "kustomize", "kubeconform", "curl", "npm", "npx"]);

function executable(file: string, body: string): void {
  writeFileSync(file, body);
  chmodSync(file, 0o755);
}

function sha256(file: string): string {
  return execFileSync("sha256sum", [file], { encoding: "utf8" }).split(" ")[0]!;
}

/** A directory of symlinks to every executable on the host PATH except the ones the runner image lacks. */
function runnerImagePath(dir: string): string {
  mkdirSync(dir);
  const seen = new Set<string>();
  for (const pathDir of (process.env["PATH"] ?? "").split(delimiter)) {
    if (pathDir === "") continue;
    let names: string[];
    try {
      names = readdirSync(pathDir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (seen.has(name) || NOT_ON_RUNNER_IMAGE.has(name)) continue;
      if (findOnPath(name, pathDir) === undefined) continue;
      seen.add(name);
      symlinkSync(join(pathDir, name), join(dir, name));
    }
  }
  return dir;
}

/** Stub release assets, named like the URLs the installer fetches for the job's pinned versions. */
function releaseAssets(dir: string, env: Obj): void {
  mkdirSync(dir);
  const tool = (_name: string) =>
    `#!/bin/sh\nif [ "$1" = build ] || [ "$1" = kustomize ]; then echo "rendered-by: $0"; fi\nexit 0\n`;
  const work = join(dir, ".work");
  mkdirSync(work);
  executable(join(dir, "kubectl"), tool("kubectl"));
  writeFileSync(join(dir, "kubectl.sha256"), sha256(join(dir, "kubectl")));
  const kustomizeTar = `kustomize_${env["KUSTOMIZE_VERSION"]}_linux_amd64.tar.gz`;
  executable(join(work, "kustomize"), tool("kustomize"));
  execFileSync("tar", ["-czf", join(dir, kustomizeTar), "-C", work, "kustomize"]);
  writeFileSync(join(dir, "checksums.txt"), `${sha256(join(dir, kustomizeTar))}  ${kustomizeTar}\n`);
  const kubeconformTar = "kubeconform-linux-amd64.tar.gz";
  executable(join(work, "kubeconform"), tool("kubeconform"));
  execFileSync("tar", ["-czf", join(dir, kubeconformTar), "-C", work, "kubeconform"]);
  writeFileSync(join(dir, "CHECKSUMS"), `${sha256(join(dir, kubeconformTar))}  ${kubeconformTar}\n`);
}

type TestProcess = { path: string; renderer: string; binary: string; manifests: string };

/**
 * Runs `job`'s steps the way the runner does, up to and including the first
 * step that runs the overlay-render test, and returns what the test process
 * saw, or undefined if that step never ran.
 */
function runJobSetupPath(job: Obj, dir: string): TestProcess | undefined {
  const jobEnv = (job["env"] ?? {}) as Obj;
  const runnerTemp = join(dir, "runner-temp");
  mkdirSync(runnerTemp);
  const assets = join(dir, "assets");
  releaseAssets(assets, jobEnv);
  const stubs = join(dir, "stubs");
  mkdirSync(stubs);
  // curl: serve the asset named by the URL's last path segment, to -o or stdout.
  executable(
    join(stubs, "curl"),
    `#!/usr/bin/env bash\nout=; url=\nwhile [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; http*) url="$1"; shift;; *) shift;; esac; done\n` +
      `src="${assets}/\${url##*/}"\n[ -f "$src" ] || { echo "curl stub: no asset for $url" >&2; exit 22; }\n` +
      `if [ -n "$out" ]; then cp "$src" "$out"; else cat "$src"; fi\n`,
  );
  // npm: setup commands succeed; `npm test` starts the test process.
  const probe = join(dir, "test-process.mjs");
  const probeOut = join(dir, "test-process.json");
  const helper = pathToFileURL(join(repoRoot, "test", "estate", "overlay-render.ts")).href;
  writeFileSync(
    probe,
    `import { writeFileSync } from "node:fs";\nimport { renderOverlay } from ${JSON.stringify(helper)};\n` +
      `const r = renderOverlay();\n` +
      `writeFileSync(${JSON.stringify(probeOut)}, JSON.stringify({ path: process.env.PATH, renderer: r.renderer, binary: r.binary, manifests: r.manifests }));\n`,
  );
  executable(
    join(stubs, "npm"),
    `#!/usr/bin/env bash\nif [ "$1" = test ] || { [ "$1" = run ] && [ "$2" = test ]; }; then exec "${process.execPath}" "${probe}"; fi\nexit 0\n`,
  );
  const basePath = [stubs, runnerImagePath(join(dir, "runner-image-bin"))];
  const githubEnv = join(dir, "github_env");
  const githubPath = join(dir, "github_path");
  writeFileSync(githubEnv, "");
  writeFileSync(githubPath, "");
  const bash = findOnPath("bash");
  assert.ok(bash, "bash is on the host PATH");

  for (const [i, step] of ((job["steps"] ?? []) as Obj[]).entries()) {
    if (step["run"] === undefined) continue; // `uses:` steps: checkout and setup-node are already in place.
    if (step["if"] !== undefined && !ALWAYS_TRUE_IFS.has(String(step["if"]).trim())) continue;
    const exported = Object.fromEntries(
      readFileSync(githubEnv, "utf8")
        .split("\n")
        .filter((l) => l.includes("="))
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
    const added = readFileSync(githubPath, "utf8").split("\n").filter(Boolean).reverse();
    const script = join(dir, `step-${i}.sh`);
    writeFileSync(script, String(step["run"]));
    const label = String(step["name"] ?? step["run"]).split("\n")[0];
    try {
      execFileSync(bash, ["--noprofile", "--norc", "-eo", "pipefail", script], {
        cwd: join(repoRoot, String(step["working-directory"] ?? ".")),
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          HOME: dir,
          ...jobEnv,
          ...((step["env"] ?? {}) as Obj),
          ...exported,
          PATH: [...added, ...basePath].join(delimiter),
          RUNNER_TEMP: runnerTemp,
          GITHUB_ENV: githubEnv,
          GITHUB_PATH: githubPath,
          INSTALL_K8S_TOOLS_RETRY_DELAY: "0",
        },
      });
    } catch (err) {
      const stderr = String((err as { stderr?: unknown }).stderr ?? "").trim();
      assert.fail(`ci step "${label}" failed in the harness:\n${stderr}`);
    }
    if (runsOverlayRender(String(step["run"]))) {
      return existsSync(probeOut) ? (JSON.parse(readFileSync(probeOut, "utf8")) as TestProcess) : undefined;
    }
  }
  return undefined;
}

test("every ci job that runs the overlay-render test, run step by step, leaves the pinned renderer on the test process's PATH", () => {
  const jobs = Object.entries(ciJobs()).filter(([, job]) =>
    ((job as Obj)["steps"] as Obj[] | undefined)?.some((s) => runsOverlayRender(String(s["run"] ?? ""))),
  );
  assert.ok(jobs.length > 0, "some ci job runs npm test");
  for (const [name, job] of jobs) {
    const dir = mkdtempSync(join(tmpdir(), `renderers-on-path-${name}-`));
    try {
      const seen = runJobSetupPath(job as Obj, dir);
      assert.ok(seen, `ci job ${name}: the overlay-render test step ran its test process`);
      const pinned = join(dir, "runner-temp", "k8s-tools", "kustomize");
      assert.equal(seen.binary, pinned, `ci job ${name}: the test process renders with the installed, pinned kustomize`);
      assert.equal(seen.renderer, "kustomize build");
      assert.match(seen.manifests, /rendered-by: /);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
