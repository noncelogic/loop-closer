-- 0004 — Suspend a loop without closing it (LC-CP-SUSPEND).
--
-- suspended is a non-terminal loop state (contracts/schemas/v1/loop.schema.json
-- #/$defs/loop_state): a transition enters it from open and leaves it back to
-- open only. It is not closed (closed_at and close_reason stay null), and its
-- Whens are not armed: the tick does not claim a calendar When held by a
-- suspended loop (see src/timer/pg-store.ts), so the slot stays due and fires
-- once when the loop resumes.
--
-- Invariant from 0002 still holds: this migration defines no functions.

BEGIN;

ALTER TABLE loops DROP CONSTRAINT loops_state_check;
ALTER TABLE loops ADD CONSTRAINT loops_state_check CHECK (state IN (
  'proposed', 'open', 'waiting', 'chased', 'suspended', 'closed', 'closed_with_reason'));

INSERT INTO loop_state_transitions (from_state, to_state, via) VALUES
  ('open',      'suspended', 'transition'),
  ('suspended', 'open',      'transition');

INSERT INTO schema_migrations (version, name) VALUES ('0004', 'loop_suspended_state');

COMMIT;
