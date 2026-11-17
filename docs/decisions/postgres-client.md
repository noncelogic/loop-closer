# Decision record: Postgres client for the loopcloser service

Date: 2026-11-16 · Task: LC-RUN-PG-CLIENT-DEC (recorded with LC-RUN-PGSTORE) · Status: adopted (task default)

## Context

The kernel's `GraphStore` (`src/kernel/store.ts`) and the timer's `TimerStore`
(`src/timer/store.ts`) need a Postgres implementation over the versioned
schema in `db/migrations` (TECH-STACK §2, §4, §6). Each operation must run in
one Postgres transaction, take row locks (`SELECT … FOR UPDATE`, and
`FOR UPDATE SKIP LOCKED` for the tick claim), and roll back on any failure.
The service is TypeScript on Node 24 (TECH-STACK §8), run straight from `.ts`
sources by `node` in tests.

The client has to give us:

1. explicit transactions on one connection (`BEGIN` … `COMMIT`/`ROLLBACK`),
   with the connection held for the whole callback;
2. parameterised queries (no SQL built from values);
3. a pool, so concurrent requests in one process each get their own
   connection and transaction;
4. the Postgres error fields (`code`, `constraint`) to tell a unique-key
   collision or a deadlock from other failures;
5. no code generation, build step or ORM model to keep in step with the
   migrations, which stay the single source of the schema.

## Options compared

| | `pg` (node-postgres) | `postgres` (porsager) | Kysely / Drizzle / Prisma |
|---|---|---|---|
| Explicit transaction on one connection | `pool.connect()` → `PoolClient`, plain `BEGIN`/`COMMIT` | `sql.begin(fn)` | Builder-managed |
| Parameterised queries | `$1…$n` | Tagged templates | Builder / generated |
| Pool | `pg.Pool` | Built in | Over a driver (often `pg`) |
| Error `code` / `constraint` | Yes (`DatabaseError`) | Yes | Wrapped, varies |
| Schema source | The SQL migrations | The SQL migrations | A second model (ORM schema, generated types) |
| Types | `@types/pg` | Bundled | Bundled |
| Maturity | Longest-lived Node driver; used by most ORMs underneath | Mature, smaller user base | Mature, more surface |

## Decision

`pg` (node-postgres) `^8.23.1`, with `@types/pg` `^8.23.1` as a dev
dependency; both are already in `package.json`, used by the timer stores
(`src/timer/pg-store.ts`, `src/timer/pg-timer-store.ts`).

Use pattern, as `PgGraphStore` (`src/kernel/pg-store.ts`) applies it:

- The caller builds and owns one `pg.Pool` per process and passes it in; the
  store never ends it. Connections act as `loopcloser_app` and need only its
  grants.
- One `PoolClient` per transaction, `BEGIN` … `COMMIT`, `ROLLBACK` on any
  throw; a client whose `ROLLBACK` failed is released with an error so the
  pool destroys it. A rejected query fails the transaction even if the
  callback swallowed the rejection (Postgres would otherwise turn the
  `COMMIT` into a silent rollback).
- Write transactions run SERIALIZABLE, so checks that find no row (a new
  node id is unused, no open loop duplicates a proposal, an idempotency key
  is unused) hold at commit as checks on existing rows do; `FOR UPDATE`
  alone cannot lock a missing row. Rows read for a later write are also
  taken `FOR UPDATE`, so a second transaction on the same loop waits for the
  first rather than computing a result that cannot commit. A deadlock
  (`40P01`) or serialisation failure (`40001`) re-runs the transaction from
  the start, up to a bounded number of attempts.
- Every writer of `ledger_events` (the graph store and both timer stores)
  takes one transaction-scoped advisory lock before its first append
  (`src/db/ledger-order.ts`), so at most one transaction holds uncommitted
  ledger rows, `ledger_events.seq` order is commit order, and ledger
  positions handed to readers stay valid.
- Reads run REPEATABLE READ READ ONLY: one snapshot per `read()`.
- Values are bound as parameters; `jsonb` values are passed as JSON text.

`postgres` (porsager) would also meet the five needs; `pg` is preferred
because it is already the dependency on main and the timer stores use it, so
adopting a second driver would add a dependency for no gain. ORMs and query
builders are out: they add a second schema model next to the migrations.

## Consequences

- `timestamptz` columns come back as `Date` and are returned as ISO 8601 UTC
  strings with milliseconds (`2026-11-10T08:00:00.000Z`), whatever form the
  writer used. A value written as `2026-11-10T08:00:00Z` reads back as the
  same instant in that canonical form.
- `loop_members` has no position column, so a loop's `member_node_ids` read
  back sorted by node id, not in proposal order. Keeping proposal order would
  need a schema change.
- Every ledger append, by any writer, serialises on one advisory lock until
  its transaction ends. A timer tick holding a claimed When while it waits for
  that lock can deadlock with a graph transaction that holds the lock and
  wants the same When; Postgres aborts one of them, the graph store retries,
  and a tick that loses is re-run by the next tick. At personal scale (hundreds to thousands of loops) that is the
  intended trade: exact, gap-free ledger positions over append throughput.
