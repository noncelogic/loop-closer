// LC-M1-T1 acceptance: a clean checkout builds the loopcloser service skeleton.
//
// Copies exactly the files git would hand a fresh clone (tracked + untracked
// non-ignored, so it also works before the change is committed) into a temp
// directory, then runs the same install/build the CI does and boots the
// built service to prove the artefact is real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { once } from "node:events";
import { readinessPort } from "./readiness.ts";

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

function checkoutFiles(): string[] {
  const out = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  return out.split("\0").filter((f) => f.length > 0 && existsSync(join(repoRoot, f)));
}

function run(cmd: string, args: string[], cwd: string): void {
  execFileSync(cmd, args, { cwd, stdio: "inherit", env: { ...process.env, CI: "true" } });
}

test("clean checkout builds the service skeleton", { timeout: 300_000 }, async () => {
  const work = mkdtempSync(join(tmpdir(), "loopcloser-clean-"));
  try {
    for (const file of checkoutFiles()) {
      mkdirSync(dirname(join(work, file)), { recursive: true });
      cpSync(join(repoRoot, file), join(work, file));
    }
    assert.ok(!existsSync(join(work, "node_modules")), "clean checkout must not carry node_modules");
    assert.ok(!existsSync(join(work, "dist")), "clean checkout must not carry build output");

    run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], work);
    run("npm", ["run", "build"], work);

    const entry = join(work, "dist", "main.js");
    assert.ok(existsSync(entry), "build must emit dist/main.js");

    // Boot the built service on an ephemeral port and hit its health endpoint.
    const child = spawn(process.execPath, [entry], {
      cwd: work,
      env: { ...process.env, PORT: "0", HOST: "127.0.0.1" },
      stdio: ["ignore", "pipe", "inherit"],
    });
    try {
      let buffered = "";
      const port = await new Promise<number>((resolve, reject) => {
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          buffered += chunk;
          // Wait for a complete newline-terminated readiness line; a chunk
          // boundary inside the port number must not resolve a truncated port.
          const ready = readinessPort(buffered);
          if (ready !== undefined) resolve(ready);
        });
        child.once("exit", (code) => reject(new Error(`service exited early with code ${code}`)));
      });
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { service: "loopcloser", status: "ok" });
    } finally {
      child.kill("SIGTERM");
      if (child.exitCode === null) await once(child, "exit");
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
