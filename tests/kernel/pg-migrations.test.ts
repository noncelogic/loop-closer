// LC-RUN-PG-PERSIST-GAPS acceptance: migration 0003 gives SendRequest
// (src/kernel/types.ts) and a loop's key_result_ref a column, so every entity
// the kernel holds in memory has a Postgres home. Checked with the
// LC-RUN-PG-CLIENT harness against a real local Postgres, through the
// loopcloser_app role and its grants only.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { KeyResultRef, SendRequest } from "../../src/kernel/types.ts";
import { seedSql } from "../schema/replica.ts";
import { PgHarness } from "./pg-harness.ts";

const harness = new PgHarness("pg-migrations");

before(() => harness.up(), { timeout: 300_000 });
after(() => harness.down(), { timeout: 120_000 });

const COMMUNICATION = `
INSERT INTO communications (id, thread_id, channel, direction, participant_who_ids, at,
                            body_pointer, body_hash, loop_id, sent_under_authority)
VALUES ('lc_comm_1', 'thread-1', 'email', 'outbound', ARRAY['lc_who_joe'], now(), 'blob://1',
        'sha256:${"0".repeat(64)}', 'lc_loop_1', NULL),
       ('lc_comm_2', 'thread-1', 'email', 'outbound', ARRAY['lc_who_joe'], now(), 'blob://2',
        'sha256:${"1".repeat(64)}', 'lc_loop_1', NULL);`;

test(
  "migration 0003 stores and reads back a SendRequest row and a loop's key_result_ref",
  { timeout: 120_000 },
  async () => {
    // Before 0003 neither has a home.
    const before0003 = await harness.freshDatabase({ through: "0002" });
    const { rows: missing } = await before0003.pool.query<{ t: string | null; c: string }>(
      `SELECT to_regclass('public.send_requests') AS t,
              (SELECT count(*) FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'loops' AND column_name = 'key_result_ref') AS c`,
    );
    assert.equal(missing[0]!.t, null);
    assert.equal(Number(missing[0]!.c), 0);

    const db = await harness.freshDatabase({ through: "0003" });
    const { rows: versions } = await db.pool.query<{ version: string }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    assert.deepEqual(versions.map((r) => r.version), ["0001", "0002", "0003"]);
    await db.pool.query(seedSql);
    await db.pool.query(COMMUNICATION);

    const app = db.appPool();

    // A loop's key_result_ref: written and read back by the app role.
    const ref: KeyResultRef = { system: "plane", id: "CP-OWNER-1-KR2" };
    await app.query("UPDATE loops SET key_result_ref = $1 WHERE id = 'lc_loop_1'", [JSON.stringify(ref)]);
    const { rows: loops } = await app.query<{ key_result_ref: KeyResultRef | null }>(
      "SELECT key_result_ref FROM loops WHERE id = 'lc_loop_1'",
    );
    assert.deepEqual(loops[0]!.key_result_ref, ref);
    // Malformed references are refused by the column's shape check.
    await assert.rejects(
      app.query("UPDATE loops SET key_result_ref = $1 WHERE id = 'lc_loop_1'", [JSON.stringify({ system: "plane" })]),
      /loops_key_result_ref_shape/,
    );

    // A SendRequest: stored, read back field for field, then moved on.
    const sent: SendRequest = {
      communication_id: "lc_comm_1",
      loop_id: "lc_loop_1",
      authority: "joe-approves-each",
      status: "pending_approval",
      requested_by: "agent:juno",
      requested_at: "2026-11-17T09:30:00.000Z",
    };
    await app.query(
      `INSERT INTO send_requests (communication_id, loop_id, authority, status, requested_by, requested_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [sent.communication_id, sent.loop_id, sent.authority, sent.status, sent.requested_by, sent.requested_at],
    );
    const refused: SendRequest = {
      communication_id: "lc_comm_2",
      loop_id: "lc_loop_1",
      authority: "autonomous",
      status: "refused",
      requested_by: "agent:juno",
      requested_at: "2026-11-17T09:31:00.000Z",
      refused_receiver_ids: ["lc_who_stranger"],
    };
    await app.query(
      `INSERT INTO send_requests (communication_id, loop_id, authority, status, requested_by, requested_at,
                                  refused_receiver_ids)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        refused.communication_id, refused.loop_id, refused.authority, refused.status,
        refused.requested_by, refused.requested_at, refused.refused_receiver_ids,
      ],
    );

    const read = async (): Promise<SendRequest[]> => {
      const { rows } = await app.query<{
        communication_id: string; loop_id: string; authority: SendRequest["authority"];
        status: SendRequest["status"]; requested_by: string; requested_at: Date; refused_receiver_ids: string[] | null;
      }>(
        `SELECT communication_id, loop_id, authority, status, requested_by, requested_at, refused_receiver_ids
           FROM send_requests ORDER BY communication_id`,
      );
      return rows.map((r) => ({
        communication_id: r.communication_id,
        loop_id: r.loop_id,
        authority: r.authority,
        status: r.status,
        requested_by: r.requested_by,
        requested_at: r.requested_at.toISOString(),
        ...(r.refused_receiver_ids === null ? {} : { refused_receiver_ids: r.refused_receiver_ids }),
      }));
    };
    assert.deepEqual(await read(), [sent, refused]);

    await app.query("UPDATE send_requests SET status = 'enqueued' WHERE communication_id = 'lc_comm_1'");
    assert.deepEqual(await read(), [{ ...sent, status: "enqueued" }, refused]);

    // Grants follow 0001's mutable-record pattern: never deleted by the app role.
    await assert.rejects(app.query("DELETE FROM send_requests"), /permission denied/);
    // One request per communication.
    await assert.rejects(
      app.query(
        `INSERT INTO send_requests (communication_id, loop_id, authority, status, requested_by, requested_at)
         VALUES ('lc_comm_1', 'lc_loop_1', 'autonomous', 'enqueued', 'agent:juno', now())`,
      ),
      /duplicate key/,
    );
  },
);
