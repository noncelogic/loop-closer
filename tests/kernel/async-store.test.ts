// LC-RUN-GRAPHTX-ASYNC acceptance: every GraphTx method returns a Promise the
// kernel awaits, so a store backed by network queries (Postgres) can sit
// behind GraphStore. The store here wraps InMemoryGraphStore and resolves (or
// rejects) every GraphTx call on a later tick, as a network round trip would.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as nextTick } from "node:timers/promises";
import { InMemoryGraphStore, Kernel, type GraphStore, type GraphTx } from "../../src/kernel/index.ts";
import { experimentProposal } from "./fixtures.ts";

type FailWrite = (method: keyof GraphTx, args: unknown[]) => boolean;

/** Every GraphTx call settles on a later tick; `failWrite` makes a call reject there instead. */
class LaterTickGraphStore implements GraphStore {
  readonly inner = new InMemoryGraphStore();
  failWrite: FailWrite = () => false;
  calls = 0;

  transaction<T>(fn: (tx: GraphTx) => T | Promise<T>): Promise<T> {
    return this.inner.transaction((tx) => fn(this.#later(tx)));
  }

  read<T>(fn: (tx: GraphTx) => T | Promise<T>): Promise<T> {
    return this.inner.read((tx) => fn(this.#later(tx)));
  }

  #later(tx: GraphTx): GraphTx {
    return new Proxy(tx, {
      get: (target, prop, receiver) => {
        const method = Reflect.get(target, prop, receiver) as unknown;
        if (typeof method !== "function") return method;
        return async (...args: unknown[]) => {
          this.calls++;
          await nextTick();
          if (this.failWrite(prop as keyof GraphTx, args)) throw new Error(`network write ${String(prop)} failed`);
          return (method as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
  }
}

function newAsyncKernel(): { kernel: Kernel; store: LaterTickGraphStore } {
  let seq = 0;
  const store = new LaterTickGraphStore();
  const kernel = new Kernel(store, { now: () => new Date("2026-11-10T09:00:00Z"), newId: (prefix) => `lc_${prefix}_${++seq}` });
  return { kernel, store };
}

test("the kernel accepts a proposed loop and applies a transition on a GraphStore whose every GraphTx method resolves on a later tick", async () => {
  const { kernel, store } = newAsyncKernel();

  const proposed = await kernel.proposeLoop(experimentProposal());
  assert.equal(proposed.loop.state, "proposed");
  const accepted = await kernel.acceptLoop(proposed.loop.id, { acceptor: "human:joe" });
  assert.equal(accepted.loop.state, "open");

  const moved = await kernel.transition(proposed.loop.id, {
    to_state: "waiting",
    actor: "human:joe",
    evidence: { kind: "gather", id: "lc_gather_1" },
    idempotency_key: "async-1",
  });
  assert.equal(moved.applied, true);
  assert.equal(moved.loop.state, "waiting");
  assert.ok(store.calls > 0, "the kernel went through the asynchronous GraphTx");

  assert.equal((await kernel.getLoop(proposed.loop.id)).state, "waiting");
  const ledger = await store.inner.read((tx) => tx.ledger());
  assert.deepEqual(
    ledger.map((e) => e.event_type),
    ["loop_proposed", "loop_accepted", "transition"],
  );

  // The replayed key is found through the asynchronous lookup and applies once.
  const replay = await kernel.transition(proposed.loop.id, {
    to_state: "waiting",
    actor: "human:joe",
    evidence: { kind: "gather", id: "lc_gather_1" },
    idempotency_key: "async-1",
  });
  assert.equal(replay.applied, false);
  assert.equal((await store.inner.read((tx) => tx.ledger())).length, 3);
});

test("a kernel operation whose asynchronous GraphTx write rejects midway leaves no ledger event or node change behind", async () => {
  const { kernel, store } = newAsyncKernel();
  const proposed = await kernel.proposeLoop(experimentProposal());
  await kernel.acceptLoop(proposed.loop.id, { acceptor: "human:joe" });

  const snapshot = (): Promise<unknown> =>
    store.inner.read(async (tx) => ({
      nodes: await tx.listNodes(),
      loops: await tx.listLoops(),
      ledger: await tx.ledger(),
      outbox: await tx.outbox(),
    }));
  const before = await snapshot();

  // fire_event writes the When node, the when_fired event and the loop's new
  // state, then the transition's ledger write fails on the wire.
  store.failWrite = (method, args) =>
    method === "appendEvent" && (args[0] as { event_type: string }).event_type === "transition";

  await assert.rejects(
    kernel.fireEvent({ when_id: experimentProposal().closing_when_id!, idempotency_key: "fire-fails" }),
    /network write appendEvent failed/,
  );

  assert.deepEqual(await snapshot(), before, "nothing the failed operation wrote is committed");
  assert.equal((await kernel.getLoop(proposed.loop.id)).state, "open");

  // The store keeps working: the same operation succeeds once the wire does.
  store.failWrite = () => false;
  const fired = await kernel.fireEvent({ when_id: experimentProposal().closing_when_id!, idempotency_key: "fire-fails" });
  assert.equal(fired.applied, true);
  assert.equal((await kernel.getLoop(proposed.loop.id)).state, "closed");
});
