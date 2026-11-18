// LC-M1-T4 acceptance: manual `transition` plus `fire_event` move a loop's
// state; `what_fires_next` and `open_loops` answer from the stored graph (SPEC B3).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { Kernel, PgGraphStore, type Node } from "../../src/kernel/index.ts";
import { PgTimerStore as UrlTimerStore } from "../../src/timer/pg-store.ts";
import { PgTimerStore as PoolTimerStore } from "../../src/timer/pg-timer-store.ts";
import type { TimerStore } from "../../src/timer/store.ts";
import { runTick } from "../../src/timer/tick.ts";
import { assertValid, experiment, experimentProposal, newKernel, repoRuns, resultsLand } from "./fixtures.ts";
import { PgHarness } from "./pg-harness.ts";

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

// LC-CP-WHEN-CHANGE: an event When may declare a change condition naming one
// payload field; fire_event by event_type + source fires it only when that
// field's value differs from its value at the When's last firing.
const watchedStatus = {
  ...repoRuns,
  attributes: { ...repoRuns.attributes, change_condition: { field: "status" } },
};

async function watchedLoop() {
  const env = newKernel();
  const { loop } = await env.kernel.proposeLoop(
    experimentProposal({ nodes: experimentProposal().nodes.map((n) => ("id" in n && n.id === repoRuns.id ? watchedStatus : n)) }),
  );
  await env.kernel.acceptLoop(loop.id, { acceptor: "joe" });
  await env.kernel.transition(loop.id, { to_state: "waiting", actor: "agent:juno", evidence, idempotency_key: "w-1" });
  const report = (status: unknown, key: string) =>
    env.kernel.fireEvent({ event_type: "repo_runs", source: "ci", payload: { status, run: key }, idempotency_key: key });
  const when = () => env.store.read((tx) => tx.getNode(repoRuns.id));
  return { ...env, loopId: loop.id, report, when };
}

test("an event with an unchanged value does not fire a change-condition When", async () => {
  const { kernel, loopId, report, when, tick } = await watchedLoop();

  // The first observation always fires and records the value.
  const first = await report("red", "obs-1");
  assert.equal(first.applied, true);
  assert.deepEqual(first.ledger_event.payload["when_ids"], [repoRuns.id]);
  assert.deepEqual(first.loop_ids, [loopId]);
  assert.equal((await kernel.getLoop(loopId)).state, "open");
  const afterFirst = await when();
  assertValid("node", afterFirst);
  assert.equal(afterFirst?.attributes["fire_count"], 1);
  assert.deepEqual(afterFirst?.attributes["change_condition"], { field: "status", last_value: "red" });

  // The same value again: recorded as an observation, but the When does not fire.
  await kernel.transition(loopId, { to_state: "waiting", actor: "agent:juno", evidence, idempotency_key: "w-2" });
  tick(60);
  const same = await report("red", "obs-2");
  assert.equal(same.applied, true);
  assertValid("ledger-event", same.ledger_event);
  assert.equal(same.ledger_event.event_type, "when_fired");
  assert.deepEqual(same.ledger_event.payload["when_ids"], []);
  assert.deepEqual(same.ledger_event.payload["unchanged_when_ids"], [repoRuns.id]);
  assert.deepEqual(same.loop_ids, []);
  assert.equal((await kernel.getLoop(loopId)).state, "waiting");
  const afterSame = await when();
  assert.equal(afterSame?.attributes["fire_count"], 1);
  assert.equal(afterSame?.attributes["fired_at"], afterFirst?.attributes["fired_at"]);

  // A payload that does not report the watched field is no observation of it.
  const missing = await kernel.fireEvent({ event_type: "repo_runs", source: "ci", payload: { run: "x" }, idempotency_key: "obs-3" });
  assert.deepEqual(missing.loop_ids, []);
  assert.equal((await when())?.attributes["fire_count"], 1);
});

test("a changed value fires the change-condition When once and records the new value", async () => {
  const { kernel, loopId, report, when, tick } = await watchedLoop();
  await report("red", "obs-1");
  await kernel.transition(loopId, { to_state: "waiting", actor: "agent:juno", evidence, idempotency_key: "w-2" });

  tick(60);
  const changed = await report("green", "obs-2");
  assert.equal(changed.applied, true);
  assert.deepEqual(changed.ledger_event.payload["when_ids"], [repoRuns.id]);
  assert.deepEqual(changed.loop_ids, [loopId]);
  assert.equal((await kernel.getLoop(loopId)).state, "open");
  const fired = await when();
  assertValid("node", fired);
  assert.equal(fired?.attributes["fire_count"], 2);
  assert.equal(fired?.attributes["fired_at"], "2026-11-10T09:01:00.000Z");
  assert.deepEqual(fired?.attributes["change_condition"], { field: "status", last_value: "green" });

  // Once: the same delivery replays without a second firing, and the new value repeated does not fire.
  const replay = await report("green", "obs-2");
  assert.equal(replay.applied, false);
  const repeated = await report("green", "obs-3");
  assert.deepEqual(repeated.ledger_event.payload["when_ids"], []);
  assert.equal((await when())?.attributes["fire_count"], 2);

  // Structured values compare by value, not identity; null is an observed value.
  const objects = await report({ a: 1 }, "obs-4");
  assert.deepEqual(objects.ledger_event.payload["when_ids"], [repoRuns.id]);
  assert.deepEqual((await report({ a: 1 }, "obs-5")).ledger_event.payload["when_ids"], []);
  assert.deepEqual((await report(null, "obs-6")).ledger_event.payload["when_ids"], [repoRuns.id]);
  assert.deepEqual((await report(null, "obs-7")).ledger_event.payload["when_ids"], []);
});

test("a When without a change condition fires on every matching event", async () => {
  const { kernel, store } = await openLoop();
  for (const key of ["plain-1", "plain-2"]) {
    const fired = await kernel.fireEvent({ event_type: "repo_runs", source: "ci", payload: { status: "red" }, idempotency_key: key });
    assert.deepEqual(fired.ledger_event.payload["when_ids"], [repoRuns.id]);
  }
  const when = await store.read((tx) => tx.getNode(repoRuns.id));
  assert.equal(when?.attributes["fire_count"], 2);
  assert.equal(when?.attributes["change_condition"], undefined);
});

// LC-CP-SUSPEND: a suspended loop is neither armed nor closed. Its Whens are
// held -- the tick does not fire its calendar When and fire_event does not fire
// its event Whens -- until a transition resumes it to open; the resumed loop's
// next due calendar slot then fires once. Kernel, Postgres graph store and the
// tick's Postgres timer stores run unfaked against a real Compose replica.
const harness = new PgHarness("kernel-suspend");

const dailyReview: Node = {
  id: "lc_when_daily_review",
  kind: "when",
  created_at: "2026-11-10T08:00:00Z",
  status: "active",
  attributes: {
    when_type: "calendar",
    schedule: { rrule: "FREQ=DAILY", dtstart: "2026-11-11T09:00:00Z" },
    timezone: "UTC",
    next_fire_at: "2026-11-11T09:00:00Z",
  },
};

async function suspendedLoop() {
  const database = await harness.freshDatabase();
  let now = Date.parse("2026-11-10T09:00:00Z");
  let seq = 0;
  const kernel = new Kernel(new PgGraphStore(database.appPool()), {
    now: () => new Date(now),
    newId: (prefix) => `lc_${prefix}_${++seq}`,
  });
  const { loop } = await kernel.proposeLoop(
    experimentProposal({
      nodes: [...experimentProposal().nodes, dailyReview],
      edges: [...(experimentProposal().edges ?? []), { from_id: experiment.id, to_id: dailyReview.id, edge_type: "is_waiting_on" }],
    }),
  );
  await kernel.acceptLoop(loop.id, { acceptor: "joe" });
  const suspended = await kernel.transition(loop.id, {
    to_state: "suspended",
    actor: "agent:cortexplane",
    evidence,
    idempotency_key: "suspend-1",
  });
  // The production tick store (src/tick.ts) and the pooled one, acting as the app role.
  const urlStore = new UrlTimerStore({ connectionString: database.url });
    const tickStores: TimerStore[] = [urlStore, new PoolTimerStore(database.appPool())];
  const tickAt = async (iso: string, store: TimerStore = tickStores[0]!) => {
    now = Date.parse(iso);
    return runTick(store, { now: new Date(iso), newId: () => `lc_evt_tick_${++seq}` });
  };
  const nodeOf = async (id: string) => (await database.pool.query("SELECT attributes FROM nodes WHERE id = $1", [id])).rows[0]?.attributes;
  const closeAll = () => urlStore.close();
  return { kernel, loopId: loop.id, suspended, tickAt, tickStores, nodeOf, closeAll };
}

describe("suspended loops on Postgres", () => {
  before(() => harness.up(), { timeout: 300_000 });
  after(() => harness.down(), { timeout: 120_000 });

  test("a suspended loop's Whens are not fired by the tick or by fire_event", { timeout: 300_000 }, async () => {
    const { kernel, loopId, suspended, tickAt, tickStores, nodeOf, closeAll } = await suspendedLoop();
    try {
      assert.equal(suspended.applied, true);
      assertValid("loop", suspended.loop);
      assertValid("ledger-event", suspended.ledger_event);
      assert.equal(suspended.loop.state, "suspended");
      assert.deepEqual(suspended.ledger_event.payload, { from_state: "open", to_state: "suspended", evidence });

      // Not closed: open_loops still lists it, as suspended, and it can be filtered on.
      const listed = (await kernel.openLoops({})).loops.map((l) => [l.loop.id, l.loop.state, l.loop.closed_at]);
      assert.deepEqual(listed, [[loopId, "suspended", null]]);
      assert.deepEqual((await kernel.openLoops({ state: "suspended" })).loops.map((l) => l.loop.id), [loopId]);

      // Not armed: nothing it is waiting on fires next.
      assert.deepEqual((await kernel.whatFiresNext({ loop_id: loopId })).effects, []);
      assert.deepEqual((await kernel.whatFiresNext({ when_id: repoRuns.id })).effects, []);

      // The tick, past two daily slots, fires nothing and leaves the slot due.
      for (const store of tickStores) {
        const report = await tickAt("2026-11-12T09:30:00Z", store);
        assert.deepEqual(report.fired, []);
        assert.deepEqual(report.errors, []);
      }
      assert.equal((await nodeOf(dailyReview.id))?.next_fire_at, "2026-11-11T09:00:00Z");

      // fire_event by event type + source: the held When does not fire.
      const byEvent = await kernel.fireEvent({ event_type: "repo_runs", source: "ci", payload: { status: "green" }, idempotency_key: "ci-1" });
      assert.deepEqual(byEvent.ledger_event.payload["when_ids"], []);
      assert.deepEqual(byEvent.ledger_event.payload["held_when_ids"], [repoRuns.id]);
      assert.deepEqual(byEvent.loop_ids, []);
      // fire_event by when_id: refused, nothing recorded.
      await assert.rejects(kernel.fireEvent({ when_id: repoRuns.id, idempotency_key: "ci-2" }), { code: "conflict" });
      await assert.rejects(kernel.fireEvent({ when_id: resultsLand.id, idempotency_key: "results-1" }), { code: "conflict" });
      assert.equal((await nodeOf(repoRuns.id))?.fire_count, 0);
      assert.equal((await nodeOf(resultsLand.id))?.fire_count, 0);
      assert.equal((await kernel.getLoop(loopId)).state, "suspended");

      // Suspended is left only back to open; it is not a way to close or chase.
      for (const to_state of ["waiting", "chased", "closed"] as const)
        await assert.rejects(kernel.transition(loopId, { to_state, actor: "joe", evidence, idempotency_key: `x-${to_state}` }), {
          code: "conflict",
        });
    } finally {
      await closeAll();
    }
  });

  test("resuming a suspended loop fires its next due slot once", { timeout: 300_000 }, async () => {
    const { kernel, loopId, tickAt, nodeOf, closeAll } = await suspendedLoop();
    try {
      assert.deepEqual((await tickAt("2026-11-12T09:30:00Z")).fired, []);

      const resumed = await kernel.transition(loopId, { to_state: "open", actor: "agent:cortexplane", evidence, idempotency_key: "resume-1" });
      assert.equal(resumed.loop.state, "open");
      assertValid("loop", resumed.loop);
      assert.deepEqual(resumed.ledger_event.payload, { from_state: "suspended", to_state: "open", evidence });

      const first = await tickAt("2026-11-12T09:31:00Z");
      assert.deepEqual(
        first.fired.map((f) => [f.when_id, f.next_fire_at]),
        [[dailyReview.id, "2026-11-13T09:00:00.000Z"]],
        "one firing, then the schedule moves past now",
      );
      assert.equal((await nodeOf(dailyReview.id))?.next_fire_at, "2026-11-13T09:00:00.000Z");
      assert.deepEqual((await tickAt("2026-11-12T09:32:00Z")).fired, [], "the slot fires once");
      const next = await tickAt("2026-11-13T09:00:00Z");
      assert.deepEqual(next.fired.map((f) => [f.when_id, f.scheduled_for]), [[dailyReview.id, "2026-11-13T09:00:00.000Z"]]);

      // Its event Whens are armed again too.
      const fired = await kernel.fireEvent({ when_id: repoRuns.id, idempotency_key: "ci-3" });
      assert.deepEqual(fired.loop_ids, [loopId]);
    } finally {
      await closeAll();
    }
  });
});
