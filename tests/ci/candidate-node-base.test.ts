// LC-DEPLOY-CANDIDATE-DB-ROLE: tests/deploy/deploy-candidate.test.ts builds its
// candidate image on the node base pinned by digest in ci.yml's `test` job
// (CANDIDATE_NODE_BASE), and never pulls it itself. So the job provisions that
// base in its Docker daemon before the suite runs. This runs the job's steps
// before `npm test` the way the runner does, with a docker that records what it
// is asked to do, and checks the pinned base is pulled there and nothing else
// reaches docker. It also checks the suite makes its image from that base's
// local image ID (tests/support/candidate-image.ts), never by a build or a pull
// that could resolve the base through the registry. Nothing here reaches a
// registry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { parse } from "yaml";
import type { Docker } from "../../.github/scripts/deploy-candidate.mjs";
import { commitImage, localImageId } from "../support/candidate-image.ts";

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

const BASE = "node:24-bookworm-slim@sha256:" + "a".repeat(64);
const BASE_ID = "sha256:" + "b".repeat(64);
const IMAGE_ID = "sha256:" + "c".repeat(64);

/**
 * A daemon that holds BASE as BASE_ID and answers only the commands that make an image from a local image ID; a
 * build, a pull, or a create from anything but that ID fails. Each call is logged with `#nocheck` when it tolerates
 * failure and `#signal` when it can be cancelled. `onCall` runs as each command arrives.
 */
function localDaemon(calls: string[][], onCall: (args: string[]) => void = () => {}): Docker {
  const tags = new Map<string, string>([[BASE, BASE_ID]]);
  return async (args, o) => {
    calls.push([...args, ...(o?.check === false ? ["#nocheck"] : []), ...(o?.signal ? ["#signal"] : [])]);
    onCall(args);
    const line = args.join(" ");
    if (line.startsWith("image inspect --format {{.Id}} ") && args.length === 5) {
      const id = tags.get(args[4]!);
      if (!id) throw new Error(`Error: No such image: ${args[4]}`);
      return `${id}\n`;
    }
    if (line === `create --name made ${BASE_ID}`) return "made-id\n";
    if (line === "cp /ctx/. made:/app") return "";
    if (args[0] === "commit" && args.at(-2) === "made") {
      tags.set(args.at(-1)!, IMAGE_ID);
      return `${IMAGE_ID}\n`;
    }
    if (line === "rm --force made") return "";
    throw new Error(`unexpected docker call: ${line}`);
  };
}

test("the suite's candidate image is committed onto the base's local image ID, never built or pulled", async () => {
  const calls: string[][] = [];
  const docker = localDaemon(calls);
  const baseId = await localImageId(docker, BASE);
  assert.equal(baseId, BASE_ID);
  const made = await commitImage({ docker, fromId: baseId, context: "/ctx", into: "/app", tag: "loopcloser:t", container: "made", changes: ["USER node", "WORKDIR /app"] });
  assert.equal(made, IMAGE_ID);
  assert.deepEqual(calls, [
    ["image", "inspect", "--format", "{{.Id}}", BASE],
    ["create", "--name", "made", BASE_ID],
    ["cp", "/ctx/.", "made:/app"],
    ["commit", "--change", "USER node", "--change", "WORKDIR /app", "made", "loopcloser:t"],
    ["rm", "--force", "made", "#nocheck"],
    ["image", "inspect", "--format", "{{.Id}}", "loopcloser:t"],
  ]);

  // A base the daemon does not hold is refused, and a reference is never used where a local image ID is needed.
  await assert.rejects(localImageId(localDaemon([]), "node:24-bookworm-slim"), /node:24-bookworm-slim is not in this Docker daemon: Error: No such image/);
  await assert.rejects(commitImage({ docker: localDaemon([]), fromId: BASE, context: "/ctx", into: "/app", tag: "t", container: "made" }), /is not a local image ID/);
});

test("making the image cancelled mid-way lets the daemon change in flight complete, starts nothing more and still removes its container", async () => {
  const calls: string[][] = [];
  const setup = new AbortController();
  // The setup is cancelled while the daemon copies the context in.
  const docker = localDaemon(calls, (args) => {
    if (args[0] === "cp") setup.abort(new Error("setup timed out"));
  });
  await assert.rejects(
    commitImage({ docker, fromId: BASE_ID, context: "/ctx", into: "/app", tag: "loopcloser:t", container: "made", signal: setup.signal }),
    /setup timed out/,
  );
  assert.deepEqual(calls, [
    ["create", "--name", "made", BASE_ID],
    ["cp", "/ctx/.", "made:/app"],
    ["rm", "--force", "made", "#nocheck"],
  ]);
  // A read is given the signal, and does not start once it has aborted.
  const reads: string[][] = [];
  assert.equal(await localImageId(localDaemon(reads), BASE, new AbortController().signal), BASE_ID);
  assert.deepEqual(reads, [["image", "inspect", "--format", "{{.Id}}", BASE, "#signal"]]);
  await assert.rejects(localImageId(localDaemon([]), BASE, setup.signal), /setup timed out/);
});
