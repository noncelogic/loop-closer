// LC-M1-T3 acceptance: the versioned schema files in db/migrations create the
// SPEC B2 loop model — nodes, edges, loops, the append-only ledger,
// communications — plus the transactional outbox (TECH-STACK §6) and the
// recorded loop state machine, on a fresh local database.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { migrationFiles, Replica, seedSql } from "./replica.ts";

const db = new Replica("schema-migrations");

before(() => db.up(), { timeout: 300_000 });
after(() => db.down(), { timeout: 120_000 });

const B2_TABLES = [
  "communications",
  "edges",
  "ledger_events",
  "loop_members",
  "loop_state_transitions",
  "loops",
  "nodes",
  "outbox",
  "schema_migrations",
];

test("migrations create the B2 tables on a fresh database", { timeout: 120_000 }, () => {
  assert.equal(
    db.psql("select count(*) from pg_tables where schemaname = 'public'"),
    "0",
    "the replica database must start empty",
  );

  const files = migrationFiles();
  assert.ok(files.length > 0, "expected versioned schema files in db/migrations");
  db.migrate();

  const tables = db.psql("select tablename from pg_tables where schemaname = 'public' order by tablename").split("\n");
  for (const t of B2_TABLES) assert.ok(tables.includes(t), `missing table ${t}; have ${tables.join(", ")}`);

  // Every schema file records its version once it is applied.
  const applied = db.psql("select version from schema_migrations order by version").split("\n");
  assert.deepEqual(applied, files.map((f) => f.slice(0, 4)));

  // The ledger's idempotency key is unique, so a double-delivered event applies once.
  db.psql(seedSql);
  const dup = db.psqlError(`
    INSERT INTO ledger_events (id, at, actor, event_type, subject_ids, payload, idempotency_key) VALUES
      ('lc_evt_a', now(), 'sensor:ci', 'when_fired', ARRAY['lc_when_reply'], '{}', 'ci:run:42'),
      ('lc_evt_b', now(), 'sensor:ci', 'when_fired', ARRAY['lc_when_reply'], '{}', 'ci:run:42');`);
  assert.match(dup, /duplicate key value violates unique constraint/);

  // Vocabulary from the v1 contracts is enforced, not just documented.
  assert.match(
    db.psqlError(`INSERT INTO nodes (id, kind, created_at, status, attributes) VALUES ('lc_x', 'where', now(), 'active', '{}')`),
    /violates check constraint/,
  );
  assert.match(
    db.psqlError(`INSERT INTO edges (id, from_id, to_id, edge_type, created_by, created_at, status)
                  VALUES ('lc_edge_x', 'lc_when_reply', 'lc_what_packet', 'teleports', 'agent:juno', now(), 'active')`),
    /violates check constraint/,
  );
});

test("re-applying the schema files is a no-op", { timeout: 60_000 }, () => {
  const before = db.psql("select count(*) from schema_migrations");
  db.migrate();
  assert.equal(db.psql("select count(*) from schema_migrations"), before);
  assert.equal(db.psql("select count(*) from ledger_events where id = 'lc_evt_1'"), "1");
});

test("outbox rows commit or roll back with the state change that wrote them", { timeout: 60_000 }, () => {
  // Rolled back: neither the ledger event nor the outbox row survives.
  db.psql(`
    BEGIN;
    INSERT INTO ledger_events (id, at, actor, event_type, subject_ids, payload)
      VALUES ('lc_evt_rb', now(), 'agent:juno', 'when_fired', ARRAY['lc_when_reply'], '{}');
    INSERT INTO outbox (ledger_event_id, topic, payload) VALUES ('lc_evt_rb', 'workflow_run.start', '{}');
    ROLLBACK;`, { role: "loopcloser_app" });
  assert.equal(db.psql("select count(*) from outbox"), "0");

  // Committed: the outbox row is pending until the worker claims and delivers it.
  db.psql(`
    BEGIN;
    INSERT INTO ledger_events (id, at, actor, event_type, subject_ids, payload)
      VALUES ('lc_evt_ok', now(), 'agent:juno', 'when_fired', ARRAY['lc_when_reply'], '{}');
    INSERT INTO outbox (ledger_event_id, topic, payload) VALUES ('lc_evt_ok', 'workflow_run.start', '{"loop_id":"lc_loop_1"}');
    COMMIT;`, { role: "loopcloser_app" });
  assert.equal(
    db.psql("select topic, attempts, delivered_at is null from outbox where ledger_event_id = 'lc_evt_ok'"),
    "workflow_run.start|0|t",
  );

  // The worker drains it with a skip-locked claim, then marks it delivered.
  const claimed = db.psql(`
    WITH next AS (
      SELECT id FROM outbox WHERE delivered_at IS NULL AND available_at <= now()
      ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1
    )
    UPDATE outbox o SET attempts = attempts + 1, delivered_at = now()
    FROM next WHERE o.id = next.id RETURNING o.ledger_event_id;`, { role: "loopcloser_app" });
  assert.equal(claimed, "lc_evt_ok");

  // An outbox row must cite a real ledger event.
  assert.match(
    db.psqlError(`INSERT INTO outbox (ledger_event_id, topic, payload) VALUES ('lc_evt_missing', 'send', '{}')`, {
      role: "loopcloser_app",
    }),
    /violates foreign key constraint/,
  );
});
