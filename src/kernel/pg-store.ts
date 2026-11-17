// Postgres GraphStore (TECH-STACK §2/§4) over the db/migrations 0001-0003
// schema, through node-postgres (docs/decisions/postgres-client.md).
//
// Every transaction() runs on one pooled connection between BEGIN and COMMIT;
// a throw, or any GraphTx call that rejects, rolls the whole of it back.
// Write transactions run SERIALIZABLE: a decision taken on a row that is not
// there (a new node id, no duplicate loop, an unused idempotency key) is
// protected like one taken on a row that is, so two stores racing the same
// proposal cannot both admit it. Rows a write transaction reads are also
// taken with FOR UPDATE, so a second store instance working on the same loop
// waits for the first instead of computing a doomed result. Ledger appends
// take the ledger ordering lock (src/db/ledger-order.ts), shared with every
// other ledger writer, so ledger_events.seq order is commit order and
// ledgerAfter positions are stable. A deadlock or serialisation failure
// re-runs the transaction from the start.
//
// read() runs REPEATABLE READ READ ONLY: one snapshot, no locks, and every
// write call is rejected before it reaches the database.
import type pg from "pg";
import { LEDGER_APPEND_LOCK } from "../db/ledger-order.ts";
import type { GraphStore, GraphTx } from "./store.ts";
import type { Communication, Edge, LedgerEvent, Loop, Node, OutboxEntry, SendRequest } from "./types.ts";

/** serialization_failure, deadlock_detected: the transaction is safe to re-run from the start. */
const RETRYABLE = new Set(["40001", "40P01"]);
const UNIQUE_VIOLATION = "23505";
const LEDGER_IDEMPOTENCY_CONSTRAINT = "ledger_events_idempotency_key_key";

export interface PgGraphStoreOptions {
  /** Attempts per transaction when Postgres reports a deadlock or serialisation failure. Default 10. */
  readonly maxAttempts?: number;
}

export class PgGraphStore implements GraphStore {
  readonly #pool: pg.Pool;
  readonly #maxAttempts: number;

  /** `pool` is owned by the caller, who ends it; its connections act as the app role. */
  constructor(pool: pg.Pool, opts: PgGraphStoreOptions = {}) {
    this.#pool = pool;
    this.#maxAttempts = Math.max(1, opts.maxAttempts ?? 10);
  }

  transaction<T>(fn: (tx: GraphTx) => T | Promise<T>): Promise<T> {
    return this.#run(fn, true);
  }

  read<T>(fn: (tx: GraphTx) => T | Promise<T>): Promise<T> {
    return this.#run(fn, false);
  }

  async #run<T>(fn: (tx: GraphTx) => T | Promise<T>, writable: boolean): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.#once(fn, writable);
      } catch (err) {
        if (attempt >= this.#maxAttempts || !RETRYABLE.has((err as { code?: string }).code ?? "")) throw err;
      }
    }
  }

  async #once<T>(fn: (tx: GraphTx) => T | Promise<T>, writable: boolean): Promise<T> {
    const client = await this.#pool.connect();
    let broken = false;
    const view = pgTx(client, writable);
    try {
      await client.query(writable ? "BEGIN ISOLATION LEVEL SERIALIZABLE" : "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      try {
        const result = await fn(view.tx);
        view.close();
        // A rejected call aborted the transaction; COMMIT would silently roll back.
        if (view.failure() !== undefined) throw view.failure();
        await client.query("COMMIT");
        return result;
      } catch (err) {
        view.close();
        await client.query("ROLLBACK").catch(() => {
          broken = true;
        });
        throw err;
      }
    } finally {
      // A connection whose rollback failed is in an unknown state: destroy it rather than reuse it.
      client.release(broken);
    }
  }
}

// ---- row mapping -----------------------------------------------------------

function iso(value: unknown): string {
  return (value instanceof Date ? value : new Date(String(value))).toISOString();
}

function isoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

const NODE_COLUMNS = "id, kind, created_at, status, attributes";
function node(r: Record<string, any>): Node {
  return { id: r.id, kind: r.kind, created_at: iso(r.created_at), status: r.status, attributes: r.attributes };
}

const EDGE_COLUMNS = "id, from_id, to_id, edge_type, created_by, created_at, evidence, status";
function edge(r: Record<string, any>): Edge {
  return {
    id: r.id,
    from_id: r.from_id,
    to_id: r.to_id,
    edge_type: r.edge_type,
    created_by: r.created_by,
    created_at: iso(r.created_at),
    evidence: r.evidence ?? null,
    status: r.status,
  };
}

/** member_node_ids come back sorted: loop_members has no position column. */
const LOOP_SELECT = `
  SELECT l.id, l.name, l.loop_type, l.state, l.accountable_who_id, l.closing_when_id, l.authority,
         l.opened_at, l.closed_at, l.close_reason, l.ageing_policy_id, l.ageing_policy_version,
         l.escalation_policy_id, l.escalation_policy_version, l.key_result_ref,
         COALESCE((SELECT array_agg(m.node_id ORDER BY m.node_id) FROM public.loop_members m WHERE m.loop_id = l.id),
                  '{}') AS member_node_ids
    FROM public.loops l`;
function loop(r: Record<string, any>): Loop {
  const out: Loop = {
    id: r.id,
    name: r.name,
    loop_type: r.loop_type,
    state: r.state,
    accountable_who_id: r.accountable_who_id,
    member_node_ids: r.member_node_ids,
    closing_when_id: r.closing_when_id,
    authority: r.authority,
    opened_at: isoOrNull(r.opened_at),
    closed_at: isoOrNull(r.closed_at),
    close_reason: r.close_reason,
    policy_refs: {
      ageing: { id: r.ageing_policy_id, version: r.ageing_policy_version },
      escalation: { id: r.escalation_policy_id, version: r.escalation_policy_version },
    },
  };
  if (r.key_result_ref !== null) out.key_result_ref = { system: r.key_result_ref.system, id: r.key_result_ref.id };
  return out;
}

const EVENT_COLUMNS = "id, at, actor, event_type, subject_ids, payload, idempotency_key";
function event(r: Record<string, any>): LedgerEvent {
  return {
    id: r.id,
    at: iso(r.at),
    actor: r.actor,
    event_type: r.event_type,
    subject_ids: r.subject_ids,
    payload: r.payload,
    idempotency_key: r.idempotency_key,
  };
}

const COMMUNICATION_COLUMNS =
  "id, thread_id, channel, direction, participant_who_ids, at, body_pointer, body_hash, loop_id, sent_under_authority";
function communication(r: Record<string, any>): Communication {
  return {
    id: r.id,
    thread_id: r.thread_id,
    channel: r.channel,
    direction: r.direction,
    participant_who_ids: r.participant_who_ids,
    at: iso(r.at),
    body_pointer: r.body_pointer,
    body_hash: r.body_hash,
    loop_id: r.loop_id,
    sent_under_authority: r.sent_under_authority,
  };
}

const SEND_REQUEST_COLUMNS = "communication_id, loop_id, authority, status, requested_by, requested_at, refused_receiver_ids";
function sendRequest(r: Record<string, any>): SendRequest {
  const out: SendRequest = {
    communication_id: r.communication_id,
    loop_id: r.loop_id,
    authority: r.authority,
    status: r.status,
    requested_by: r.requested_by,
    requested_at: iso(r.requested_at),
  };
  if (r.refused_receiver_ids !== null) out.refused_receiver_ids = r.refused_receiver_ids;
  return out;
}

const json = (v: unknown): string | null => (v === null || v === undefined ? null : JSON.stringify(v));

// ---- GraphTx ---------------------------------------------------------------

function pgTx(client: pg.PoolClient, writable: boolean): { tx: GraphTx; close: () => void; failure: () => unknown } {
  let open = true;
  let failure: unknown;
  let ledgerLocked = false;
  /** Rows read in a write transaction are locked until it ends. */
  const lock = writable ? " FOR UPDATE" : "";

  const query = async (text: string, values: unknown[] = []): Promise<Record<string, any>[]> => {
    if (!open) throw new Error("transaction is already over");
    try {
      return (await client.query(text, values)).rows;
    } catch (err) {
      failure ??= err;
      throw err;
    }
  };
  const write = (): void => {
    if (!open) throw new Error("transaction is already over");
    if (!writable) throw new Error("write attempted in a read-only view");
  };

  const tx: GraphTx = {
    async getNode(id) {
      const rows = await query(`SELECT ${NODE_COLUMNS} FROM public.nodes WHERE id = $1${lock}`, [id]);
      return rows[0] && node(rows[0]);
    },
    async putNode(n) {
      write();
      await query(
        `INSERT INTO public.nodes (id, kind, created_at, status, attributes) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE
           SET kind = EXCLUDED.kind, created_at = EXCLUDED.created_at, status = EXCLUDED.status, attributes = EXCLUDED.attributes`,
        [n.id, n.kind, n.created_at, n.status, json(n.attributes)],
      );
    },
    async listNodes() {
      return (await query(`SELECT ${NODE_COLUMNS} FROM public.nodes ORDER BY id${lock}`)).map(node);
    },
    async getEdge(id) {
      const rows = await query(`SELECT ${EDGE_COLUMNS} FROM public.edges WHERE id = $1${lock}`, [id]);
      return rows[0] && edge(rows[0]);
    },
    async putEdge(e) {
      write();
      await query(
        `INSERT INTO public.edges (id, from_id, to_id, edge_type, created_by, created_at, evidence, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO UPDATE
           SET from_id = EXCLUDED.from_id, to_id = EXCLUDED.to_id, edge_type = EXCLUDED.edge_type,
               created_by = EXCLUDED.created_by, created_at = EXCLUDED.created_at,
               evidence = EXCLUDED.evidence, status = EXCLUDED.status`,
        [e.id, e.from_id, e.to_id, e.edge_type, e.created_by, e.created_at, json(e.evidence), e.status],
      );
    },
    async edgesTouching(nodeId) {
      const rows = await query(
        `SELECT ${EDGE_COLUMNS} FROM public.edges
          WHERE status = 'active' AND (from_id = $1 OR to_id = $1) ORDER BY id`,
        [nodeId],
      );
      return rows.map(edge);
    },
    async getLoop(id) {
      const rows = await query(`${LOOP_SELECT} WHERE l.id = $1${writable ? " FOR UPDATE OF l" : ""}`, [id]);
      return rows[0] && loop(rows[0]);
    },
    async putLoop(l) {
      write();
      const values = [
        l.id, l.name, l.loop_type, l.state, l.accountable_who_id, l.closing_when_id, l.authority,
        l.opened_at, l.closed_at, l.close_reason,
        l.policy_refs.ageing.id, l.policy_refs.ageing.version,
        l.policy_refs.escalation.id, l.policy_refs.escalation.version,
        json(l.key_result_ref),
      ];
      // UPDATE first: an INSERT … ON CONFLICT fires the BEFORE INSERT trigger,
      // which admits only state proposed, even when the row then updates.
      const updated = await query(
        `UPDATE public.loops
            SET name = $2, loop_type = $3, state = $4, accountable_who_id = $5, closing_when_id = $6, authority = $7,
                opened_at = $8, closed_at = $9, close_reason = $10, ageing_policy_id = $11, ageing_policy_version = $12,
                escalation_policy_id = $13, escalation_policy_version = $14, key_result_ref = $15
          WHERE id = $1
         RETURNING id`,
        values,
      );
      if (updated.length === 0)
        await query(
          `INSERT INTO public.loops (id, name, loop_type, state, accountable_who_id, closing_when_id, authority,
                                     opened_at, closed_at, close_reason, ageing_policy_id, ageing_policy_version,
                                     escalation_policy_id, escalation_policy_version, key_result_ref)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
          values,
        );
      await query(`DELETE FROM public.loop_members WHERE loop_id = $1 AND NOT (node_id = ANY ($2::text[]))`, [
        l.id,
        l.member_node_ids,
      ]);
      await query(
        `INSERT INTO public.loop_members (loop_id, node_id)
         SELECT $1, m FROM unnest($2::text[]) AS m ON CONFLICT DO NOTHING`,
        [l.id, l.member_node_ids],
      );
    },
    async listLoops() {
      return (await query(`${LOOP_SELECT} ORDER BY l.id${writable ? " FOR UPDATE OF l" : ""}`)).map(loop);
    },
    async appendEvent(e) {
      write();
      if (!ledgerLocked) {
        await query(LEDGER_APPEND_LOCK);
        ledgerLocked = true;
      }
      try {
        await query(
          `INSERT INTO public.ledger_events (id, at, actor, event_type, subject_ids, payload, idempotency_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [e.id, e.at, e.actor, e.event_type, e.subject_ids, json(e.payload), e.idempotency_key],
        );
      } catch (err) {
        const pgErr = err as { code?: string; constraint?: string };
        if (pgErr.code === UNIQUE_VIOLATION && pgErr.constraint === LEDGER_IDEMPOTENCY_CONSTRAINT)
          throw new Error(`idempotency key ${e.idempotency_key} already in the ledger`, { cause: err });
        throw err;
      }
    },
    async findEventByIdempotencyKey(key) {
      const rows = await query(`SELECT ${EVENT_COLUMNS} FROM public.ledger_events WHERE idempotency_key = $1`, [key]);
      return rows[0] && event(rows[0]);
    },
    async ledger() {
      return (await query(`SELECT ${EVENT_COLUMNS} FROM public.ledger_events ORDER BY seq`)).map(event);
    },
    async ledgerAfter(position, limit) {
      if (!Number.isSafeInteger(position) || position < 0) return undefined;
      // One statement, one snapshot: the count and the page agree.
      const rows = await query(
        `SELECT (SELECT count(*) FROM public.ledger_events)::bigint AS total,
                COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.seq)
                            FROM (SELECT seq, ${EVENT_COLUMNS} FROM public.ledger_events
                                   ORDER BY seq OFFSET $1 LIMIT $2) p), '[]'::jsonb) AS events`,
        [position, Math.max(0, Math.trunc(limit))],
      );
      const r = rows[0]!;
      if (position > Number(r.total)) return undefined;
      const events = (r.events as Record<string, any>[]).map(event);
      return { events, position: position + events.length };
    },
    async getCommunication(id) {
      const rows = await query(`SELECT ${COMMUNICATION_COLUMNS} FROM public.communications WHERE id = $1${lock}`, [id]);
      return rows[0] && communication(rows[0]);
    },
    async putCommunication(c) {
      write();
      await query(
        `INSERT INTO public.communications (id, thread_id, channel, direction, participant_who_ids, at,
                                            body_pointer, body_hash, loop_id, sent_under_authority)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (id) DO UPDATE
           SET thread_id = EXCLUDED.thread_id, channel = EXCLUDED.channel, direction = EXCLUDED.direction,
               participant_who_ids = EXCLUDED.participant_who_ids, at = EXCLUDED.at,
               body_pointer = EXCLUDED.body_pointer, body_hash = EXCLUDED.body_hash,
               loop_id = EXCLUDED.loop_id, sent_under_authority = EXCLUDED.sent_under_authority`,
        [c.id, c.thread_id, c.channel, c.direction, c.participant_who_ids, c.at, c.body_pointer, c.body_hash, c.loop_id, c.sent_under_authority],
      );
    },
    async getSendRequest(communicationId) {
      const rows = await query(
        `SELECT ${SEND_REQUEST_COLUMNS} FROM public.send_requests WHERE communication_id = $1${lock}`,
        [communicationId],
      );
      return rows[0] && sendRequest(rows[0]);
    },
    async putSendRequest(s) {
      write();
      await query(
        `INSERT INTO public.send_requests (communication_id, loop_id, authority, status, requested_by, requested_at,
                                           refused_receiver_ids)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (communication_id) DO UPDATE
           SET loop_id = EXCLUDED.loop_id, authority = EXCLUDED.authority, status = EXCLUDED.status,
               requested_by = EXCLUDED.requested_by, requested_at = EXCLUDED.requested_at,
               refused_receiver_ids = EXCLUDED.refused_receiver_ids`,
        [s.communication_id, s.loop_id, s.authority, s.status, s.requested_by, s.requested_at, s.refused_receiver_ids ?? null],
      );
    },
    async enqueue(entry) {
      write();
      await query(
        `INSERT INTO public.outbox (ledger_event_id, topic, payload, created_at, available_at)
         VALUES ($1, $2, $3, $4, $4)`,
        [entry.ledger_event_id, entry.topic, json(entry.payload), entry.created_at],
      );
    },
    async outbox() {
      const rows = await query(`SELECT ledger_event_id, topic, payload, created_at FROM public.outbox ORDER BY id`);
      return rows.map((r): OutboxEntry => ({ ledger_event_id: r.ledger_event_id, topic: r.topic, payload: r.payload, created_at: iso(r.created_at) }));
    },
  };

  return {
    tx,
    close: () => void (open = false),
    failure: () => failure,
  };
}
