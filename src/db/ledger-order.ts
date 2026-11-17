// The ledger ordering protocol every ledger_events writer follows.
//
// ledger_events.seq comes from an identity sequence, which hands out values at
// INSERT time, not at COMMIT: two writers can commit in the opposite order to
// their seq values, and a reader paging by position (ledgerAfter) would then
// see a later event before an earlier one commits, and skip or repeat events.
// Every transaction that appends to the ledger therefore runs this statement
// before its first INSERT. The transaction-scoped advisory lock is held until
// COMMIT or ROLLBACK, so at most one transaction has uncommitted ledger rows
// at a time and seq order is commit order.
//
// Writers: PgGraphStore (src/kernel/pg-store.ts), PgTimerStore
// (src/timer/pg-store.ts and src/timer/pg-timer-store.ts). A new writer of
// ledger_events must take this lock too.
export const LEDGER_APPEND_LOCK = "SELECT pg_advisory_xact_lock(hashtextextended('loopcloser:ledger_events:append', 0))";
