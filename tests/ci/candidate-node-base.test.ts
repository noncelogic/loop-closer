// LC-DEPLOY-CANDIDATE-DB-ROLE: tests/deploy/deploy-candidate.test.ts builds its
// candidate image on the node base pinned by digest in ci.yml's `test` job
// (CANDIDATE_NODE_BASE), and never pulls it itself. So the job provisions that
// base in its Docker daemon before the suite runs. This runs the job's steps
// before `npm test` the way the runner does, with a docker that records what it
// is asked to do, and checks the pinned base is pulled there and nothing else
// reaches docker. Nothing here reaches a registry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { parse } from "yaml";

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
type Obj = Record<string, any>;

/** A docker that logs each call; it pulls a digest-pinned reference and fails any other call. */
const RECORDING_DOCKER = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$DOCKER_LOG"
if [ "$1" = pull ] && [ $# -eq 2 ] && [[ "$2" =~ @sha256:[0-9a-f]{64}$ ]]; then echo "pulled $2"; exit 0; fi
echo "unexpected docker call: $*" >&2
exit 99
`;

test("ci's test job pulls the digest-pinned candidate node base into its Docker daemon before the suite runs", () => {
  const job = (parse(readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8")) as Obj)["jobs"]["test"] as Obj;
  const base = String(job["env"]?.["CANDIDATE_NODE_BASE"] ?? "");
  assert.match(base, /^node:24-bookworm-slim@sha256:[0-9a-f]{64}$/, "the test job pins the candidate node base by digest");

  const steps = job["steps"] as Obj[];
  const suite = steps.findIndex((s) => /^npm (run )?test$/.test(String(s["run"] ?? "").trim()));
  assert.ok(suite >= 0, "the test job runs npm test");

  const dir = mkdtempSync(join(tmpdir(), "lc-candidate-base-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "docker"), RECORDING_DOCKER, { mode: 0o755 });
    const log = join(dir, "docker.log");
    writeFileSync(log, "");
    // Every step before the suite that touches docker or the registry: the runs that are not package or tool setup.
    const setup = /^(npm (ci|run (typecheck|build))\b|bash \.github\/scripts\/install-k8s-tools\.sh$)/;
    for (const step of steps.slice(0, suite)) {
      const run = step["run"];
      if (typeof run !== "string" || setup.test(run.trim())) continue;
      execFileSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", run], {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...(job["env"] as Obj), ...((step["env"] ?? {}) as Obj), DOCKER_LOG: log, PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter) },
        timeout: 60_000,
      });
    }
    assert.deepEqual(readFileSync(log, "utf8").split("\n").filter(Boolean), [`pull ${base}`], "the job does not provision the pinned base before npm test");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
