// LC-M1-T3: loop state changes in the database follow the recorded state
// machine — the loop_state_transitions table, which mirrors the kernel's
// LOOP_TRANSITIONS plus the intake moves (accept_loop / reject_loop).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { LOOP_TRANSITIONS } from "../../src/kernel/kernel.ts";
import { Replica, seedSql } from "./replica.ts";

const db = new Replica("schema-transitions");
const APP = { role: "loopcloser_app" };

before(() => {
  db.up();
  db.migrate();
  db.psql(seedSql);
}, { timeout: 300_000 });
after(() => db.down(), { timeout: 120_000 });

const setState = (state: string, extra = "") =>
  `UPDATE loops SET state = '${state}'${extra} WHERE id = 'lc_loop_1'`;

test("the recorded state machine matches the kernel's", { timeout: 60_000 }, () => {
  const recorded = db
    .psql("select from_state || '>' || to_state || '@' || via from loop_state_transitions order by 1")
    .split("\n");
  const expected = [
    "proposed>open@accept_loop",
    "proposed>closed_with_reason@reject_loop",
    ...Object.entries(LOOP_TRANSITIONS).flatMap(([from, tos]) => tos.map((to) => `${from}>${to}@transition`)),
  ].sort();
  assert.deepEqual(recorded, expected);
  // Recorded, not editable by the app.
  assert.match(db.psqlError("DELETE FROM loop_state_transitions", APP), /permission denied/);
});

test("a loop is born proposed", { timeout: 60_000 }, () => {
  const err = db.psqlError(
    `INSERT INTO loops (id, name, loop_type, state, accountable_who_id, authority, opened_at,
       ageing_policy_id, ageing_policy_version, escalation_policy_id, escalation_policy_version)
     VALUES ('lc_loop_2', 'x', 'errand', 'open', 'lc_who_joe', 'joe-approves-each', now(),
       'lc_policy_ageing_default', 1, 'lc_policy_escalation_default', 1)`,
    APP,
  );
  assert.match(err, /must be created in state proposed/);
});

test("a temporary table cannot shadow the recorded state machine", { timeout: 60_000 }, () => {
  // The app role may create temp tables, and pg_temp is searched first for
  // unqualified names; the trigger must still read public.loop_state_transitions.
  const err = db.psqlError(
    `CREATE TEMP TABLE loop_state_transitions (from_state text, to_state text, via text);
     INSERT INTO loop_state_transitions VALUES ('proposed', 'waiting', 'transition');
     ${setState("waiting")};`,
    APP,
  );
  assert.match(err, /invalid loop transition proposed -> waiting/);
  assert.equal(db.psql("select state from loops where id = 'lc_loop_1'"), "proposed");
});

test("loop transitions follow the recorded state machine", { timeout: 60_000 }, () => {
  // proposed may not skip intake.
  assert.match(db.psqlError(setState("waiting"), APP), /invalid loop transition proposed -> waiting/);
  assert.match(
    db.psqlError(setState("closed_with_reason", ", close_reason = 'abandoned', closed_at = now()"), APP),
    /reject_loop must close with reason rejected/,
  );

  db.psql(setState("open", ", opened_at = now()"), APP);
  db.psql(setState("waiting"), APP);
  db.psql(setState("chased"), APP);
  db.psql(setState("open"), APP);
  assert.match(db.psqlError(setState("proposed"), APP), /invalid loop transition open -> proposed/);
  assert.match(
    db.psqlError(setState("closed_with_reason", ", close_reason = 'rejected', closed_at = now()"), APP),
    /close reason rejected is only for reject_loop/,
  );

  // Closing must carry the closed fields the v1 loop contract requires.
  assert.match(db.psqlError(setState("closed"), APP), /violates check constraint/);
  db.psql(setState("closed", ", closed_at = now()"), APP);

  // Closed is terminal.
  for (const to of ["open", "waiting", "chased", "closed_with_reason"]) {
    assert.match(db.psqlError(setState(to, ", closed_at = NULL"), APP), new RegExp(`invalid loop transition closed -> ${to}`));
  }
  assert.equal(db.psql("select state from loops where id = 'lc_loop_1'"), "closed");
});

test("an intake rejection closes a proposed loop with reason rejected", { timeout: 60_000 }, () => {
  db.psql(
    `INSERT INTO loops (id, name, loop_type, state, accountable_who_id, authority,
       ageing_policy_id, ageing_policy_version, escalation_policy_id, escalation_policy_version)
     VALUES ('lc_loop_3', 'dup', 'errand', 'proposed', 'lc_who_joe', 'joe-approves-each',
       'lc_policy_ageing_default', 1, 'lc_policy_escalation_default', 1);
     UPDATE loops SET state = 'closed_with_reason', close_reason = 'rejected', closed_at = now() WHERE id = 'lc_loop_3';`,
    APP,
  );
  assert.equal(db.psql("select state || ':' || close_reason from loops where id = 'lc_loop_3'"), "closed_with_reason:rejected");
});
