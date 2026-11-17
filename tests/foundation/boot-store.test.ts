// LC-RUN-API-BOOT-PG acceptance: the API entrypoint (src/main.ts) serves from
// a Kernel over PgGraphStore at DATABASE_URL, so an accepted loop survives a
// restart; without DATABASE_URL it refuses to start unless test mode is
// selected explicitly; SIGTERM closes its pool and exits zero.
//
// Requires Docker with the Compose plugin (tests/schema/replica.ts).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { Replica, repoRoot } from "../schema/replica.ts";
import { experimentProposal } from "../kernel/fixtures.ts";
import { API_KEYS_DIR_ENV, TEST_MODE_ENV } from "../../src/config.ts";
import { JOE_PRINCIPAL } from "../../src/server.ts";
import { readinessPort } from "./readiness.ts";

const db = new Replica("boot-store");
const KEY = "boot-store-joe-key";
const entry = join(repoRoot, "src", "main.ts");
let keysDir: string;

before(
  () => {
    keysDir = mkdtempSync(join(tmpdir(), "loopcloser-keys-"));
    writeFileSync(join(keysDir, JOE_PRINCIPAL), `${KEY}\n`);
    db.up();
    db.migrate();
  },
  { timeout: 300_000 },
);
after(() => {
  rmSync(keysDir, { recursive: true, force: true });
  db.down();
}, { timeout: 120_000 });

/** The entrypoint's environment: none of the caller's DATABASE_URL or test-mode selection leaks in. */
function apiEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: "0", HOST: "127.0.0.1", [API_KEYS_DIR_ENV]: keysDir };
  delete env["DATABASE_URL"];
  delete env[TEST_MODE_ENV];
  return { ...env, ...extra };
}

interface Running {
  child: ChildProcess;
  base: string;
  stderr: () => string;
}

async function boot(env: NodeJS.ProcessEnv): Promise<Running> {
  const child = spawn(process.execPath, [entry], { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stderr!.setEncoding("utf8").on("data", (d: string) => (stderr += d));
  const port = await new Promise<number>((resolve, reject) => {
    child.stdout!.setEncoding("utf8").on("data", (d: string) => {
      stdout += d;
      const ready = readinessPort(stdout);
      if (ready !== undefined) resolve(ready);
    });
    child.once("exit", (code) => reject(new Error(`API exited early with code ${code}:\n${stderr}`)));
  });
  return { child, base: `http://127.0.0.1:${port}/v1`, stderr: () => stderr };
}

/** Sends SIGTERM and returns the exit code. */
async function stop(api: Running): Promise<number | null> {
  const exited = once(api.child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
  api.child.kill("SIGTERM");
  const [code] = await exited;
  return code;
}

async function call(api: Running, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { authorization: `Bearer ${KEY}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${api.base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: await res.json() };
}

test("the API booted with DATABASE_URL persists an accepted loop that a restarted API reads back", { timeout: 120_000 }, async () => {
  const env = apiEnv({ DATABASE_URL: db.databaseUrl() });

  const first = await boot(env);
  let loopId: string;
  try {
    const proposed = await call(first, "POST", "/loops/propose", experimentProposal());
    assert.equal(proposed.status, 201, JSON.stringify(proposed.body));
    loopId = proposed.body.loop.id;
    const accepted = await call(first, "POST", `/loops/${loopId}/accept`, { acceptor: "joe" });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.loop.state, "open");
  } finally {
    const code = await stop(first);
    assert.equal(code, 0, `SIGTERM must close the pool and exit zero:\n${first.stderr()}`);
  }

  // The loop is in Postgres, not in the stopped process's memory.
  assert.equal(db.psql(`SELECT state FROM loops WHERE id = '${loopId}'`), "open");

  const second = await boot(env);
  try {
    const open = await call(second, "GET", "/loops");
    assert.equal(open.status, 200, JSON.stringify(open.body));
    const loops = (open.body as { loops: Array<{ loop: { id: string; state: string } }> }).loops.map((o) => o.loop);
    assert.deepEqual(
      loops.filter((l) => l.id === loopId).map((l) => l.state),
      ["open"],
      `the restarted API must read back the accepted loop, got ${JSON.stringify(loops)}`,
    );
  } finally {
    assert.equal(await stop(second), 0, second.stderr());
  }
});

test("the API exits non-zero when DATABASE_URL is unset and test mode is not selected", { timeout: 60_000 }, async () => {
  const child = spawn(process.execPath, [entry], { cwd: repoRoot, env: apiEnv({}), stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
  child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
  // `close` follows the end of stdout/stderr, so both buffers are complete
  // before they are asserted on; `exit` can fire with output still in flight.
  const [code] = (await once(child, "close")) as [number | null];
  assert.notEqual(code, null, "the API must exit on its own, not be killed");
  assert.notEqual(code, 0, "an API without DATABASE_URL must not start");
  assert.match(stderr, /DATABASE_URL/);
  assert.doesNotMatch(stdout, /listening on/, "it must refuse before it listens");

  // Selecting test mode explicitly is the only way to serve without a database.
  const testMode = await boot(apiEnv({ [TEST_MODE_ENV]: "1" }));
  assert.equal(await stop(testMode), 0, testMode.stderr());
});
