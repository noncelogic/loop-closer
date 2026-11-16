// LC-RUN-TICK acceptance: the build emits the tick entrypoint that
// deploy/tick-cronjob.yaml runs. One run claims due calendar Whens on
// PgTimerStore at DATABASE_URL, records each firing once in the ledger and
// exits zero; a run that cannot reach the database exits non-zero.
//
// Requires Docker with the Compose plugin (tests/schema/replica.ts).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";
import { Replica, repoRoot } from "../schema/replica.ts";
import { PgTimerStore } from "../../src/timer/pg-store.ts";
import { DuplicateIdempotencyKeyError } from "../../src/timer/store.ts";

const db = new Replica("tick-entrypoint");

before(
  () => {
    execFileSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "inherit" });
    db.up();
    db.migrate();
  },
  { timeout: 300_000 },
);
after(() => db.down(), { timeout: 120_000 });

/** The container command of deploy/tick-cronjob.yaml. */
function cronJobCommand(): string[] {
  const docs = parseAllDocuments(readFileSync(join(repoRoot, "deploy", "tick-cronjob.yaml"), "utf8")).map((d) => d.toJS());
  const job = docs.find((d) => d?.kind === "CronJob");
  assert.ok(job, "deploy/tick-cronjob.yaml must define a CronJob");
  const containers = job.spec.jobTemplate.spec.template.spec.containers as Array<{ name: string; command?: string[] }>;
  const tick = containers.find((c) => c.name === "tick");
  assert.ok(tick?.command, "the tick container must set a command");
  return tick.command;
}

function runEntrypoint(databaseUrl: string | undefined): { status: number | null; stdout: string; stderr: string } {
  const [cmd, ...args] = cronJobCommand();
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env["DATABASE_URL"];
  if (databaseUrl !== undefined) env["DATABASE_URL"] = databaseUrl;
  // The image's WORKDIR is the app root, where dist/ sits.
  const r = spawnSync(cmd!, args, { cwd: repoRoot, env, encoding: "utf8", timeout: 60_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test("the command in deploy/tick-cronjob.yaml names a file the build emits", () => {
  const command = cronJobCommand();
  assert.equal(command[0], "node");
  const script = command[1];
  assert.ok(script, "the command must name a script");
  assert.match(script, /^dist\//, "the script must be build output (tsconfig.build.json outDir)");
  assert.ok(existsSync(join(repoRoot, script)), `npm run build must emit ${script}`);
});

test("one entrypoint run fires a due calendar When once in the ledger and exits zero", { timeout: 120_000 }, () => {
  db.psql(`
    INSERT INTO nodes (id, kind, created_at, status, attributes) VALUES
      ('lc_when_due', 'when', now(), 'active',
        '{"when_type":"calendar","schedule":{"rrule":"FREQ=DAILY"},"timezone":"UTC","next_fire_at":"2026-11-01T08:00:00Z"}'),
      ('lc_when_later', 'when', now(), 'active',
        '{"when_type":"calendar","schedule":{"at":"2999-01-01T00:00:00Z"},"timezone":"UTC","next_fire_at":"2999-01-01T00:00:00Z"}');`);
  const url = `postgres://loopcloser:loopcloser@127.0.0.1:${db.hostPort()}/loopcloser`;

  const first = runEntrypoint(url);
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

  // next_fire_at advanced into the future; the not-yet-due When is untouched.
  const next = db.psql(`SELECT attributes->>'next_fire_at' FROM nodes WHERE id = 'lc_when_due'`);
  assert.ok(Date.parse(next) > Date.now(), `next_fire_at must advance past now, got ${next}`);
  assert.equal(db.psql(`SELECT count(*) FROM ledger_events WHERE 'lc_when_later' = ANY(subject_ids)`), "0");

  // A second run finds nothing due: the firing is recorded exactly once.
  const second = runEntrypoint(url);
  assert.equal(second.status, 0, `second tick failed:\n${second.stderr}`);
  assert.equal(db.psql(`SELECT count(*) FROM ledger_events WHERE 'lc_when_due' = ANY(subject_ids)`), "1");
});

test("an entrypoint run against an unreachable database exits non-zero", { timeout: 120_000 }, async () => {
  // A port nothing listens on: bind an ephemeral one, then free it.
  const server = new net.Server();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));

  const r = runEntrypoint(`postgres://loopcloser:loopcloser@127.0.0.1:${port}/loopcloser`);
  assert.notEqual(r.status, 0, "an unreachable database must fail the tick");
  assert.notEqual(r.status, null, `the tick must exit, not hang:\n${r.stderr}`);
  assert.match(r.stderr, /tick failed/);

  const missing = runEntrypoint(undefined);
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
