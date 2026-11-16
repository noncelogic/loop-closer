// LC-RUN-PGSTORE acceptance: the kernel over PgGraphStore against a real
// Compose replica. Each test gets its own migrated database; stores act as
// loopcloser_app, so they need only the app role's grants. Independent store
// instances each own their own pool, as separate service processes would.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { migrationFiles, migrationsDir, Replica } from "../schema/replica.ts";
import { Kernel, KernelError, PgGraphStore, type GraphStore, type GraphTx } from "../../src/kernel/index.ts";
import { experiment, experimentProposal, joe, repoRuns, resultsLand } from "./fixtures.ts";

const db = new Replica("pg-graph-store");
const pools: pg.Pool[] = [];
let databases = 0;

before(() => db.up(), { timeout: 300_000 });
after(async () => {
  await Promise.all(pools.map((p) => p.end()));
  db.down();
}, { timeout: 120_000 });

/** A fresh database with every migration applied; returns its name. */
function freshDatabase(): string {
  const name = `lc_graph_${++databases}`;
  db.psql(`CREATE DATABASE ${name}`);
  db.psql(migrationFiles().map((f) => readFileSync(join(migrationsDir, f), "utf8")).join("\n"), { database: name });
  return name;
}

/** A new pool on `database` whose connections act as loopcloser_app. */
function appPool(database: string): pg.Pool {
  const pool = new pg.Pool({ connectionString: db.databaseUrl(database), max: 4 });
  pool.on("connect", (client) => void client.query("SET ROLE loopcloser_app"));
  pools.push(pool);
  return pool;
}

/** A new, independent PgGraphStore instance on `database`. */
function newStore(database: string): PgGraphStore {
  return new PgGraphStore(appPool(database));
}

async function counts(database: string): Promise<Record<string, number>> {
  const pool = new pg.Pool({ connectionString: db.databaseUrl(database), max: 1 });
  try {
    const tables = ["nodes", "edges", "loops", "loop_members", "ledger_events", "communications", "send_requests", "outbox"];
    const out: Record<string, number> = {};
    for (const t of tables) out[t] = Number((await pool.query(`SELECT count(*) AS n FROM ${t}`)).rows[0].n);
    return out;
  } finally {
    await pool.end();
  }
}

/** A GraphStore whose GraphTx runs `hook` after each call returns, before handing back its result. */
class HookedStore implements GraphStore {
  readonly inner: GraphStore;
  readonly hook: (method: keyof GraphTx, args: unknown[], result: unknown) => void | Promise<void>;

  constructor(inner: GraphStore, hook: HookedStore["hook"]) {
    this.inner = inner;
    this.hook = hook;
  }

  transaction<T>(fn: (tx: GraphTx) => T | Promise<T>): Promise<T> {
    return this.inner.transaction((tx) => fn(this.#wrap(tx)));
  }

  read<T>(fn: (tx: GraphTx) => T | Promise<T>): Promise<T> {
    return this.inner.read((tx) => fn(this.#wrap(tx)));
  }

  #wrap(tx: GraphTx): GraphTx {
    return new Proxy(tx, {
      get: (target, prop, receiver) => {
        const method = Reflect.get(target, prop, receiver) as unknown;
        if (typeof method !== "function") return method;
        return async (...args: unknown[]) => {
          const result: unknown = await (method as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          await this.hook(prop as keyof GraphTx, args, result);
          return result;
        };
      },
    });
  }
}

test("a loop accepted through one PgGraphStore instance is read back by a fresh instance on the same database", { timeout: 120_000 }, async () => {
  const database = freshDatabase();
  const kernel = new Kernel(newStore(database));
  const { loop: proposed, ledger_event: proposedEvent } = await kernel.proposeLoop(
    experimentProposal({ key_result_ref: { system: "okr", id: "kr-7" } }),
  );
  const { loop: accepted, ledger_event: acceptedEvent } = await kernel.acceptLoop(proposed.id, { acceptor: "joe" });
  assert.equal(accepted.state, "open");

  const fresh = newStore(database);
  const read = await fresh.read(async (tx) => ({
    loop: await tx.getLoop(accepted.id),
    loops: await tx.listLoops(),
    ledger: await tx.ledger(),
    page: await tx.ledgerAfter(1, 10),
    nodes: await tx.listNodes(),
    edges: await tx.edgesTouching(experiment.id),
  }));
  assert.deepEqual(read.loop, { ...accepted, member_node_ids: [...accepted.member_node_ids].sort() });
  assert.deepEqual(read.loops, [read.loop]);
  assert.deepEqual(read.ledger, [proposedEvent, acceptedEvent]);
  assert.deepEqual(read.page, { events: [acceptedEvent], position: 2 });
  assert.deepEqual(
    read.nodes.map((n) => [n.id, n.kind, n.status, n.attributes]),
    [joe, repoRuns, resultsLand, experiment]
      .map((n) => [n.id, n.kind, n.status, n.attributes])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
  assert.equal(read.edges.length, 2);
  assert.deepEqual(read.edges.map((e) => e.status), ["active", "active"]);

  // The fresh instance's kernel carries the loop on from where the first left it.
  const moved = await new Kernel(fresh).transition(accepted.id, {
    to_state: "waiting",
    actor: "agent:juno",
    evidence: { kind: "ledger_event", id: acceptedEvent.id },
    idempotency_key: "fresh-waiting",
  });
  assert.equal(moved.applied, true);
  assert.equal(moved.loop.state, "waiting");
  await assert.rejects(fresh.read((tx) => tx.putNode(joe)), /read-only/);
});

test("two concurrent transitions of one loop from the same state through independent PgGraphStore instances apply exactly once", { timeout: 120_000 }, async () => {
  const database = freshDatabase();
  const setup = new Kernel(newStore(database));
  const { loop } = await setup.proposeLoop(experimentProposal());
  const { ledger_event: accepted } = await setup.acceptLoop(loop.id, { acceptor: "joe" });

  // Both transactions read the loop before either commits, unless the store
  // makes the second wait for the first: each waits after getLoop for the
  // other to have read it too, giving up after a short while.
  let arrived = 0;
  let release!: () => void;
  const bothRead = new Promise<void>((resolve) => (release = resolve));
  const meet = async (method: keyof GraphTx): Promise<void> => {
    if (method !== "getLoop") return;
    if (++arrived === 2) release();
    await Promise.race([bothRead, new Promise((resolve) => setTimeout(resolve, 500))]);
  };
  const racers = ["a", "b"].map((name) =>
    new Kernel(new HookedStore(newStore(database), meet)).transition(loop.id, {
      to_state: "waiting",
      actor: `agent:${name}`,
      evidence: { kind: "ledger_event", id: accepted.id },
      idempotency_key: `race-${name}`,
    }),
  );
  const outcomes = await Promise.allSettled(racers);

  const applied = outcomes.filter((o) => o.status === "fulfilled");
  const refused = outcomes.filter((o): o is PromiseRejectedResult => o.status === "rejected");
  assert.equal(applied.length, 1, `exactly one transition applies: ${JSON.stringify(outcomes)}`);
  assert.equal(refused.length, 1);
  assert.ok(refused[0]!.reason instanceof KernelError && refused[0]!.reason.code === "conflict", String(refused[0]!.reason));

  const after = await newStore(database).read(async (tx) => ({ loop: await tx.getLoop(loop.id), ledger: await tx.ledger() }));
  assert.equal(after.loop?.state, "waiting");
  const transitions = after.ledger.filter((e) => e.event_type === "transition");
  assert.equal(transitions.length, 1);
  assert.deepEqual(transitions[0]!.payload["from_state"], "open");
});

test("a kernel operation that fails after partial writes leaves no ledger event, node, send request or outbox row behind", { timeout: 120_000 }, async () => {
  const database = freshDatabase();
  const store = newStore(database);
  const failAfter = (target: keyof GraphTx, when: (args: unknown[]) => boolean = () => true) =>
    new HookedStore(store, (method, args) => {
      if (method === target && when(args)) throw new Error(`injected failure after ${method}`);
    });
  const options = { ownerReceiverIds: [joe.id] };

  // propose_loop fails after its last write (the loop_proposed ledger event):
  // its nodes, edges, loop and ledger event are all gone.
  const empty = await counts(database);
  await assert.rejects(new Kernel(failAfter("appendEvent"), options).proposeLoop(experimentProposal()), /injected failure/);
  assert.deepEqual(await counts(database), empty);

  // request_send on an autonomous loop fails after its last write (the send
  // request marked enqueued): the released communication, communication_sent
  // ledger event, outbox row and send request are all gone.
  const kernel = new Kernel(store, options);
  const { loop } = await kernel.proposeLoop(experimentProposal({ loop_type: "factory-notification" }));
  await kernel.acceptLoop(loop.id, { acceptor: "joe" });
  const draft = await kernel.recordCommunication({
    thread_id: "thread-1",
    channel: "message",
    direction: "outbound",
    participant_who_ids: [joe.id],
    at: "2026-11-10T09:00:00.000Z",
    body_pointer: "s3://loopcloser/bodies/1",
    body_hash: `sha256:${"a".repeat(64)}`,
    loop_id: loop.id,
  });
  const before = await counts(database);
  await assert.rejects(
    new Kernel(failAfter("putSendRequest", (args) => (args[0] as { status: string }).status === "enqueued"), options).requestSend(
      loop.id,
      { communication_id: draft.id, actor: "agent:sender" },
    ),
    /injected failure/,
  );
  assert.deepEqual(await counts(database), before);
  assert.equal(before["send_requests"], 0);
  assert.equal(before["outbox"], 0);
  assert.deepEqual(await store.read((tx) => tx.getCommunication(draft.id)), draft);

  // The same operation, unhindered, writes all of them.
  assert.equal((await kernel.requestSend(loop.id, { communication_id: draft.id, actor: "agent:sender" })).status, "enqueued");
  const done = await counts(database);
  assert.equal(done["send_requests"], 1);
  assert.equal(done["outbox"], 1);
  assert.equal(done["ledger_events"], before["ledger_events"]! + 1);
});
