// Postgres TimerStore (TECH-STACK §6) over the db/migrations schema.
//
// Each transaction runs on one pooled connection between BEGIN and COMMIT;
// any error rolls the whole thing back, so claiming, ledger appends and
// next_fire_at advances commit together or not at all. Due calendar Whens are
// claimed with FOR UPDATE SKIP LOCKED, so overlapping ticks never fire the
// same When, and the ledger's unique idempotency key rejects a double firing.
import pg from "pg";
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
import { LEDGER_APPEND_LOCK } from "../db/ledger-order.ts";

const UNIQUE_VIOLATION = "23505";
const LEDGER_IDEMPOTENCY_CONSTRAINT = "ledger_events_idempotency_key_key";

export interface PgTimerStoreOptions {
  readonly connectionString: string;
  /** Give up connecting after this long (the tick Job has a 55 s deadline). */
  readonly connectionTimeoutMillis?: number;
}

export class PgTimerStore implements TimerStore {
  readonly #pool: pg.Pool;

  constructor(opts: PgTimerStoreOptions) {
    this.#pool = new pg.Pool({
      connectionString: opts.connectionString,
      connectionTimeoutMillis: opts.connectionTimeoutMillis ?? 10_000,
      max: 2,
    });
    // An idle client losing its connection must not crash the process.
    this.#pool.on("error", () => undefined);
  }

  async transaction<T>(fn: (tx: TimerTx) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    let broken: Error | undefined;
    try {
      await client.query("BEGIN");
      try {
        const result = await fn(pgTx(client));
        await client.query("COMMIT");
        return result;
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackErr) {
          broken = rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr));
        }
        throw err;
      }
    } finally {
      // A connection whose rollback failed is discarded, not returned to the pool.
      client.release(broken);
    }
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}

function pgTx(client: pg.PoolClient): TimerTx {
  return {
    async claimDueCalendarWhens(now) {
      const { rows } = await client.query<{ id: string; schedule: unknown; timezone: unknown; next_fire_at: string }>(
        `SELECT id,
                attributes -> 'schedule'      AS schedule,
                attributes -> 'timezone'      AS timezone,
                attributes ->> 'next_fire_at' AS next_fire_at
           FROM nodes
          WHERE kind = 'when'
            AND status = 'active'
            AND attributes ->> 'when_type' = 'calendar'
            AND jsonb_typeof(attributes -> 'next_fire_at') = 'string'
            AND (attributes ->> 'next_fire_at')::timestamptz <= $1
          ORDER BY (attributes ->> 'next_fire_at')::timestamptz, id
            FOR UPDATE SKIP LOCKED`,
        [now.toISOString()],
      );
      return rows.map((r): DueCalendarWhen => ({ id: r.id, schedule: r.schedule, timezone: r.timezone, next_fire_at: r.next_fire_at }));
    },

    async appendLedgerEvent(event: LedgerEvent) {
      // Ledger ordering protocol (src/db/ledger-order.ts): held until this transaction ends.
      await client.query(LEDGER_APPEND_LOCK);
      try {
        await client.query(
          `INSERT INTO ledger_events (id, at, actor, event_type, subject_ids, payload, idempotency_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [event.id, event.at, event.actor, event.event_type, event.subject_ids, event.payload, event.idempotency_key],
        );
      } catch (err) {
        const e = err as { code?: string; constraint?: string };
        if (e.code === UNIQUE_VIOLATION && e.constraint === LEDGER_IDEMPOTENCY_CONSTRAINT) {
          throw new DuplicateIdempotencyKeyError(`idempotency key ${event.idempotency_key} already recorded`);
        }
        throw err;
      }
    },

    async setNextFireAt(whenId, nextFireAt, schedule) {
      const patch: Record<string, unknown> = { next_fire_at: nextFireAt };
      if (schedule !== undefined) patch["schedule"] = schedule;
      const { rowCount } = await client.query(`UPDATE nodes SET attributes = attributes || $2::jsonb WHERE id = $1`, [
        whenId,
        JSON.stringify(patch),
      ]);
      if (rowCount !== 1) throw new Error(`no When ${whenId}`);
    },

    async listOpenLoopsForAgeing() {
      // The time a loop entered its state is its latest state-changing ledger
      // event (falling back to opened_at, then now when no event cites it).
      const { rows } = await client.query<{
        id: string;
        loop_type: string;
        state: LoopState;
        state_entered_at: Date;
        ageing_policy_id: string;
        ageing_policy_version: number;
      }>(
        `SELECT l.id, l.loop_type, l.state, l.ageing_policy_id, l.ageing_policy_version,
                COALESCE((SELECT max(e.at) FROM ledger_events e
                           WHERE l.id = ANY (e.subject_ids)
                             AND e.event_type IN ('loop_proposed', 'loop_accepted', 'loop_rejected', 'transition')),
                         l.opened_at, now()) AS state_entered_at
           FROM loops l
          WHERE l.state NOT IN ('closed', 'closed_with_reason')
          ORDER BY l.id`,
      );
      return rows.map((r) => {
        const loop: LoopAgeingRow = {
          id: r.id,
          loop_type: r.loop_type,
          state: r.state,
          state_entered_at: r.state_entered_at.toISOString(),
          ageing_policy: { id: r.ageing_policy_id, version: r.ageing_policy_version },
        };
        // db/migrations has no ageing-policy store yet (SPEC B4 policies are not
        // persisted), so no cited version resolves and nothing breaches.
        const policy: AgeingPolicy | null = null;
        return { loop, policy };
      });
    },
  };
}
