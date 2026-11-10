-- 0001 — Loop Closer loop model (SPEC B2; TECH-STACK §2, §4, §6).
--
-- Versioned schema file: applied once, in filename order, by a migration role
-- that owns the tables (the `loopcloser` database owner). The service runs as
-- `loopcloser_app`, which holds only the grants below. Applying this to the
-- estate cluster is deployment work (LC-D1).
--
-- Vocabularies mirror contracts/schemas/v1; the loop state machine mirrors the
-- kernel's LOOP_TRANSITIONS (src/kernel/kernel.ts) plus the intake moves.

BEGIN;

CREATE TABLE schema_migrations (
  version    text PRIMARY KEY CHECK (version ~ '^[0-9]{4}$'),
  name       text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- The app role. NOLOGIN here: deployment (LC-D1) decides how the service
-- authenticates as it (a login role granted membership, or LOGIN + secret).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'loopcloser_app') THEN
    CREATE ROLE loopcloser_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;

-- ---- B2.1 Node -------------------------------------------------------------

CREATE TABLE nodes (
  id         text PRIMARY KEY CHECK (id ~ '^lc_[A-Za-z0-9][A-Za-z0-9_-]*$'),
  kind       text NOT NULL CHECK (kind IN ('who', 'what', 'when')),
  created_at timestamptz NOT NULL,
  status     text NOT NULL CHECK (status IN ('active', 'superseded', 'merged', 'tombstoned')),
  attributes jsonb NOT NULL CHECK (jsonb_typeof(attributes) = 'object')
);

-- Calendar Whens due for the timer tick (TECH-STACK §6).
CREATE INDEX nodes_due_calendar_whens ON nodes (((attributes ->> 'next_fire_at')))
  WHERE kind = 'when' AND status = 'active' AND attributes ->> 'when_type' = 'calendar';

-- ---- B2.2 Edge -------------------------------------------------------------

CREATE TABLE edges (
  id         text PRIMARY KEY CHECK (id ~ '^lc_[A-Za-z0-9][A-Za-z0-9_-]*$'),
  from_id    text NOT NULL REFERENCES nodes (id),
  to_id      text NOT NULL REFERENCES nodes (id),
  edge_type  text NOT NULL CHECK (edge_type IN (
               'causes', 'enables', 'blocks',
               'depends_on', 'responds_to', 'supersedes', 'evidences', 'owns',
               'is_waiting_on', 'updates', 'gathers_from')),
  created_by text NOT NULL CHECK (created_by <> ''),
  created_at timestamptz NOT NULL,
  -- {kind: communication | gather | ledger_event, id} or null.
  evidence   jsonb CHECK (evidence IS NULL OR (
               evidence ->> 'kind' IN ('communication', 'gather', 'ledger_event')
               AND evidence ->> 'id' ~ '^lc_[A-Za-z0-9][A-Za-z0-9_-]*$')),
  status     text NOT NULL CHECK (status IN ('active', 'superseded', 'retracted'))
);

CREATE INDEX edges_from ON edges (from_id) WHERE status = 'active';
CREATE INDEX edges_to ON edges (to_id) WHERE status = 'active';

-- ---- B2.3 Loop -------------------------------------------------------------

-- The recorded state machine: every allowed loop state change, and the
-- operation that makes it. Reference data, read-only to the app.
CREATE TABLE loop_state_transitions (
  from_state text NOT NULL,
  to_state   text NOT NULL,
  via        text NOT NULL CHECK (via IN ('accept_loop', 'reject_loop', 'transition')),
  PRIMARY KEY (from_state, to_state)
);

INSERT INTO loop_state_transitions (from_state, to_state, via) VALUES
  ('proposed', 'open',               'accept_loop'),
  ('proposed', 'closed_with_reason', 'reject_loop'),
  ('open',     'waiting',            'transition'),
  ('open',     'chased',             'transition'),
  ('open',     'closed',             'transition'),
  ('open',     'closed_with_reason', 'transition'),
  ('waiting',  'open',               'transition'),
  ('waiting',  'chased',             'transition'),
  ('waiting',  'closed',             'transition'),
  ('waiting',  'closed_with_reason', 'transition'),
  ('chased',   'open',               'transition'),
  ('chased',   'waiting',            'transition'),
  ('chased',   'closed',             'transition'),
  ('chased',   'closed_with_reason', 'transition');
-- closed and closed_with_reason are terminal.

CREATE TABLE loops (
  id                        text PRIMARY KEY CHECK (id ~ '^lc_[A-Za-z0-9][A-Za-z0-9_-]*$'),
  name                      text NOT NULL CHECK (name <> ''),
  loop_type                 text NOT NULL CHECK (loop_type ~ '^[a-z][a-z0-9-]*$'),
  state                     text NOT NULL CHECK (state IN (
                              'proposed', 'open', 'waiting', 'chased', 'closed', 'closed_with_reason')),
  accountable_who_id        text NOT NULL REFERENCES nodes (id),
  closing_when_id           text REFERENCES nodes (id),
  authority                 text NOT NULL CHECK (authority IN (
                              'autonomous', 'joe-approves-each', 'joe-approves-template')),
  opened_at                 timestamptz,
  closed_at                 timestamptz,
  close_reason              text CHECK (close_reason IN (
                              'abandoned', 'superseded', 'no-longer-applies', 'rejected')),
  ageing_policy_id          text NOT NULL,
  ageing_policy_version     integer NOT NULL CHECK (ageing_policy_version >= 1),
  escalation_policy_id      text NOT NULL,
  escalation_policy_version integer NOT NULL CHECK (escalation_policy_version >= 1),
  -- Field consistency per contracts/schemas/v1/loop.schema.json.
  CONSTRAINT loops_closed_fields CHECK (
    CASE state
      WHEN 'closed'             THEN closed_at IS NOT NULL AND close_reason IS NULL
      WHEN 'closed_with_reason' THEN closed_at IS NOT NULL AND close_reason IS NOT NULL
      ELSE closed_at IS NULL AND close_reason IS NULL
    END),
  CONSTRAINT loops_proposed_unopened CHECK (state <> 'proposed' OR opened_at IS NULL)
);

CREATE INDEX loops_not_closed ON loops (state) WHERE state NOT IN ('closed', 'closed_with_reason');

-- member_node_ids: the loop's subgraph.
CREATE TABLE loop_members (
  loop_id text NOT NULL REFERENCES loops (id),
  node_id text NOT NULL REFERENCES nodes (id),
  PRIMARY KEY (loop_id, node_id)
);

CREATE INDEX loop_members_node ON loop_members (node_id);

-- Loops are born proposed (intake), and change state only along the recorded
-- state machine.
CREATE FUNCTION loops_enforce_state_machine() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  how text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'proposed' THEN
      RAISE EXCEPTION 'loop % must be created in state proposed, not %', NEW.id, NEW.state
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.state IS NOT DISTINCT FROM OLD.state THEN
    RETURN NEW;
  END IF;

  -- Schema-qualified: an unqualified name would resolve through the caller's
  -- search_path, where pg_temp comes first, letting the app role shadow the
  -- recorded state machine with a temporary table.
  SELECT via INTO how FROM public.loop_state_transitions
   WHERE from_state = OLD.state AND to_state = NEW.state;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid loop transition % -> % for loop %', OLD.state, NEW.state, OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF how = 'reject_loop' AND NEW.close_reason IS DISTINCT FROM 'rejected' THEN
    RAISE EXCEPTION 'reject_loop must close with reason rejected (loop %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF how <> 'reject_loop' AND NEW.close_reason = 'rejected' THEN
    RAISE EXCEPTION 'close reason rejected is only for reject_loop at intake (loop %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER loops_state_machine
  BEFORE INSERT OR UPDATE OF state ON loops
  FOR EACH ROW EXECUTE FUNCTION loops_enforce_state_machine();

-- ---- B2.4 Event ledger — append-only ---------------------------------------

CREATE TABLE ledger_events (
  -- Append order; a successor replays the ledger in this order (SPEC B5).
  seq             bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  id              text PRIMARY KEY CHECK (id ~ '^lc_[A-Za-z0-9][A-Za-z0-9_-]*$'),
  at              timestamptz NOT NULL,
  actor           text NOT NULL CHECK (actor <> ''),
  event_type      text NOT NULL CHECK (event_type IN (
                    'loop_proposed', 'loop_accepted', 'loop_rejected', 'transition', 'when_fired',
                    'communication_sent', 'communication_received', 'gather_performed', 'supersession',
                    'merge', 'split', 'manual_correction', 'tombstone')),
  subject_ids     text[] NOT NULL CHECK (cardinality(subject_ids) >= 1),
  payload         jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(payload) = 'object'),
  -- Unique: the same external event delivered twice applies once.
  idempotency_key text UNIQUE CHECK (idempotency_key <> '')
);

CREATE INDEX ledger_events_subjects ON ledger_events USING gin (subject_ids);

-- ---- B2.5 Communication ----------------------------------------------------

CREATE TABLE communications (
  id                   text PRIMARY KEY CHECK (id ~ '^lc_[A-Za-z0-9][A-Za-z0-9_-]*$'),
  thread_id            text NOT NULL CHECK (thread_id <> ''),
  channel              text NOT NULL CHECK (channel IN ('email', 'message', 'other')),
  direction            text NOT NULL CHECK (direction IN ('outbound', 'inbound')),
  participant_who_ids  text[] NOT NULL CHECK (cardinality(participant_who_ids) >= 1),
  at                   timestamptz NOT NULL,
  body_pointer         text NOT NULL CHECK (body_pointer <> ''),
  body_hash            text NOT NULL CHECK (body_hash ~ '^sha256:[0-9a-f]{64}$'),
  loop_id              text NOT NULL REFERENCES loops (id),
  sent_under_authority text CHECK (sent_under_authority IN (
                         'autonomous', 'joe-approves-each', 'joe-approves-template')),
  CONSTRAINT communications_inbound_no_authority CHECK (direction = 'outbound' OR sent_under_authority IS NULL)
);

CREATE INDEX communications_loop ON communications (loop_id);

-- ---- Transactional outbox (TECH-STACK §6) ----------------------------------
-- Side effects (workflow runs, send requests) are written in the same
-- transaction as the state change, citing its ledger event, and drained by
-- the worker: claim with FOR UPDATE SKIP LOCKED, then set delivered_at.
-- Delivery is at-least-once; consumers are idempotent on (id).

CREATE TABLE outbox (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ledger_event_id text NOT NULL REFERENCES ledger_events (id),
  topic           text NOT NULL CHECK (topic <> ''),
  payload         jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(payload) = 'object'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  available_at    timestamptz NOT NULL DEFAULT now(),
  attempts        integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error      text,
  delivered_at    timestamptz
);

CREATE INDEX outbox_pending ON outbox (available_at, id) WHERE delivered_at IS NULL;

-- ---- App role grants -------------------------------------------------------
-- The ledger is append-only for the app: SELECT + INSERT, never UPDATE,
-- DELETE or TRUNCATE (SPEC B2.4; TECH-STACK §2).

GRANT USAGE ON SCHEMA public TO loopcloser_app;
GRANT SELECT, INSERT, UPDATE ON nodes, edges, loops, communications TO loopcloser_app;
GRANT SELECT, INSERT, DELETE ON loop_members TO loopcloser_app;
GRANT SELECT, INSERT ON ledger_events TO loopcloser_app;
GRANT SELECT, INSERT, UPDATE ON outbox TO loopcloser_app;
GRANT SELECT ON loop_state_transitions, schema_migrations TO loopcloser_app;

INSERT INTO schema_migrations (version, name) VALUES ('0001', 'loop_model');

COMMIT;
