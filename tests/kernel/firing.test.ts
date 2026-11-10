// LC-M1-T4 acceptance: manual `transition` plus `fire_event` move a loop's
// state; `what_fires_next` and `open_loops` answer from the stored graph (SPEC B3).
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertValid, experimentProposal, newKernel, repoRuns, resultsLand } from "./fixtures.ts";

const evidence = { kind: "communication", id: "lc_comm_1" } as const;

async function openLoop() {
  const env = newKernel();
  const { loop } = await env.kernel.proposeLoop(experimentProposal());
  await env.kernel.acceptLoop(loop.id, { acceptor: "joe" });
  return { ...env, loopId: loop.id };
}

test("manual transition plus fire_event move a loop state", async () => {
  const { kernel, store, loopId, tick } = await openLoop();

  // Manual transition open → waiting, with evidence, as one ledger event.
  tick(30);
  const waiting = await kernel.transition(loopId, {
    to_state: "waiting",
    actor: "agent:juno",
    evidence,
    idempotency_key: "t-1",
  });
  assert.equal(waiting.applied, true);
  assertValid("loop", waiting.loop);
  assertValid("ledger-event", waiting.ledger_event);
  assert.equal(waiting.loop.state, "waiting");
  assert.deepEqual(waiting.ledger_event.payload, { from_state: "open", to_state: "waiting", evidence });
  assert.equal(waiting.ledger_event.idempotency_key, "t-1");

  // Double-delivered transition applies once.
  const replay = await kernel.transition(loopId, { to_state: "waiting", actor: "agent:juno", evidence, idempotency_key: "t-1" });
  assert.equal(replay.applied, false);
  assert.equal(replay.ledger_event.id, waiting.ledger_event.id);
  // Reusing a key for a different change is a conflict, not a silent no-op.
  await assert.rejects(
    kernel.transition(loopId, { to_state: "chased", actor: "agent:juno", evidence, idempotency_key: "t-1" }),
    { code: "conflict" },
  );

  // what_fires_next, from the stored graph: repo-runs reopens the waiting loop; results-landing closes it.
  const next = await kernel.whatFiresNext({ loop_id: loopId });
  const byWhen = new Map(next.effects.map((e) => [e.when_id, e]));
  assert.equal(byWhen.get(repoRuns.id)?.next_state, "open");
  assert.equal(byWhen.get(repoRuns.id)?.via_edge_ids?.length, 2);
  assert.equal(byWhen.get(resultsLand.id)?.next_state, "closed");
  const forWhen = await kernel.whatFiresNext({ when_id: repoRuns.id });
  assert.deepEqual(forWhen.effects.map((e) => [e.loop_id, e.next_state]), [[loopId, "open"]]);

  // fire_event (by when_id): records the firing and moves waiting → open.
  tick(30);
  const fired = await kernel.fireEvent({ when_id: repoRuns.id, idempotency_key: "ci-run-77" });
  assert.equal(fired.applied, true);
  assertValid("ledger-event", fired.ledger_event);
  assert.equal(fired.ledger_event.event_type, "when_fired");
  assert.deepEqual(fired.loop_ids, [loopId]);
  assert.deepEqual(fired.workflow_runs, []);
  assert.equal((await kernel.getLoop(loopId)).state, "open");
  const when = await store.read((tx) => tx.getNode(repoRuns.id));
  assertValid("node", when);
  assert.equal(when?.attributes["fire_count"], 1);
  assert.equal(when?.attributes["fired_at"], "2026-11-10T09:01:00.000Z");

  // The firing-caused transition cites the firing as evidence.
  const ledger = await store.read((tx) => tx.ledger());
  const caused = ledger.at(-1);
  assert.equal(caused?.event_type, "transition");
  assert.deepEqual(caused?.payload, {
    from_state: "waiting",
    to_state: "open",
    evidence: { kind: "ledger_event", id: fired.ledger_event.id },
  });

  // The same external event delivered twice applies once.
  const ledgerLength = ledger.length;
  const again = await kernel.fireEvent({ when_id: repoRuns.id, idempotency_key: "ci-run-77" });
  assert.equal(again.applied, false);
  assert.equal(again.ledger_event.id, fired.ledger_event.id);
  assert.equal((await store.read((tx) => tx.ledger())).length, ledgerLength);

  // fire_event (by event_type + source) on the closing When closes the loop.
  const closing = await kernel.fireEvent({
    event_type: "results_landed",
    source: "manual",
    payload: { note: "results in" },
    idempotency_key: "results-1",
  });
  assert.deepEqual(closing.loop_ids, [loopId]);
  const closed = await kernel.getLoop(loopId);
  assertValid("loop", closed);
  assert.equal(closed.state, "closed");
  assert.equal(closed.closed_at, "2026-11-10T09:01:00.000Z");

  // Closed loops leave open_loops, and nothing fires them any more.
  assert.deepEqual((await kernel.openLoops({})).loops, []);
  assert.deepEqual((await kernel.whatFiresNext({ loop_id: loopId })).effects, []);

  // Invalid transitions are rejected.
  await assert.rejects(
    kernel.transition(loopId, { to_state: "open", actor: "joe", evidence, idempotency_key: "t-2" }),
    { code: "conflict" },
  );
});

test("transition validates states and close reasons", async () => {
  const { kernel, loopId } = await openLoop();
  await assert.rejects(
    kernel.transition(loopId, { to_state: "proposed", actor: "joe", evidence, idempotency_key: "x-1" }),
    { code: "conflict" },
  );
  await assert.rejects(
    kernel.transition(loopId, { to_state: "closed_with_reason", actor: "joe", evidence, idempotency_key: "x-2" }),
    { code: "bad_request" },
  );
  await assert.rejects(
    kernel.transition(loopId, { to_state: "closed_with_reason", close_reason: "rejected", actor: "joe", evidence, idempotency_key: "x-3" }),
    { code: "bad_request" },
    "rejected is reserved for reject_loop",
  );
  const abandoned = await kernel.transition(loopId, {
    to_state: "closed_with_reason",
    close_reason: "abandoned",
    actor: "joe",
    evidence,
    idempotency_key: "x-4",
  });
  assertValid("loop", abandoned.loop);
  assert.equal(abandoned.loop.close_reason, "abandoned");
  await assert.rejects(kernel.fireEvent({ when_id: "lc_when_missing", idempotency_key: "k" }), { code: "not_found" });
});
