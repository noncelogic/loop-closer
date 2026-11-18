// Postgres TimerStore (TECH-STACK §6) on the loopcloser schema
// (db/migrations/0001_loop_model.sql).
//
// Each transaction checks out one connection from the pool, runs BEGIN … COMMIT
// on it, and rolls back if the callback throws. Due calendar Whens are claimed
// with `FOR UPDATE OF n SKIP LOCKED`, so a tick that overlaps another never sees a
// When the other holds; once that tick commits, the When's next_fire_at has
// moved past now and it is no longer due. The ledger's unique idempotency key
// backs this up: a firing can never be recorded twice. Ledger events go
// through the shared commit-ordered append (src/db/ledger.ts).
import type pg from "pg";
import { appendLedgerEvent } from "../db/ledger.ts";
import {
  DuplicateIdempotencyKeyError,
  type AgeingPolicy,
  type DueCalendarWhen,
  type LedgerEvent,
  type LoopAgeingRow,
  type LoopState,
  type TimerStore,
  type TimerTx,
} from "./store.ts";

/** Ledger events that move a loop into a new state; the latest one's `at` is when it entered its current state. */
const STATE_EVENTS = ["loop_proposed", "loop_accepted", "loop_rejected", "transition"] as const;

export interface PgTimerStoreOptions {
  /**
   * Ageing policies by ID+version. The schema has no policy table yet, so they
   * are supplied by the caller; a loop citing a version not listed here gets a
   * null policy and never breaches.
   */
  readonly ageingPolicies?: readonly AgeingPolicy[];
}

export class PgTimerStore implements TimerStore {
  readonly #pool: pg.Pool;
  readonly #ageingPolicies: readonly AgeingPolicy[];

  constructor(pool: pg.Pool, opts: PgTimerStoreOptions = {}) {
    this.#pool = pool;
    this.#ageingPolicies = opts.ageingPolicies ?? [];
  }

  async transaction<T>(fn: (tx: TimerTx) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    let broken: unknown;
    try {
      await client.query("BEGIN");
      try {
        const result = await fn(pgTx(client, this.#ageingPolicies));
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK").catch((rollbackErr: unknown) => {
          broken = rollbackErr;
        });
        throw err;
      }
    } finally {
      // A connection whose rollback failed is in an unknown state: destroy it rather than reuse it.
      client.release(broken !== undefined);
    }
  }
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function pgTx(client: pg.PoolClient, ageingPolicies: readonly AgeingPolicy[]): TimerTx {
  return {
    async claimDueCalendarWhens(now) {
      const res = await client.query<{ id: string; schedule: unknown; timezone: unknown; next_fire_at: string }>(
        `SELECT id,
                attributes -> 'schedule'      AS schedule,
                attributes -> 'timezone'      AS timezone,
                attributes ->> 'next_fire_at' AS next_fire_at
           FROM public.nodes n
          WHERE kind = 'when'
            AND status = 'active'
            AND attributes ->> 'when_type' = 'calendar'
            AND jsonb_typeof(attributes -> 'next_fire_at') = 'string'
            AND (attributes ->> 'next_fire_at')::timestamptz <= $1
            -- Held: governed by a suspended loop and by no armed loop (LC-CP-SUSPEND).
            AND NOT (
              EXISTS (SELECT 1 FROM public.loops l
                       WHERE l.state = 'suspended'
                         AND (l.closing_when_id = n.id
                              OR EXISTS (SELECT 1 FROM public.loop_members m WHERE m.loop_id = l.id AND m.node_id = n.id)))
              AND NOT EXISTS (SELECT 1 FROM public.loops l
                               WHERE l.state IN ('open', 'waiting', 'chased')
                                 AND (l.closing_when_id = n.id
                                      OR EXISTS (SELECT 1 FROM public.loop_members m WHERE m.loop_id = l.id AND m.node_id = n.id))))
          ORDER BY (attributes ->> 'next_fire_at')::timestamptz, id
          FOR UPDATE OF n SKIP LOCKED`,
        [now],
      );
      return res.rows.map((r): DueCalendarWhen => ({
        id: r.id,
        schedule: r.schedule,
        timezone: r.timezone,
        next_fire_at: r.next_fire_at,
      }));
    },

    async appendLedgerEvent(event: LedgerEvent) {
      await client.query("SAVEPOINT lc_append");
      try {
        await appendLedgerEvent(
          client,
          event,
          (e, cause) => new DuplicateIdempotencyKeyError(`idempotency key ${e.idempotency_key} already recorded`, { cause }),
        );
        await client.query("RELEASE SAVEPOINT lc_append");
      } catch (err) {
        await client.query("ROLLBACK TO SAVEPOINT lc_append");
        throw err;
      }
    },

    async setNextFireAt(whenId, nextFireAt, schedule) {
      const res = await client.query(
        `UPDATE public.nodes
            SET attributes = CASE WHEN $3::jsonb IS NULL
                                  THEN jsonb_set(attributes, '{next_fire_at}', COALESCE(to_jsonb($2::text), 'null'::jsonb))
                                  ELSE jsonb_set(jsonb_set(attributes, '{next_fire_at}', COALESCE(to_jsonb($2::text), 'null'::jsonb)), '{schedule}', $3::jsonb)
                             END
          WHERE id = $1 AND kind = 'when'`,
        [whenId, nextFireAt, schedule === undefined ? null : JSON.stringify(schedule)],
      );
      if (res.rowCount !== 1) throw new Error(`no When ${whenId}`);
    },

    async listOpenLoopsForAgeing() {
      const res = await client.query<{
        id: string;
        loop_type: string;
        state: LoopState;
        state_entered_at: Date | null;
        ageing_policy_id: string;
        ageing_policy_version: number;
      }>(
        `SELECT l.id, l.loop_type, l.state, l.ageing_policy_id, l.ageing_policy_version,
                (SELECT e.at FROM public.ledger_events e
                  WHERE e.subject_ids[1] = l.id AND e.event_type = ANY($1::text[])
                  ORDER BY e.seq DESC LIMIT 1) AS state_entered_at
           FROM public.loops l
          WHERE l.state NOT IN ('closed', 'closed_with_reason')
          ORDER BY l.id`,
        [STATE_EVENTS],
      );
      return res.rows
        .filter((r) => r.state_entered_at !== null)
        .map((r) => {
          const loop: LoopAgeingRow = {
            id: r.id,
            loop_type: r.loop_type,
            state: r.state,
            state_entered_at: iso(r.state_entered_at),
            ageing_policy: { id: r.ageing_policy_id, version: r.ageing_policy_version },
          };
          const policy = ageingPolicies.find((p) => p.id === r.ageing_policy_id && p.version === r.ageing_policy_version);
          return { loop, policy: policy ? structuredClone(policy) : null };
        });
    },
  };
}
