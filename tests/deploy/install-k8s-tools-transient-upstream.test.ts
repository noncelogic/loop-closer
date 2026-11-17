// Regression lock for the red `ci` run on main 43992607415 (fixed by PR #44).
//
// Culprit: the run first failed at 4e7b64829ed6 (#42, "mh build for
// COND-148-build"), the only commit in 1cde46396786..4e7b64829ed6, but nothing
// that commit changed (src/kernel, src/sensors and their tests) is involved. The
// defect was already present since a16b5b3 (#18), which added
// .github/scripts/install-k8s-tools.sh. 4e7b648 was just the first push whose
// `manifests` job hit it.
// Root cause: every download in install-k8s-tools.sh was a bare `curl -fsSL`
// with no retry, so one transient HTTP 502 from the GitHub release CDN
// ("curl: (22) The requested URL returned error: 502") failed the job.
// Why pull request checks missed it: the script ran only as a CI setup step
// against the live upstreams and was never under test. The failure depends on
// upstream luck, not on the diff, so the PR run of the same change (4491980)
// got 200s and passed. No PR check put the script in front of a failing
// upstream.
//
// This test runs the whole installer (not only the `fetch` helper that
// tests/deploy/install-k8s-tools.test.ts covers) as CI does,
// `bash install-k8s-tools.sh`. A `curl` shim on PATH sends every https URL to
// a local server that answers 502 to the first request for each asset and
// then serves fake but checksum-consistent kubectl/kustomize/kubeconform
// artifacts. At 4e7b648 it fails with curl exit 22, as the red run did. On main
// it passes. It runs in `npm test`, which the `test` job runs on every pull
// request. Nothing here leaves localhost.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const SCRIPT = join(repoRoot, ".github", "scripts", "install-k8s-tools.sh");
const REAL_CURL = execFileSync("bash", ["-c", "command -v curl"], { encoding: "utf8" }).trim();

const KUBECTL_VERSION = "v9.9.9";
const KUSTOMIZE_VERSION = "v9.9.8";
const KUBECONFORM_VERSION = "v9.9.7";

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const fakeTool = (name: string) => Buffer.from(`#!/bin/sh\necho "fake ${name} $*"\n`);

function tarGz(dir: string, member: string, content: Buffer): Buffer {
  const src = mkdtempSync(join(dir, "tar-"));
  writeFileSync(join(src, member), content, { mode: 0o755 });
  return execFileSync("tar", ["-czf", "-", "-C", src, member]);
}

// Upstream paths (host + path, as the shim rewrites them) -> bytes.
function upstreamAssets(dir: string): Map<string, Buffer> {
  const kubectl = fakeTool("kubectl");
  const kustomizeTgz = tarGz(dir, "kustomize", fakeTool("kustomize"));
  const kubeconformTgz = tarGz(dir, "kubeconform", fakeTool("kubeconform"));
  const kz = `kustomize_${KUSTOMIZE_VERSION}_linux_amd64.tar.gz`;
  const kzBase = `/github.com/kubernetes-sigs/kustomize/releases/download/kustomize%2F${KUSTOMIZE_VERSION}`;
  const kcBase = `/github.com/yannh/kubeconform/releases/download/${KUBECONFORM_VERSION}`;
  const kubectlBase = `/dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64`;
  return new Map([
    [`${kubectlBase}/kubectl`, kubectl],
    [`${kubectlBase}/kubectl.sha256`, Buffer.from(sha256(kubectl))],
    [`${kzBase}/${kz}`, kustomizeTgz],
    [`${kzBase}/checksums.txt`, Buffer.from(`${sha256(kustomizeTgz)}  ${kz}\n`)],
    [`${kcBase}/kubeconform-linux-amd64.tar.gz`, kubeconformTgz],
    [`${kcBase}/CHECKSUMS`, Buffer.from(`${sha256(kubeconformTgz)}  kubeconform-linux-amd64.tar.gz\n`)],
  ]);
}

// Answers 502 to the first request for each asset, then serves it.
async function flakyUpstream(assets: Map<string, Buffer>): Promise<{ server: Server; port: number; hits: Map<string, number> }> {
  const hits = new Map<string, number>();
  const server = createServer((req, res) => {
    const path = req.url ?? "";
    const n = (hits.get(path) ?? 0) + 1;
    hits.set(path, n);
    const body = assets.get(path);
    if (!body) return void res.writeHead(404).end("not found");
    if (n === 1) return void res.writeHead(502).end("bad gateway");
    res.writeHead(200, { "content-type": "application/octet-stream" }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as AddressInfo).port, hits };
}

test("install-k8s-tools.sh installs all tools when each upstream asset first answers 502 (ci run 43992607415)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "k8s-tools-transient-"));
  const assets = upstreamAssets(dir);
  const { server, port, hits } = await flakyUpstream(assets);
  try {
    // curl shim: rewrite https://<host>/<path> to the local flaky upstream and
    // exec the real curl with every other argument unchanged.
    const shimDir = join(dir, "shim");
    mkdirSync(shimDir);
    const shim = join(shimDir, "curl");
    writeFileSync(
      shim,
      `#!/usr/bin/env bash\nargs=()\nfor a in "$@"; do\n  case "$a" in https://*) a="http://127.0.0.1:${port}/\${a#https://}";; esac\n  args+=("$a")\ndone\nexec "${REAL_CURL}" "\${args[@]}"\n`,
    );
    chmodSync(shim, 0o755);
    const runnerTemp = join(dir, "runner-temp");
    mkdirSync(runnerTemp);
    const githubEnv = join(dir, "github-env");
    writeFileSync(githubEnv, "");

    const { code, stderr } = await new Promise<{ code: number; stderr: string }>((resolve) => {
      execFile(
        "bash",
        [SCRIPT],
        {
          encoding: "utf8",
          timeout: 60_000,
          env: {
            ...process.env,
            PATH: `${shimDir}:${process.env.PATH}`,
            RUNNER_TEMP: runnerTemp,
            GITHUB_ENV: githubEnv,
            KUBECTL_VERSION,
            KUSTOMIZE_VERSION,
            KUBECONFORM_VERSION,
            INSTALL_K8S_TOOLS_RETRY_DELAY: "1",
          },
        },
        (err, _stdout, stderr) => resolve({ code: err ? ((err as any).code ?? 1) : 0, stderr }),
      );
    });

    assert.equal(code, 0, `installer must survive one transient 502 per asset (stderr: ${stderr})`);
    for (const path of assets.keys()) {
      assert.equal(hits.get(path), 2, `${path}: one 502, then one successful retry`);
    }
    const bin = join(runnerTemp, "k8s-tools");
    assert.deepEqual(
      readFileSync(githubEnv, "utf8").trim().split("\n"),
      [`KUBECTL=${bin}/kubectl`, `KUSTOMIZE=${bin}/kustomize`, `KUBECONFORM=${bin}/kubeconform`],
    );
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
