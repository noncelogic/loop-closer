// LC-RUN-LEDGER-ORDER acceptance: every Postgres ledger writer appends through
// one shared commit-ordered append (src/db/ledger.ts), so a reader paging the
// ledger by seq never skips or repeats a committed event — even when a timer
// store and the graph store append in overlapping transactions.
//
// Runs against a real Compose replica; each test gets its own migrated database.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import pg from "pg";
import { migrationFiles, migrationsDir, Replica, repoRoot } from "../schema/replica.ts";
import { appendLedgerEvent, type LedgerEventRow } from "../../src/db/ledger.ts";
import { PgTimerStore as PoolTimerStore } from "../../src/timer/pg-timer-store.ts";
import { PgTimerStore as UrlTimerStore } from "../../src/timer/pg-store.ts";
import type { TimerStore } from "../../src/timer/store.ts";

const db = new Replica("ledger-order");
const pools: pg.Pool[] = [];
const closers: Array<() => Promise<void>> = [];
let databases = 0;

before(() => db.up(), { timeout: 300_000 });
after(async () => {
  await Promise.all([...pools.map((p) => p.end()), ...closers.map((c) => c())]);
  db.down();
}, { timeout: 120_000 });

const SEED = `
INSERT INTO nodes (id, kind, created_at, status, attributes) VALUES
  ('lc_who_joe', 'who', '2026-11-01T00:00:00Z', 'active', '{"who_type":"person","name":"Joe"}');
`;

function freshDatabase(): { name: string; pool: pg.Pool } {
  const name = `lc_order_${++databases}`;
  db.psql(`CREATE DATABASE ${name}`);
  const migrations = migrationFiles()
    .map((f) => readFileSync(join(migrationsDir, f), "utf8"))
    .join("\n");
  db.psql(`${migrations}\n${SEED}`, { database: name });
  const pool = new pg.Pool({ connectionString: db.databaseUrl(name), max: 6 });
  pool.on("connect", (client) => void client.query("SET ROLE loopcloser_app"));
  pools.push(pool);
  return { name, pool };
}

function event(id: string, event_type: string): LedgerEventRow {
  return { id, at: "2026-11-16T12:00:00Z", actor: "agent:juno", event_type, subject_ids: ["lc_who_joe"], payload: {}, idempotency_key: null };
}

/** A reader paging the ledger by sequence number: the events after `cursor`, and the new cursor. */
async function pageAfter(pool: pg.Pool, cursor: number, limit = 100): Promise<{ ids: string[]; cursor: number }> {
  const { rows } = await pool.query<{ seq: string; id: string }>(
    "SELECT seq, id FROM ledger_events WHERE seq > $1 ORDER BY seq LIMIT $2",
    [cursor, limit],
  );
  return { ids: rows.map((r) => r.id), cursor: rows.length ? Number(rows[rows.length - 1]!.seq) : cursor };
}

/** The graph store's append (LC-RUN-PGSTORE): its own transaction through the shared append. */
async function graphAppend(pool: pg.Pool, e: LedgerEventRow): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await appendLedgerEvent(client, e);
    await client.query("COMMIT");
  } finally {
    client.release();
  }
}

/** Resolves once `pending` has settled or some backend of this database waits on the ledger append lock. */
async function settledOrWaitingOnAppendLock(pool: pg.Pool, database: string, pending: Promise<unknown>): Promise<"settled" | "waiting"> {
  let settled = false;
  pending.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let i = 0; i < 400; i++) {
    if (settled) return "settled";
    const { rows } = await pool.query(
      `SELECT 1 FROM pg_locks
        WHERE locktype = 'advisory' AND NOT granted
          AND database = (SELECT oid FROM pg_database WHERE datname = $1)`,
      [database],
    );
    if (rows.length > 0) return "waiting";
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("neither settled nor waiting on the ledger append lock");
}

/** Runs a timer-store transaction that appends `e`, then holds the transaction open until released. */
function holdTimerAppend(store: TimerStore, e: LedgerEventRow): { appended: Promise<void>; release: () => void; done: Promise<void> } {
  let appendedResolve!: () => void;
  const appended = new Promise<void>((r) => (appendedResolve = r));
  let release!: () => void;
  const mayCommit = new Promise<void>((r) => (release = r));
  const done = store.transaction(async (tx) => {
    await tx.appendLedgerEvent({ ...e, subject_ids: [...e.subject_ids] });
    appendedResolve();
    await mayCommit;
  });
  done.catch(() => appendedResolve());
  return { appended, release, done };
}

test("a timer event committed after a later graph event was paged appears on the next page exactly once", { timeout: 120_000 }, async () => {
  const { name, pool } = freshDatabase();
  const timer = new PoolTimerStore(pool);

  // The timer store appends first (taking the lower seq) and holds its transaction open.
  const t = holdTimerAppend(timer, event("lc_evt_timer", "when_fired"));
  await t.appended;

  // The graph store appends afterwards, in its own transaction.
  const graph = graphAppend(pool, event("lc_evt_graph", "transition"));
  await settledOrWaitingOnAppendLock(pool, name, graph);

  // A reader pages the ledger while the timer transaction is still open.
  const seen: string[] = [];
  let page = await pageAfter(pool, 0);
  seen.push(...page.ids);

  // The timer event commits after that page was read.
  t.release();
  await t.done;
  await graph;

  page = await pageAfter(pool, page.cursor);
  seen.push(...page.ids);
  page = await pageAfter(pool, page.cursor);
  assert.deepEqual(page.ids, [], "the ledger is fully paged");

  assert.deepEqual(seen.filter((id) => id === "lc_evt_timer"), ["lc_evt_timer"], "the timer event is paged exactly once");
  assert.deepEqual(seen.filter((id) => id === "lc_evt_graph"), ["lc_evt_graph"], "the graph event is paged exactly once");
  assert.deepEqual(seen, ["lc_evt_timer", "lc_evt_graph"], "pages follow commit order");
});

/** Every non-test TypeScript file under src/. */
function sourceFiles(dir = join(repoRoot, "src")): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? sourceFiles(p) : p.endsWith(".ts") ? [p] : [];
  });
}

test("each Postgres ledger writer appends through the shared commit-ordered append", { timeout: 120_000 }, async () => {
  // Statically: only the shared append inserts into the ledger, and every Postgres store that writes it imports it.
  const writers = new Set<string>();
  for (const file of sourceFiles()) {
    const rel = relative(repoRoot, file);
    const text = readFileSync(file, "utf8");
    if (rel === join("src", "db", "ledger.ts")) continue;
    assert.ok(!/INSERT\s+INTO\s+(public\.)?ledger_events/i.test(text), `${rel} inserts into the ledger directly`);
    if (/from "pg"/.test(text) && /appendLedgerEvent|appendEvent/.test(text)) {
      assert.ok(/from "(\.\.\/|\.\/)+db\/ledger\.ts"/.test(text), `${rel} must append through src/db/ledger.ts`);
      writers.add(rel);
    }
  }
  for (const known of [join("src", "timer", "pg-store.ts"), join("src", "timer", "pg-timer-store.ts")]) {
    assert.ok(writers.has(known), `${known} is a Postgres ledger writer`);
  }

  // Behaviourally: each Postgres timer store waits for an open ledger append to end before it appends,
  // so its event takes a seq above every earlier one.
  const { name, pool } = freshDatabase();
  const urlStore = new UrlTimerStore({ connectionString: db.databaseUrl(name) });
  closers.push(() => urlStore.close());
  const stores: Array<[string, TimerStore]> = [
    ["src/timer/pg-timer-store.ts", new PoolTimerStore(pool)],
    ["src/timer/pg-store.ts", urlStore],
  ];
  for (const [i, [label, store]] of stores.entries()) {
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await appendLedgerEvent(holder, event(`lc_evt_held_${i}`, "transition"));
      const appending = store.transaction((tx) =>
        tx.appendLedgerEvent({ ...event(`lc_evt_after_${i}`, "when_fired"), subject_ids: ["lc_who_joe"] }),
      );
      assert.equal(await settledOrWaitingOnAppendLock(pool, name, appending), "waiting", `${label} must wait on the ledger append lock`);
      await holder.query("COMMIT");
      await appending;
    } finally {
      holder.release();
    }
  }
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM ledger_events ORDER BY seq");
  assert.equal(rows.length, 4);
});
