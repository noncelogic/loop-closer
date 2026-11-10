// LC-M1-T3 acceptance: the event ledger is append-only for the app role
// (SPEC B2.4; TECH-STACK §2 — "append-only tables enforced by grants").
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { Replica, seedSql } from "./replica.ts";

const db = new Replica("schema-ledger");
const APP = { role: "loopcloser_app" };

before(() => {
  db.up();
  db.migrate();
  db.psql(seedSql);
}, { timeout: 300_000 });
after(() => db.down(), { timeout: 120_000 });

test("app role cannot update or delete ledger events", { timeout: 60_000 }, () => {
  // Appending and reading are the app's whole ledger API.
  db.psql(
    `INSERT INTO ledger_events (id, at, actor, event_type, subject_ids, payload, idempotency_key)
     VALUES ('lc_evt_app', now(), 'agent:juno', 'manual_correction', ARRAY['lc_loop_1'], '{"note":"fix"}', NULL);`,
    APP,
  );
  assert.equal(db.psql("select count(*) from ledger_events", APP), "2");

  for (const sql of [
    "UPDATE ledger_events SET actor = 'agent:mallory' WHERE id = 'lc_evt_1'",
    "UPDATE ledger_events SET payload = '{}'",
    "DELETE FROM ledger_events WHERE id = 'lc_evt_1'",
    "DELETE FROM ledger_events",
    "TRUNCATE ledger_events",
  ]) {
    assert.match(db.psqlError(sql, APP), /permission denied for table ledger_events/, sql);
  }

  // Nothing changed.
  assert.equal(db.psql("select actor from ledger_events where id = 'lc_evt_1'"), "agent:juno");
  assert.equal(db.psql("select count(*) from ledger_events"), "2");
});

test("app role cannot grant itself ledger privileges or alter the table", { timeout: 60_000 }, () => {
  assert.match(db.psqlError("ALTER TABLE ledger_events DISABLE TRIGGER ALL", APP), /must be owner/);
  // Without grant option Postgres only warns ("no privileges were granted"); what matters is the effect.
  db.psql("GRANT UPDATE, DELETE, TRUNCATE ON ledger_events TO loopcloser_app", APP);
  assert.equal(db.psql("select has_table_privilege('loopcloser_app', 'ledger_events', 'UPDATE')"), "f");
  assert.equal(db.psql("select has_table_privilege('loopcloser_app', 'ledger_events', 'DELETE')"), "f");
  assert.equal(db.psql("select has_table_privilege('loopcloser_app', 'ledger_events', 'TRUNCATE')"), "f");
});
