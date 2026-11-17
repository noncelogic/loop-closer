// The one commit-ordered ledger append (SPEC B2.4/B5) every Postgres ledger
// writer goes through: the graph store and both timer stores.
//
// ledger_events.seq comes from an identity, which hands out numbers when a row
// is inserted, not when its transaction commits. Two writers that overlap could
// commit in the other order: a reader paging by seq that already went past the
// later number would never see the earlier one. Taking one transaction-scoped
// advisory lock before every insert means a writer that appends holds the lock
// until it commits or rolls back. Each seq is then handed out only after every
// lower seq has committed or rolled back, so a page never skips or repeats a
// committed event.
// The lock itself is the ledger ordering protocol in src/db/ledger-order.ts.
import type pg from "pg";
import { LEDGER_APPEND_LOCK } from "./ledger-order.ts";

const UNIQUE_VIOLATION = "23505";
const LEDGER_IDEMPOTENCY_CONSTRAINT = "ledger_events_idempotency_key_key";

export interface LedgerEventRow {
  readonly id: string;
  readonly at: string;
  readonly actor: string;
  readonly event_type: string;
  readonly subject_ids: readonly string[];
  readonly payload: Record<string, unknown>;
  readonly idempotency_key: string | null;
}

/** Something that can run a query inside an open transaction (a checked-out pool client). */
export interface LedgerClient {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

/**
 * Appends one event inside the caller's open transaction, after taking the
 * ledger append lock (held until that transaction ends). A duplicate
 * idempotency key throws `onDuplicateKey(...)` if given, else the Postgres error.
 */
export async function appendLedgerEvent(
  client: LedgerClient | pg.ClientBase,
  event: LedgerEventRow,
  onDuplicateKey?: (event: LedgerEventRow, cause: unknown) => Error,
): Promise<void> {
  await client.query(LEDGER_APPEND_LOCK);
  try {
    await client.query(
      `INSERT INTO public.ledger_events (id, at, actor, event_type, subject_ids, payload, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [event.id, event.at, event.actor, event.event_type, event.subject_ids, event.payload, event.idempotency_key],
    );
  } catch (err) {
    const e = err as { code?: string; constraint?: string };
    if (onDuplicateKey && e.code === UNIQUE_VIOLATION && e.constraint === LEDGER_IDEMPOTENCY_CONSTRAINT) {
      throw onDuplicateKey(event, err);
    }
    throw err;
  }
}
