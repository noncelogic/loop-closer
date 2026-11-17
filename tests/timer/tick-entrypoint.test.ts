// LC-RUN-TICK acceptance: the build emits the tick entrypoint that
// deploy/base/tick-cronjob.yaml runs. One run claims due calendar Whens on
// PgTimerStore at DATABASE_URL, records each firing once in the ledger and
// exits zero; a run that cannot reach the database exits non-zero.
//
// Requires Docker with the Compose plugin (tests/schema/replica.ts).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseAllDocuments } from "yaml";
import { Replica, repoRoot } from "../schema/replica.ts";
import { buildEntrypoints, manifestScriptIn, type EntrypointBuild } from "../support/entrypoint-build.ts";
import { PgTimerStore } from "../../src/timer/pg-store.ts";
import { DuplicateIdempotencyKeyError } from "../../src/timer/store.ts";

const db = new Replica("tick-entrypoint");

// A private build output, not the shared `dist/` (tests/support/entrypoint-build.ts).
let build: EntrypointBuild | undefined;

before(
  async () => {
    build = await buildEntrypoints("tick-entrypoint");
    db.up();
    db.migrate();
  },
  { timeout: 300_000 },
);
after(
  () => {
    try {
      db.down();
    } finally {
      build?.remove();
    }
  },
  { timeout: 120_000 },
);

/** The manifest's script, resolved inside this file's private build. */
function builtScript(script: string): string {
  assert.ok(build, "the entrypoint build must have completed");
  return manifestScriptIn(build, script);
}

/** The container command of deploy/base/tick-cronjob.yaml. */
function cronJobCommand(): string[] {
  const docs = parseAllDocuments(readFileSync(join(repoRoot, "deploy", "base", "tick-cronjob.yaml"), "utf8")).map((d) => d.toJS());
  const job = docs.find((d) => d?.kind === "CronJob");
  assert.ok(job, "deploy/base/tick-cronjob.yaml must define a CronJob");
  const containers = job.spec.jobTemplate.spec.template.spec.containers as Array<{ name: string; command?: string[] }>;
  const tick = containers.find((c) => c.name === "tick");
  assert.ok(tick?.command, "the tick container must set a command");
  return tick.command;
}

/** The instant every entrypoint child and its assertions share (see fixtures/frozen-clock.mjs). */
const FROZEN_NOW = "2026-11-16T12:00:00.000Z";
const FROZEN_CLOCK = pathToFileURL(join(repoRoot, "tests", "timer", "fixtures", "frozen-clock.mjs")).href;

/**
 * Runs the manifest's command asynchronously, so fixtures in this process
 * (e.g. a TCP server) keep serving while the child runs.
 */
async function runEntrypoint(databaseUrl: string | undefined): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const [cmd, script, ...args] = cronJobCommand();
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env["DATABASE_URL"];
  if (databaseUrl !== undefined) env["DATABASE_URL"] = databaseUrl;
  env["FROZEN_NOW"] = FROZEN_NOW;
  env["NODE_OPTIONS"] = `${env["NODE_OPTIONS"] ?? ""} --import=${FROZEN_CLOCK}`.trim();
  // The image's WORKDIR is the app root, where dist/ sits; the private build
  // sits beside it, so the child resolves contracts/ and node_modules the same way.
  const child = spawn(cmd!, [builtScript(script!), ...args], { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
  child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
  const status = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
  return { status, stdout, stderr };
}

test("the command in deploy/base/tick-cronjob.yaml names a file the build emits", () => {
  const command = cronJobCommand();
  assert.equal(command[0], "node");
  const script = command[1];
  assert.ok(script, "the command must name a script");
  assert.match(script, /^dist\//, "the script must be build output (tsconfig.build.json outDir)");
  assert.ok(existsSync(builtScript(script)), `npm run build must emit ${script}`);
});

test("one entrypoint run fires a due calendar When once in the ledger and exits zero", { timeout: 120_000 }, async () => {
  db.psql(`
    INSERT INTO nodes (id, kind, created_at, status, attributes) VALUES
      ('lc_when_due', 'when', now(), 'active',
        '{"when_type":"calendar","schedule":{"rrule":"FREQ=DAILY"},"timezone":"UTC","next_fire_at":"2026-11-01T08:00:00Z"}'),
      ('lc_when_later', 'when', now(), 'active',
        '{"when_type":"calendar","schedule":{"at":"2999-01-01T00:00:00Z"},"timezone":"UTC","next_fire_at":"2999-01-01T00:00:00Z"}');`);
  const url = `postgres://loopcloser:loopcloser@127.0.0.1:${db.hostPort()}/loopcloser`;

  const first = await runEntrypoint(url);
  assert.equal(first.status, 0, `tick failed:\n${first.stderr}`);

  const fired = db
    .psql(`SELECT id || '|' || actor || '|' || idempotency_key || '|' || (payload->>'scheduled_for')
             FROM ledger_events WHERE event_type = 'when_fired' AND 'lc_when_due' = ANY(subject_ids)`)
    .split("\n")
    .filter(Boolean);
  assert.equal(fired.length, 1, `expected one when_fired event, got ${JSON.stringify(fired)}`);
  const [id, actor, key, scheduledFor] = fired[0]!.split("|");
  assert.match(id!, /^lc_[A-Za-z0-9][A-Za-z0-9_-]*$/);
  assert.equal(actor, "sensor:calendar");
  assert.equal(key, "calendar:lc_when_due:2026-11-01T08:00:00.000Z");
  assert.equal(scheduledFor, "2026-11-01T08:00:00.000Z");
  // The child ran on the injected clock, not its own wall clock.
  assert.equal(
    db.psql(`SELECT to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') FROM ledger_events WHERE id = '${id}'`),
    FROZEN_NOW,
  );

  // next_fire_at advanced to the first daily slot after the frozen now; the
  // not-yet-due When is untouched.
  const next = db.psql(`SELECT attributes->>'next_fire_at' FROM nodes WHERE id = 'lc_when_due'`);
  assert.equal(next, "2026-11-17T08:00:00.000Z");
  assert.ok(Date.parse(next) > Date.parse(FROZEN_NOW));
  assert.equal(db.psql(`SELECT count(*) FROM ledger_events WHERE 'lc_when_later' = ANY(subject_ids)`), "0");

  // A second run finds nothing due: the firing is recorded exactly once.
  const second = await runEntrypoint(url);
  assert.equal(second.status, 0, `second tick failed:\n${second.stderr}`);
  assert.equal(db.psql(`SELECT count(*) FROM ledger_events WHERE 'lc_when_due' = ANY(subject_ids)`), "1");
});

test("an entrypoint run against an unreachable database exits non-zero", { timeout: 120_000 }, async () => {
  // An owned fixture: a listener bound for the whole child run that resets
  // every connection, so no other process can take the port meanwhile.
  const sockets = new Set<net.Socket>();
  const server = new net.Server((socket) => {
    sockets.add(socket);
    socket.resetAndDestroy();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as { port: number };
  let r;
  try {
    r = await runEntrypoint(`postgres://loopcloser:loopcloser@127.0.0.1:${port}/loopcloser`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  assert.ok(sockets.size > 0, "the tick must have tried the fixture database");
  assert.notEqual(r.status, null, `the tick must exit, not hang:\n${r.stderr}`);
  assert.notEqual(r.status, 0, "an unreachable database must fail the tick");
  assert.match(r.stderr, /tick failed/);

  const missing = await runEntrypoint(undefined);
  assert.notEqual(missing.status, 0, "a tick without DATABASE_URL must fail");
  assert.match(missing.stderr, /DATABASE_URL/);
});

test("PgTimerStore rolls a failed tick transaction back and rejects a duplicate idempotency key", { timeout: 60_000 }, async () => {
  db.psql(`
    INSERT INTO nodes (id, kind, created_at, status, attributes) VALUES
      ('lc_when_rb', 'when', now(), 'active',
        '{"when_type":"calendar","schedule":{"at":"2026-11-02T00:00:00Z"},"timezone":"UTC","next_fire_at":"2026-11-02T00:00:00Z"}');`);
  const store = new PgTimerStore({ connectionString: `postgres://loopcloser:loopcloser@127.0.0.1:${db.hostPort()}/loopcloser` });
  const event = (id: string) => ({
    id, at: "2026-11-02T00:00:01Z", actor: "sensor:calendar", event_type: "when_fired",
    subject_ids: ["lc_when_rb"], payload: {}, idempotency_key: "calendar:lc_when_rb:test",
  });
  try {
    await assert.rejects(
      store.transaction(async (tx) => {
        const claimed = await tx.claimDueCalendarWhens(new Date("2026-11-02T00:00:01Z"));
        assert.ok(claimed.some((w) => w.id === "lc_when_rb"));
        await tx.appendLedgerEvent(event("lc_evt_rb1"));
        await tx.setNextFireAt("lc_when_rb", null);
        throw new Error("boom");
      }),
      /boom/,
    );
    assert.equal(db.psql(`SELECT count(*) FROM ledger_events WHERE id = 'lc_evt_rb1'`), "0");
    assert.equal(db.psql(`SELECT attributes->>'next_fire_at' FROM nodes WHERE id = 'lc_when_rb'`), "2026-11-02T00:00:00Z");

    await store.transaction((tx) => tx.appendLedgerEvent(event("lc_evt_rb2")));
    await assert.rejects(
      store.transaction((tx) => tx.appendLedgerEvent(event("lc_evt_rb3"))),
      DuplicateIdempotencyKeyError,
    );
  } finally {
    await store.close();
  }
});
