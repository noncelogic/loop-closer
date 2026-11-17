// LC-RUN-PGSTORE and LC-RUN-PG-STORE-CORE acceptance: PgGraphStore, alone and
// under the kernel, against a real Compose replica. Each test gets its own migrated database; stores act as
// loopcloser_app, so they need only the app role's grants. Independent store
// instances each own their own pool, as separate service processes would.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { migrationFiles, migrationsDir, Replica } from "../schema/replica.ts";
import {
  Kernel,
  KernelError,
  PgGraphStore,
  type Communication,
  type Edge,
  type GraphStore,
  type GraphTx,
  type LedgerEvent,
  type Loop,
  type Node,
} from "../../src/kernel/index.ts";
import { PgTimerStore } from "../../src/timer/pg-timer-store.ts";
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

/** True while some session on `database` waits on a lock held by an idle-in-transaction session. */
function lockWaitObserver(database: string): () => Promise<boolean> {
  const observer = new pg.Pool({ connectionString: db.databaseUrl(database), max: 1 });
  pools.push(observer);
  return async () =>
    Number(
      (
        await observer.query(
          `SELECT count(*) AS n FROM pg_stat_activity w
             JOIN pg_stat_activity h ON h.pid = ANY(pg_blocking_pids(w.pid))
            WHERE w.datname = $1 AND w.wait_event_type = 'Lock' AND h.state = 'idle in transaction'`,
          [database],
        )
      ).rows[0].n,
    ) > 0;
}

/** Polls `done` every 10 ms; throws `message` after 30 s. */
async function within30s(done: () => boolean | Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
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

// ---- LC-RUN-PG-STORE-CORE acceptance ---------------------------------------
// The GraphStore contract driven directly through PgGraphStore transactions,
// without the kernel in between, against a migrated local database.

const ISO = "2026-11-10T08:00:00.000Z";
const core = {
  person: { id: "lc_who_core_joe", kind: "who", created_at: ISO, status: "active",
    attributes: { who_type: "person", name: "Joe", contact_points: [{ channel: "email", value: "joe@example.test" }], external_ids: { plane: "u-1" } } },
  agent: { id: "lc_who_core_juno", kind: "who", created_at: ISO, status: "active",
    attributes: { who_type: "agent", name: "Juno", contact_points: [], external_ids: {} } },
  objective: { id: "lc_what_core_ship", kind: "what", created_at: ISO, status: "active",
    attributes: { what_type: "objective", title: "Ship onboarding", target: "2026-12-01" } },
  event: { id: "lc_when_core_reply", kind: "when", created_at: ISO, status: "active",
    attributes: { when_type: "event", event_type: "reply_received", source_binding: { source: "mail", mechanism: "webhook" }, fired_at: null, fire_count: 0 } },
  calendar: { id: "lc_when_core_review", kind: "when", created_at: ISO, status: "active",
    attributes: { when_type: "calendar", schedule: { rrule: "FREQ=WEEKLY;BYDAY=MO" }, timezone: "America/New_York", next_fire_at: "2026-11-16T14:00:00Z" } },
} satisfies Record<string, Node>;

function coreLoop(overrides: Partial<Loop> = {}): Loop {
  return {
    id: "lc_loop_core",
    name: "Ship onboarding flow",
    loop_type: "outreach",
    state: "proposed",
    accountable_who_id: core.person.id,
    member_node_ids: [core.objective.id, core.event.id, core.calendar.id, core.person.id, core.agent.id], // sorted, as stored
    closing_when_id: core.event.id,
    authority: "joe-approves-each",
    opened_at: null,
    closed_at: null,
    close_reason: null,
    policy_refs: { ageing: { id: "lc_policy_ageing_outreach", version: 1 }, escalation: { id: "lc_policy_esc_outreach", version: 3 } },
    key_result_ref: { system: "plane", id: "KR-42" },
    ...overrides,
  };
}

const coreEdges: Edge[] = [
  { id: "lc_edge_core_wait", from_id: core.objective.id, to_id: core.event.id, edge_type: "is_waiting_on",
    created_by: "agent:juno", created_at: ISO, evidence: null, status: "active" },
  { id: "lc_edge_core_enables", from_id: core.event.id, to_id: core.objective.id, edge_type: "enables",
    created_by: "agent:juno", created_at: ISO, evidence: { kind: "ledger_event", id: "lc_evt_core_proposed" }, status: "active" },
  { id: "lc_edge_core_owns", from_id: core.person.id, to_id: core.objective.id, edge_type: "owns",
    created_by: "joe", created_at: ISO, evidence: null, status: "retracted" },
];

const coreEvent: LedgerEvent = {
  id: "lc_evt_core_proposed",
  at: ISO,
  actor: "agent:juno",
  event_type: "loop_proposed",
  subject_ids: ["lc_loop_core"],
  payload: { rationale: "round trip" },
  idempotency_key: "core-proposed",
};

test("a PgGraphStore transaction round-trips whos, whats, whens, loops and edges through a migrated local database", { timeout: 120_000 }, async () => {
  const database = freshDatabase();
  const store = newStore(database);
  const nodes = Object.values(core) as Node[];

  await store.transaction(async (tx) => {
    for (const n of nodes) await tx.putNode(n);
    await tx.putLoop(coreLoop());
    await tx.appendEvent(coreEvent);
    for (const e of coreEdges) await tx.putEdge(e);
  });
  // A later transaction updates what the first wrote: the loop moves on and loses a member.
  const opened = coreLoop({
    state: "open",
    opened_at: "2026-11-10T09:00:00.000Z",
    member_node_ids: [core.objective.id, core.event.id, core.calendar.id, core.person.id],
  });
  const retracted: Edge = { ...coreEdges[0]!, status: "retracted" };
  await store.transaction(async (tx) => {
    await tx.putLoop(opened);
    await tx.putEdge(retracted);
  });

  // A fresh instance, on its own pool, reads back exactly what was written.
  const read = await newStore(database).read(async (tx) => ({
    nodes: await tx.listNodes(),
    byId: await Promise.all(nodes.map((n) => tx.getNode(n.id))),
    loop: await tx.getLoop(opened.id),
    loops: await tx.listLoops(),
    edges: await Promise.all(coreEdges.map((e) => tx.getEdge(e.id))),
    touching: await tx.edgesTouching(core.objective.id),
    ledger: await tx.ledger(),
    missing: [await tx.getNode("lc_who_nobody"), await tx.getLoop("lc_loop_nobody"), await tx.getEdge("lc_edge_nobody")],
  }));
  assert.deepEqual(read.byId, nodes);
  assert.deepEqual(read.nodes, [...nodes].sort((a, b) => a.id.localeCompare(b.id)));
  assert.deepEqual(read.loop, opened);
  assert.deepEqual(read.loops, [opened]);
  assert.deepEqual(read.edges, [retracted, coreEdges[1], coreEdges[2]]);
  assert.deepEqual(read.touching, [coreEdges[1]], "only active edges touch a node");
  assert.deepEqual(read.ledger, [coreEvent]);
  assert.deepEqual(read.missing, [undefined, undefined, undefined]);

  // A loop proposed without a key-result reference reads back without one.
  const { key_result_ref: _omitted, ...bare } = coreLoop({ id: "lc_loop_core_bare" });
  await store.transaction((tx) => tx.putLoop(bare));
  assert.deepEqual(await store.read((tx) => tx.getLoop(bare.id)), bare);
});

test("a transaction that throws after partial writes leaves no row behind", { timeout: 120_000 }, async () => {
  const database = freshDatabase();
  const store = newStore(database);
  const empty = await counts(database);
  assert.ok(Object.values(empty).every((n) => n === 0), JSON.stringify(empty));

  const communication: Communication = {
    id: "lc_comm_core", thread_id: "thread-core", channel: "email", direction: "outbound",
    participant_who_ids: [core.person.id], at: ISO, body_pointer: "s3://loopcloser/bodies/core",
    body_hash: `sha256:${"b".repeat(64)}`, loop_id: "lc_loop_core", sent_under_authority: "joe-approves-each",
  };
  let seenInside: Loop | undefined;
  await assert.rejects(
    store.transaction(async (tx) => {
      for (const n of Object.values(core) as Node[]) await tx.putNode(n);
      for (const e of coreEdges) await tx.putEdge(e);
      await tx.putLoop(coreLoop());
      await tx.appendEvent(coreEvent);
      await tx.putCommunication(communication);
      await tx.putSendRequest({ communication_id: communication.id, loop_id: "lc_loop_core", authority: "joe-approves-each",
        status: "pending_approval", requested_by: "agent:juno", requested_at: ISO });
      await tx.enqueue({ ledger_event_id: coreEvent.id, topic: "send", payload: { communication_id: communication.id }, created_at: ISO });
      seenInside = await tx.getLoop("lc_loop_core");
      throw new Error("injected failure after partial writes");
    }),
    /injected failure after partial writes/,
  );
  assert.equal(seenInside?.id, "lc_loop_core", "the writes were made inside the transaction before it threw");
  assert.deepEqual(await counts(database), empty);
  assert.equal(await newStore(database).read((tx) => tx.findEventByIdempotencyKey(coreEvent.idempotency_key!)), undefined);

  // The same writes, committed, are all there: the rollback, not the writes, emptied the tables.
  await store.transaction(async (tx) => {
    for (const n of Object.values(core) as Node[]) await tx.putNode(n);
    await tx.putLoop(coreLoop());
    await tx.appendEvent(coreEvent);
  });
  const committed = await counts(database);
  assert.deepEqual([committed["nodes"], committed["loops"], committed["ledger_events"]], [5, 1, 1]);
});

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

test("two independent PgGraphStore instances transitioning the same loop concurrently apply the transition exactly once", { timeout: 120_000 }, async () => {
  const database = freshDatabase();
  const setup = new Kernel(newStore(database));
  const { loop } = await setup.proposeLoop(experimentProposal());
  const { ledger_event: accepted } = await setup.acceptLoop(loop.id, { acceptor: "joe" });

  // The first transaction to read the loop holds its transaction open until
  // the second has either read the loop too (the store does not lock it) or
  // is observably waiting on a lock held by the first, idle-in-transaction,
  // connection. Only then does the first go on; a missed deadline fails.
  const blockedByHolder = lockWaitObserver(database);
  let arrived = 0;
  const released: string[] = [];
  const meet = async (method: keyof GraphTx): Promise<void> => {
    if (method !== "getLoop" || ++arrived !== 1) return;
    const deadline = Date.now() + 30_000;
    for (;;) {
      if (arrived >= 2) return void released.push("second read the loop");
      if (await blockedByHolder()) return void released.push("second blocked by the first");
      if (Date.now() > deadline) throw new Error("second transaction neither read the loop nor blocked on the first within 30s");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
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
  assert.equal(released.length, 1, `the first transaction was held for the second: ${JSON.stringify(outcomes)}`);
  assert.equal(applied.length, 1, `exactly one transition applies (${released[0]}): ${JSON.stringify(outcomes)}`);
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

test("two concurrent proposals creating the same new node through independent PgGraphStore instances admit one loop and keep its node content", { timeout: 120_000 }, async () => {
  const database = freshDatabase();
  const blockedByHolder = lockWaitObserver(database);
  // Same node id, different content: whichever proposal commits second must
  // not overwrite the first's node, nor open a second loop on the same What.
  const rival = { ...experiment, attributes: { what_type: "action", title: "Run a different experiment" } };
  const proposals = [experimentProposal(), experimentProposal({ nodes: [joe, rival, repoRuns, resultsLand] })];

  // Both first attempts finish their reads (node checks and the dedup check)
  // before either writes, unless the store makes the second wait on the first.
  let arrived = 0;
  const meet = async (method: keyof GraphTx): Promise<void> => {
    if (method !== "listLoops" || ++arrived !== 1) return;
    await within30s(async () => arrived >= 2 || (await blockedByHolder()), "second proposal neither checked nor blocked within 30s");
  };
  const outcomes = await Promise.allSettled(
    proposals.map((p) => new Kernel(new HookedStore(newStore(database), meet)).proposeLoop(p)),
  );

  const applied = outcomes.flatMap((o) => (o.status === "fulfilled" ? [o.value] : []));
  const refused = outcomes.flatMap((o) => (o.status === "rejected" ? [o.reason as unknown] : []));
  assert.equal(applied.length, 1, `exactly one proposal is admitted: ${JSON.stringify(outcomes)}`);
  assert.equal(refused.length, 1);
  assert.ok(refused[0] instanceof KernelError && ["conflict", "duplicate_loop"].includes(refused[0].code), String(refused[0]));

  const winner = outcomes[0]!.status === "fulfilled" ? experiment : rival;
  const stored = await newStore(database).read(async (tx) => ({
    loops: await tx.listLoops(),
    node: await tx.getNode(experiment.id),
    ledger: await tx.ledger(),
  }));
  assert.deepEqual(stored.loops.map((l) => l.id), [applied[0]!.loop.id]);
  assert.deepEqual(stored.node?.attributes, winner.attributes);
  assert.deepEqual(stored.ledger.map((e) => e.event_type), ["loop_proposed"]);
  assert.deepEqual(await counts(database).then((c) => [c["loops"], c["nodes"], c["edges"]]), [1, 4, 2]);
});

test("ledgerAfter pages a graph append and a concurrent timer append each exactly once, whichever commits first", { timeout: 120_000 }, async () => {
  const database = freshDatabase();
  const blockedByHolder = lockWaitObserver(database);
  const kernel = new Kernel(newStore(database));
  const { loop } = await kernel.proposeLoop(experimentProposal());
  const { ledger_event: accepted } = await kernel.acceptLoop(loop.id, { acceptor: "joe" });
  const reader = newStore(database);
  const start = (await reader.read((tx) => tx.ledgerAfter(0, 100)))!.position;

  // A timer tick appends to the ledger and holds its transaction open while a
  // graph transition, appended after it, tries to commit.
  let appended!: () => void;
  const timerAppended = new Promise<void>((resolve) => (appended = resolve));
  let release!: () => void;
  const timerMayCommit = new Promise<void>((resolve) => (release = resolve));
  const timer = new PgTimerStore(appPool(database)).transaction(async (tx) => {
    await tx.appendLedgerEvent({
      id: "lc_evt_timer_race",
      at: "2026-11-10T09:00:00.000Z",
      actor: "system:timer",
      event_type: "when_fired",
      subject_ids: [repoRuns.id],
      payload: {},
      idempotency_key: "timer-race",
    });
    appended();
    await timerMayCommit;
  });
  await timerAppended;
  let graphSettled = false;
  const graph = new Kernel(newStore(database))
    .transition(loop.id, {
      to_state: "waiting",
      actor: "agent:juno",
      evidence: { kind: "ledger_event", id: accepted.id },
      idempotency_key: "graph-race",
    })
    .finally(() => void (graphSettled = true));
  await within30s(async () => graphSettled || (await blockedByHolder()), "graph transition neither committed nor waited on the timer within 30s");

  // A reader pages the ledger mid-race, then again once both have committed.
  const first = (await reader.read((tx) => tx.ledgerAfter(start, 100)))!;
  release();
  await timer;
  const { ledger_event: moved } = await graph;
  const second = (await reader.read((tx) => tx.ledgerAfter(first.position, 100)))!;

  const paged = [...first.events, ...second.events].map((e) => e.id);
  const all = (await reader.read((tx) => tx.ledger())).slice(start).map((e) => e.id);
  assert.deepEqual(paged, all, "paging from the mid-race cursor yields every later event once, in ledger order");
  assert.deepEqual([...all].sort(), ["lc_evt_timer_race", moved!.id].sort());
});
