-- 0003 — Send requests and loop key-result references (LC-RUN-PG-SCHEMA-GAPS).
--
-- Every GraphTx write lands in a column: a request_send on a communication
-- (SendRequest in src/kernel/types.ts) and a loop's optional key_result_ref
-- are owned data in the exportable record, not memory-only state.
--
-- Invariant from 0002 still holds: this migration defines no functions.

BEGIN;

-- ---- Loop key-result reference ---------------------------------------------
-- Opaque external reference (contracts/schemas/v1/loop.schema.json
-- #/$defs/key_result_ref): exactly {system, id}, both non-empty strings, or
-- null when the loop was proposed without one. Stored, never resolved.

ALTER TABLE loops
  ADD COLUMN key_result_ref jsonb
    CONSTRAINT loops_key_result_ref_shape CHECK (key_result_ref IS NULL OR (
      jsonb_typeof(key_result_ref) = 'object'
      AND key_result_ref ?& ARRAY['system', 'id']
      AND key_result_ref - 'system' - 'id' = '{}'::jsonb
      AND jsonb_typeof(key_result_ref -> 'system') = 'string'
      AND jsonb_typeof(key_result_ref -> 'id') = 'string'
      AND key_result_ref ->> 'system' <> ''
      AND key_result_ref ->> 'id' <> ''));

-- ---- Send requests ---------------------------------------------------------
-- One request per communication: pending_approval until approved
-- (joe-approves-each), enqueued once the send is in the outbox, refused when
-- the loop type's receiver scope forbids a receiver (never sent).

CREATE TABLE send_requests (
  communication_id     text PRIMARY KEY REFERENCES communications (id),
  loop_id              text NOT NULL REFERENCES loops (id),
  authority            text NOT NULL CHECK (authority IN (
                         'autonomous', 'joe-approves-each', 'joe-approves-template')),
  status               text NOT NULL CHECK (status IN ('pending_approval', 'enqueued', 'refused')),
  requested_by         text NOT NULL CHECK (requested_by <> ''),
  requested_at         timestamptz NOT NULL,
  -- Set on a refused request only: the receivers outside the loop type's scope.
  refused_receiver_ids text[],
  CONSTRAINT send_requests_refused_receivers CHECK (
    CASE status
      WHEN 'refused' THEN refused_receiver_ids IS NOT NULL AND cardinality(refused_receiver_ids) >= 1
      ELSE refused_receiver_ids IS NULL
    END)
);

CREATE INDEX send_requests_loop ON send_requests (loop_id);

-- ---- App role grants (as 0001: mutable record, never deleted) ---------------

GRANT SELECT, INSERT, UPDATE ON send_requests TO loopcloser_app;

INSERT INTO schema_migrations (version, name) VALUES ('0003', 'send_requests_key_result_ref');

COMMIT;
