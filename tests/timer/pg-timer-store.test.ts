// LC-RUN-PG-TIMERSTORE acceptance: runTick on the Postgres TimerStore
// (TECH-STACK §6) against a real Compose replica. Each test gets its own
// migrated database; the store runs as loopcloser_app, so it needs only the
// app role's grants. Overlapping ticks run on independent pooled connections.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { migrationFiles, migrationsDir, Replica } from "../schema/replica.ts";
import { PgTimerStore } from "../../src/timer/pg-timer-store.ts";
import type { TimerStore, TimerTx } from "../../src/timer/store.ts";
import { runTick } from "../../src/timer/tick.ts";

const db = new Replica("pg-timer-store");
const pools: pg.Pool[] = [];
let databases = 0;

before(() => db.up(), { timeout: 300_000 });
after(async () => {
  await Promise.all(pools.map((p) => p.end()));
  db.down();
}, { timeout: 120_000 });

const NOW = new Date("2026-11-09T14:00:30Z");

const SEED = `
INSERT INTO nodes (id, kind, created_at, status, attributes) VALUES
  ('lc_who_joe', 'who', '2026-11-01T00:00:00Z', 'active', '{"who_type":"person","name":"Joe"}'),
  ('lc_when_review', 'when', '2026-11-07T15:30:00Z', 'active',
   '{"when_type":"calendar","schedule":{"rrule":"FREQ=WEEKLY;BYDAY=MO"},"timezone":"America/New_York","next_fire_at":"2026-11-09T14:00:00Z"}'),
  ('lc_when_future', 'when', '2026-11-07T15:30:00Z', 'active',
   '{"when_type":"calendar","schedule":{"at":"2026-12-01T17:00:00Z"},"timezone":"UTC","next_fire_at":"2026-12-01T17:00:00Z"}'),
  ('lc_when_dead', 'when', '2026-11-07T15:30:00Z', 'tombstoned',
   '{"when_type":"calendar","schedule":{"at":"2026-11-08T00:00:00Z"},"timezone":"UTC","next_fire_at":"2026-11-08T00:00:00Z"}'),
  ('lc_when_reply', 'when', '2026-11-07T15:30:00Z', 'active',
   '{"when_type":"event","event_type":"reply_received","fired_at":null,"fire_count":0}');
INSERT INTO loops (id, name, loop_type, state, accountable_who_id, closing_when_id, authority,
                   ageing_policy_id, ageing_policy_version, escalation_policy_id, escalation_policy_version)
VALUES ('lc_loop_stale', 'Weekly review', 'outreach', 'proposed', 'lc_who_joe', 'lc_when_review',
        'joe-approves-each', 'lc_policy_ageing_outreach', 1, 'lc_policy_escalation_default', 1);
INSERT INTO ledger_events (id, at, actor, event_type, subject_ids, payload, idempotency_key)
VALUES ('lc_evt_seed', '2026-11-01T12:00:00Z', 'agent:juno', 'loop_proposed', ARRAY['lc_loop_stale'], '{}', NULL);
`;

/** A fresh migrated, seeded database, and a pool whose connections act as loopcloser_app. */
function freshPool(): pg.Pool {
  const name = `lc_timer_${++databases}`;
  db.psql(`CREATE DATABASE ${name}`);
  db.psql(`${migrationSql()}\n${SEED}`, { database: name });
  const pool = new pg.Pool({ connectionString: db.databaseUrl(name), max: 4 });
  pool.on("connect", (client) => void client.query("SET ROLE loopcloser_app"));
  pools.push(pool);
  return pool;
}

/** Every versioned migration, in apply order, as one psql script. */
function migrationSql(): string {
  return migrationFiles()
    .map((f) => readFileSync(join(migrationsDir, f), "utf8"))
    .join("\n");
}

async function attributes(pool: pg.Pool, id: string): Promise<Record<string, unknown>> {
  const res = await pool.query<{ attributes: Record<string, unknown> }>("SELECT attributes FROM nodes WHERE id = $1", [id]);
  assert.ok(res.rows[0], id);
  return res.rows[0].attributes;
}

async function ledger(pool: pg.Pool): Promise<Array<Record<string, unknown>>> {
  const res = await pool.query("SELECT id, actor, event_type, subject_ids, payload, idempotency_key FROM ledger_events WHERE event_type = 'when_fired' ORDER BY seq");
  return res.rows;
}

function idGen(prefix: string): () => string {
  let n = 0;
  return () => `lc_evt_${prefix}_${++n}`;
}

test("runTick on PgTimerStore writes one ledger firing for a due When and advances its next_fire_at", { timeout: 120_000 }, async () => {
  const pool = freshPool();
  const store = new PgTimerStore(pool, {
    ageingPolicies: [{ id: "lc_policy_ageing_outreach", version: 1, max_dwell_seconds: { proposed: 86_400 } }],
  });

  const report = await runTick(store, { now: NOW, newId: idGen("a") });

  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.fired, [
    {
      when_id: "lc_when_review",
      event_id: "lc_evt_a_1",
      scheduled_for: "2026-11-09T14:00:00.000Z",
      next_fire_at: "2026-11-16T14:00:00.000Z",
      missed_occurrences: 0,
    },
  ]);
  assert.deepEqual(await ledger(pool), [
    {
      id: "lc_evt_a_1",
      actor: "sensor:calendar",
      event_type: "when_fired",
      subject_ids: ["lc_when_review"],
      payload: { scheduled_for: "2026-11-09T14:00:00.000Z", next_fire_at: "2026-11-16T14:00:00.000Z", missed_occurrences: 0 },
      idempotency_key: "calendar:lc_when_review:2026-11-09T14:00:00.000Z",
    },
  ]);

  // Advanced in the same transaction; the recurrence anchor is pinned in the schedule.
  const review = await attributes(pool, "lc_when_review");
  assert.equal(review["next_fire_at"], "2026-11-16T14:00:00.000Z");
  assert.equal((review["schedule"] as Record<string, unknown>)["rrule"], "FREQ=WEEKLY;BYDAY=MO");
  assert.equal((await attributes(pool, "lc_when_future"))["next_fire_at"], "2026-12-01T17:00:00Z");
  assert.equal((await attributes(pool, "lc_when_dead"))["next_fire_at"], "2026-11-08T00:00:00Z");

  // Ageing breaches are judged from the loop's latest state-entering ledger event.
  assert.deepEqual(
    report.breaches.map((b) => [b.loop_id, b.state, b.state_entered_at]),
    [["lc_loop_stale", "proposed", "2026-11-01T12:00:00.000Z"]],
  );

  // A second tick in the same minute finds nothing due.
  const again = await runTick(store, { now: NOW, newId: idGen("b") });
  assert.deepEqual(again.fired, []);
  assert.equal((await ledger(pool)).length, 1);

  // A one-off When fires once, then disarms (next_fire_at = null).
  await pool.query(
    `INSERT INTO nodes (id, kind, created_at, status, attributes) VALUES ('lc_when_once', 'when', now(), 'active',
     '{"when_type":"calendar","schedule":{"at":"2026-11-09T13:00:00Z"},"timezone":"UTC","next_fire_at":"2026-11-09T13:00:00Z"}')`,
  );
  const once = await runTick(store, { now: NOW, newId: idGen("c") });
  assert.deepEqual(once.fired.map((f) => [f.when_id, f.next_fire_at]), [["lc_when_once", null]]);
  assert.equal((await attributes(pool, "lc_when_once"))["next_fire_at"], null);
});

test("two concurrent runTick calls on PgTimerStore fire the same due When exactly once", { timeout: 120_000 }, async () => {
  const pool = freshPool();
  const store = new PgTimerStore(pool);

  // Tick A claims the due When and then holds its transaction open until tick B has run to completion
  // on its own connection, so the two ticks truly overlap.
  let claimed!: () => void;
  const aClaimed = new Promise<void>((resolve) => (claimed = resolve));
  let releaseA!: () => void;
  const aMayCommit = new Promise<void>((resolve) => (releaseA = resolve));
  const holding: TimerStore = {
    transaction: (fn) =>
      store.transaction((tx) =>
        fn({
          ...tx,
          async claimDueCalendarWhens(now) {
            const rows = await tx.claimDueCalendarWhens(now);
            claimed();
            await aMayCommit;
            return rows;
          },
        } satisfies TimerTx),
      ),
  };

  const a = runTick(holding, { now: NOW, newId: idGen("a") });
  await aClaimed;
  const b = await runTick(store, { now: NOW, newId: idGen("b") });
  assert.deepEqual(b.fired, [], "tick B must skip the When tick A holds");
  releaseA();
  const ra = await a;
  assert.deepEqual(ra.fired.map((f) => f.when_id), ["lc_when_review"]);

  // Unsynchronised overlap too: two more ticks racing on independent connections after the When is due again.
  await pool.query(
    `UPDATE nodes SET attributes = jsonb_set(attributes, '{next_fire_at}', '"2026-11-16T14:00:00Z"') WHERE id = 'lc_when_review'`,
  );
  const later = new Date("2026-11-16T14:00:30Z");
  const [c, d] = await Promise.all([
    runTick(store, { now: later, newId: idGen("c") }),
    runTick(store, { now: later, newId: idGen("d") }),
  ]);
  assert.equal(c.fired.length + d.fired.length, 1);

  const fired = await ledger(pool);
  assert.deepEqual(
    fired.map((e) => e["idempotency_key"]),
    ["calendar:lc_when_review:2026-11-09T14:00:00.000Z", "calendar:lc_when_review:2026-11-16T14:00:00.000Z"],
  );
  assert.equal((await attributes(pool, "lc_when_review"))["next_fire_at"], "2026-11-23T14:00:00.000Z");
});

test("a failing tick on PgTimerStore rolls back its claims, events and advances", { timeout: 120_000 }, async () => {
  const pool = freshPool();
  await pool.query(
    `INSERT INTO nodes (id, kind, created_at, status, attributes) VALUES ('lc_when_daily', 'when', now(), 'active',
     '{"when_type":"calendar","schedule":{"rrule":"FREQ=DAILY"},"timezone":"UTC","next_fire_at":"2026-11-06T08:00:00Z"}')`,
  );
  const store = new PgTimerStore(pool);
  let n = 0;
  const newId = () => {
    if (++n === 2) throw new Error("boom");
    return `lc_evt_x_${n}`;
  };
  await assert.rejects(runTick(store, { now: NOW, newId }), /boom/);

  assert.deepEqual(await ledger(pool), []);
  assert.equal((await attributes(pool, "lc_when_daily"))["next_fire_at"], "2026-11-06T08:00:00Z");
  assert.equal((await attributes(pool, "lc_when_review"))["next_fire_at"], "2026-11-09T14:00:00Z");

  // The rows are unlocked again: the next tick fires both.
  const ok = await runTick(store, { now: NOW, newId: idGen("ok") });
  assert.deepEqual(ok.fired.map((f) => f.when_id), ["lc_when_daily", "lc_when_review"]);
});
