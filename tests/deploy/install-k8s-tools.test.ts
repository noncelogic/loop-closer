// COND-159 acceptance: .github/scripts/install-k8s-tools.sh survives a
// transient upstream error. ci run 43992607415 (manifests job) failed because
// one download of the kubeconform release asset got an HTTP 502 from GitHub
// and the script's curl gave up on the first try. Every download in the script
// goes through its `fetch` helper, and that helper retries transient HTTP
// errors (5xx) while still failing on a persistent one.
//
// Runs the real helper with the real curl against a local HTTP server; nothing
// here leaves localhost.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const SCRIPT = join(repoRoot, ".github", "scripts", "install-k8s-tools.sh");

// Serves `failures` 502 responses, then 200 with BODY.
const BODY = "pinned-tool-bytes\n";
async function flakyServer(failures: number): Promise<{ server: Server; url: string; hits: () => number }> {
  let n = 0;
  const server = createHttpServer((_req, res) => {
    n += 1;
    if (n <= failures) {
      res.writeHead(502).end("bad gateway");
    } else {
      res.writeHead(200, { "content-type": "application/octet-stream" }).end(BODY);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}/asset`, hits: () => n };
}

// Sources the script (which must not run its installer when sourced) and calls
// `fetch <url>`, returning exit code and stdout.
function runFetch(url: string): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(
      "bash",
      ["-c", 'source "$1" && fetch "$2"', "bash", SCRIPT, url],
      { encoding: "utf8", env: { ...process.env, INSTALL_K8S_TOOLS_RETRY_DELAY: "0" } },
      (err, stdout) => resolve({ code: err ? ((err as any).code ?? 1) : 0, stdout }),
    );
  });
}

test("every download in install-k8s-tools.sh goes through the retrying fetch helper", () => {
  const text = readFileSync(SCRIPT, "utf8");
  const curls = text.split("\n").filter((l) => /\bcurl\b/.test(l) && !l.trimStart().startsWith("#"));
  assert.equal(curls.length, 1, `exactly one curl invocation, inside fetch (got ${JSON.stringify(curls)})`);
  assert.match(curls[0]!, /--retry\s+\d+/, "fetch's curl retries");
});

test("fetch retries a transient 502 and returns the asset", async () => {
  const { server, url, hits } = await flakyServer(2);
  try {
    const { code, stdout } = await runFetch(url);
    assert.equal(code, 0, "fetch succeeds after transient 502s");
    assert.equal(stdout, BODY);
    assert.equal(hits(), 3);
  } finally {
    server.close();
  }
});

test("fetch still fails on a persistent 502", async () => {
  const { server, url } = await flakyServer(Number.POSITIVE_INFINITY);
  try {
    const { code, stdout } = await runFetch(url);
    assert.notEqual(code, 0, "a persistent upstream error fails the install");
    assert.equal(stdout, "");
  } finally {
    server.close();
  }
});

// COND-324 acceptance: ci run 44885565349 (test job) installed the pinned
// kubectl and kustomize but only exported KUBECTL/KUSTOMIZE through
// $GITHUB_ENV, so test/estate/overlay-render.test.ts, which looks the
// renderers up on PATH, found neither. The installer's export step also puts
// the install directory on PATH for later steps through $GITHUB_PATH.
test("the installer's export step puts the pinned tools directory on PATH through $GITHUB_PATH", () => {
  const dir = mkdtempSync(join(tmpdir(), "install-k8s-tools-"));
  try {
    const githubEnv = join(dir, "github_env");
    const githubPath = join(dir, "github_path");
    writeFileSync(githubEnv, "");
    writeFileSync(githubPath, "");
    const bin = join(dir, "k8s-tools");
    execFileSync("bash", ["-c", 'source "$1" && export_k8s_tools "$2"', "bash", SCRIPT, bin], {
      env: { ...process.env, GITHUB_ENV: githubEnv, GITHUB_PATH: githubPath },
    });
    assert.deepEqual(readFileSync(githubPath, "utf8").split("\n").filter(Boolean), [bin]);
    assert.deepEqual(readFileSync(githubEnv, "utf8").split("\n").filter(Boolean), [
      `KUBECTL=${bin}/kubectl`,
      `KUSTOMIZE=${bin}/kustomize`,
      `KUBECONFORM=${bin}/kubeconform`,
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the installer runs its export step", () => {
  const text = readFileSync(SCRIPT, "utf8");
  const body = text.slice(text.indexOf("install_k8s_tools() {"));
  assert.match(body, /^\s*export_k8s_tools "\$bin"\s*$/m, "install_k8s_tools calls export_k8s_tools with its install dir");
});
