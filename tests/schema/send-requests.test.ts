// LC-RUN-PG-SCHEMA-GAPS: migration 0003 gives every GraphTx write a column to
// land in — send requests (SendRequest in src/kernel/types.ts, one per
// communication) and a loop's key_result_ref — so both are owned, exportable
// data in the system of record rather than memory-only state.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { Replica, seedSql } from "./replica.ts";

const db = new Replica("schema-send-requests");
const APP = { role: "loopcloser_app" };

before(() => {
  db.up();
  db.migrate();
  db.psql(seedSql);
  db.psql(`
    INSERT INTO communications (id, thread_id, channel, direction, participant_who_ids, at,
                                body_pointer, body_hash, loop_id, sent_under_authority)
    VALUES ('lc_comm_1', 'thread-1', 'email', 'outbound', ARRAY['lc_who_joe'], now(), 'blob://1',
            'sha256:${"0".repeat(64)}', 'lc_loop_1', NULL),
           ('lc_comm_2', 'thread-1', 'email', 'outbound', ARRAY['lc_who_joe'], now(), 'blob://2',
            'sha256:${"1".repeat(64)}', 'lc_loop_1', NULL);`);
}, { timeout: 300_000 });
after(() => db.down(), { timeout: 120_000 });

test(
  "a send request stored for a communication is read back with its loop, authority and fields, and a second request for the same communication is refused",
  { timeout: 60_000 },
  () => {
    db.psql(
      `INSERT INTO send_requests (communication_id, loop_id, authority, status, requested_by, requested_at)
       VALUES ('lc_comm_1', 'lc_loop_1', 'joe-approves-each', 'pending_approval', 'agent:juno', '2026-11-16T10:00:00Z');`,
      APP,
    );
    assert.equal(
      db.psql(
        `SET TIME ZONE 'UTC';
         SELECT communication_id, loop_id, authority, status, requested_by, requested_at, refused_receiver_ids IS NULL
           FROM send_requests WHERE communication_id = 'lc_comm_1'`,
        APP,
      ),
      "lc_comm_1|lc_loop_1|joe-approves-each|pending_approval|agent:juno|2026-11-16 10:00:00+00|t",
    );

    // One request per communication.
    assert.match(
      db.psqlError(
        `INSERT INTO send_requests (communication_id, loop_id, authority, status, requested_by, requested_at)
         VALUES ('lc_comm_1', 'lc_loop_1', 'autonomous', 'pending_approval', 'agent:other', now());`,
        APP,
      ),
      /duplicate key value violates unique constraint/,
    );

    // The app advances it in place when the send is released.
    db.psql(`UPDATE send_requests SET status = 'enqueued' WHERE communication_id = 'lc_comm_1'`, APP);
    assert.equal(db.psql(`SELECT status FROM send_requests WHERE communication_id = 'lc_comm_1'`, APP), "enqueued");

    // A refused request records the receivers outside scope.
    db.psql(
      `INSERT INTO send_requests (communication_id, loop_id, authority, status, requested_by, requested_at, refused_receiver_ids)
       VALUES ('lc_comm_2', 'lc_loop_1', 'autonomous', 'refused', 'agent:juno', now(), ARRAY['lc_who_stranger']);`,
      APP,
    );
    assert.equal(
      db.psql(`SELECT status, array_to_string(refused_receiver_ids, ',') FROM send_requests WHERE communication_id = 'lc_comm_2'`, APP),
      "refused|lc_who_stranger",
    );

    // Vocabulary and references are enforced.
    const bad = (cols: string) =>
      db.psqlError(
        `INSERT INTO send_requests (communication_id, loop_id, authority, status, requested_by, requested_at, refused_receiver_ids)
         VALUES (${cols});`,
        APP,
      );
    assert.match(bad(`'lc_comm_x', 'lc_loop_1', 'autonomous', 'enqueued', 'a', now(), NULL`), /violates foreign key constraint/);
    assert.match(bad(`'lc_comm_x', 'lc_loop_x', 'autonomous', 'enqueued', 'a', now(), NULL`), /violates foreign key constraint/);
    assert.match(bad(`'lc_comm_1', 'lc_loop_1', 'whenever', 'enqueued', 'a', now(), NULL`), /violates check constraint/);
    assert.match(bad(`'lc_comm_1', 'lc_loop_1', 'autonomous', 'sent', 'a', now(), NULL`), /violates check constraint/);
    assert.match(bad(`'lc_comm_1', 'lc_loop_1', 'autonomous', 'refused', 'a', now(), NULL`), /violates check constraint/);

    // Send requests are part of the record: the app never deletes them.
    assert.match(db.psqlError(`DELETE FROM send_requests`, APP), /permission denied/);
  },
);

test("a loop's key_result_ref system and id are stored and read back from the loops table", { timeout: 60_000 }, () => {
  db.psql(
    `INSERT INTO loops (id, name, loop_type, state, accountable_who_id, authority,
       ageing_policy_id, ageing_policy_version, escalation_policy_id, escalation_policy_version, key_result_ref)
     VALUES ('lc_loop_kr', 'KR loop', 'errand', 'proposed', 'lc_who_joe', 'joe-approves-each',
       'lc_policy_ageing_default', 1, 'lc_policy_escalation_default', 1, '{"system":"plane","id":"KR-7"}');`,
    APP,
  );
  assert.equal(
    db.psql(`SELECT key_result_ref ->> 'system', key_result_ref ->> 'id' FROM loops WHERE id = 'lc_loop_kr'`, APP),
    "plane|KR-7",
  );
  // Absent when the loop was proposed without one.
  assert.equal(db.psql(`SELECT key_result_ref IS NULL FROM loops WHERE id = 'lc_loop_1'`, APP), "t");

  // Shape per contracts/schemas/v1/loop.schema.json#/$defs/key_result_ref.
  for (const ref of ['{"system":"plane"}', '{"system":"","id":"KR-7"}', '{"system":"plane","id":7}', '{"system":"plane","id":"KR-7","x":1}', '"plane:KR-7"']) {
    assert.match(
      db.psqlError(`UPDATE loops SET key_result_ref = '${ref}' WHERE id = 'lc_loop_kr'`, APP),
      /violates check constraint/,
      ref,
    );
  }
});
