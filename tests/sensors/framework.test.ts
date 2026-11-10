// LC-M2-T2 acceptance: the sensor framework (SPEC Phase 0 "timer loop +
// sensors"). A sensor registers a source binding, turns outside changes into
// `fire_event` calls into the graph, and heartbeats on its reporting schedule;
// a sensor that misses its heartbeat is itself recorded as a graph event, so a
// dead sensor looks different from a quiet world.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertValid, experimentProposal, newKernel, repoRuns } from "../kernel/fixtures.ts";
import { SensorError, SensorFramework } from "../../src/sensors/index.ts";

const START = Date.parse("2026-11-10T09:00:00Z");

async function setup() {
  const env = newKernel();
  const { loop } = await env.kernel.proposeLoop(experimentProposal());
  await env.kernel.acceptLoop(loop.id, { acceptor: "joe" });
  await env.kernel.transition(loop.id, {
    to_state: "waiting",
    actor: "agent:juno",
    evidence: { kind: "communication", id: "lc_comm_1" },
    idempotency_key: "t-wait",
  });
  let elapsed = 0;
  const now = () => new Date(START + elapsed * 1000);
  const advance = (seconds: number) => {
    elapsed += seconds;
    env.tick(seconds);
  };
  const sensors = new SensorFramework(env.kernel, env.store, { now });
  return { ...env, loopId: loop.id, sensors, advance };
}

test("sensor emits fire_event into the graph and a missed heartbeat is recorded as a graph event", async () => {
  const { kernel, store, loopId, sensors, advance } = await setup();

  // Registration stores the sensor's source binding and its heartbeat Whens in the graph.
  const ci = await sensors.register({
    id: "ci",
    source_binding: { source: "ci", mechanism: "webhook" },
    heartbeat: { interval_seconds: 300, grace_seconds: 60 },
  });
  assert.equal(ci.actor, "sensor:ci");
  const registered = await store.read((tx) => [tx.getNode(ci.heartbeat_when_id), tx.getNode(ci.missed_heartbeat_when_id)]);
  for (const node of registered) {
    assert.ok(node);
    assertValid("node", node);
    assert.equal(node.kind, "when");
  }
  assert.equal(registered[0]?.attributes["event_type"], "sensor_heartbeat");
  assert.equal(registered[1]?.attributes["event_type"], "sensor_heartbeat_missed");
  assert.deepEqual((registered[1]?.attributes["source_binding"] as { config: unknown }).config, {
    sensor_id: "ci",
    heartbeat_interval_seconds: 300,
    heartbeat_grace_seconds: 60,
  });

  // Re-registering the same sensor is idempotent.
  const again = await sensors.register({
    id: "ci",
    source_binding: { source: "ci", mechanism: "webhook" },
    heartbeat: { interval_seconds: 300, grace_seconds: 60 },
  });
  assert.equal(again.heartbeat_when_id, ci.heartbeat_when_id);

  // The sensor emits a fire_event bound through its source: the waiting loop re-opens.
  advance(30);
  const fired = await ci.emit({ event_type: "repo_runs", idempotency_key: "ci:run:42", payload: { run: 42 } });
  assert.equal(fired.applied, true);
  assertValid("ledger-event", fired.ledger_event);
  assert.equal(fired.ledger_event.event_type, "when_fired");
  assert.equal(fired.ledger_event.actor, "sensor:ci");
  assert.deepEqual(fired.ledger_event.payload["when_ids"], [repoRuns.id]);
  assert.deepEqual(fired.loop_ids, [loopId]);
  assert.equal((await kernel.getLoop(loopId)).state, "open");
  // Redelivery of the same outside change applies once.
  assert.equal((await ci.emit({ event_type: "repo_runs", idempotency_key: "ci:run:42", payload: { run: 42 } })).applied, false);

  // A heartbeat on schedule is recorded in the graph; nothing is missed.
  advance(270);
  const beat = await ci.heartbeat();
  assertValid("ledger-event", beat.ledger_event);
  assert.deepEqual(beat.ledger_event.subject_ids, [ci.heartbeat_when_id]);
  advance(300 + 60);
  assert.deepEqual(await sensors.checkHeartbeats(), []);

  // Silence past interval + grace: the missed heartbeat is itself a graph event.
  advance(1);
  const missed = await sensors.checkHeartbeats();
  assert.equal(missed.length, 1);
  const [m] = missed;
  assert.ok(m);
  assert.equal(m.sensor_id, "ci");
  assert.equal(m.last_heartbeat_at, "2026-11-10T09:05:00.000Z");
  assert.equal(m.expected_by, "2026-11-10T09:10:00.000Z");
  assert.equal(m.missed_intervals, 1);
  const ledger = await store.read((tx) => tx.ledger());
  const recorded = ledger.find((e) => e.id === m.event_id);
  assert.ok(recorded);
  assertValid("ledger-event", recorded);
  assert.equal(recorded.event_type, "when_fired");
  assert.deepEqual(recorded.subject_ids, [ci.missed_heartbeat_when_id]);
  assert.equal(recorded.actor, "system:sensor_heartbeat");
  assert.deepEqual(recorded.payload["event_payload"], {
    sensor_id: "ci",
    last_heartbeat_at: "2026-11-10T09:05:00.000Z",
    expected_by: "2026-11-10T09:10:00.000Z",
    missed_intervals: 1,
  });
  const missedWhen = await store.read((tx) => tx.getNode(ci.missed_heartbeat_when_id));
  assert.equal(missedWhen?.attributes["fire_count"], 1);

  // The same missed slot is recorded once, however often the check runs.
  advance(10);
  assert.deepEqual(await sensors.checkHeartbeats(), []);

  // Still silent a whole interval later: the next missed slot is recorded too.
  advance(300);
  const later = await sensors.checkHeartbeats();
  assert.equal(later.length, 1);
  assert.equal(later[0]?.missed_intervals, 2);
  assert.equal(later[0]?.expected_by, "2026-11-10T09:15:00.000Z");

  // A heartbeat brings the sensor back; checks are quiet again.
  await ci.heartbeat();
  assert.deepEqual(await sensors.checkHeartbeats(), []);
});

test("missed heartbeats are found from the graph alone, without the sensor re-registering", async () => {
  const { kernel, store, sensors, advance } = await setup();
  await sensors.register({
    id: "gmail",
    source_binding: { source: "gmail", mechanism: "poll" },
    heartbeat: { interval_seconds: 600 },
  });

  // A fresh framework (e.g. the next CronJob run) with nothing registered still sees the dead sensor.
  advance(601);
  const fresh = new SensorFramework(kernel, store, { now: () => new Date(START + 601 * 1000) });
  const missed = await fresh.checkHeartbeats();
  assert.deepEqual(missed.map((m) => [m.sensor_id, m.missed_intervals, m.last_heartbeat_at]), [
    ["gmail", 1, "2026-11-10T09:00:00.000Z"],
  ]);
});

test("registration rejects malformed sensors", async () => {
  const { sensors } = await setup();
  await assert.rejects(
    sensors.register({ id: "Bad Id", source_binding: { source: "x", mechanism: "poll" }, heartbeat: { interval_seconds: 60 } }),
    SensorError,
  );
  await assert.rejects(
    sensors.register({ id: "x", source_binding: { source: "x", mechanism: "poll" }, heartbeat: { interval_seconds: 0 } }),
    SensorError,
  );
  await assert.rejects(
    sensors.register({ id: "x", source_binding: { source: "", mechanism: "poll" }, heartbeat: { interval_seconds: 60 } }),
    SensorError,
  );
});
