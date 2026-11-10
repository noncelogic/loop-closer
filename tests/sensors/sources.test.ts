// LC-M2-T3 acceptance: the first two sensor sources. The calendar source (time
// itself) and a scheduled portal-read source (the Anthropic listings check: no
// API exists, so the sensor is a scheduled read) each drive real fire_events
// through the sensor framework into the graph.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertValid, joe, newKernel } from "../kernel/fixtures.ts";
import type { Node } from "../../src/kernel/index.ts";
import {
  ANTHROPIC_LISTINGS_SENSOR,
  CalendarSource,
  LISTING_STATUS_CHANGED,
  PortalReadSource,
  SensorFramework,
  type PortalObservation,
} from "../../src/sensors/index.ts";

const START = Date.parse("2026-11-10T09:00:00Z");

function clock(env: ReturnType<typeof newKernel>) {
  let elapsed = 0;
  return {
    now: () => new Date(START + elapsed * 1000),
    advance: (seconds: number) => {
      elapsed += seconds;
      env.tick(seconds);
    },
  };
}

const followUpDue: Node = {
  id: "lc_when_follow_up_due",
  kind: "when",
  created_at: "2026-11-10T08:00:00Z",
  status: "active",
  attributes: {
    when_type: "calendar",
    schedule: { rrule: "FREQ=DAILY" },
    timezone: "America/New_York",
    next_fire_at: "2026-11-10T09:30:00.000Z",
  },
};

const followUp: Node = {
  id: "lc_what_follow_up",
  kind: "what",
  created_at: "2026-11-10T08:00:00Z",
  status: "active",
  attributes: { what_type: "action", title: "Follow up on the paper's authors" },
};

const listingStatusChanged: Node = {
  id: "lc_when_listing_status_changed",
  kind: "when",
  created_at: "2026-11-10T08:00:00Z",
  status: "active",
  attributes: {
    when_type: "event",
    event_type: LISTING_STATUS_CHANGED,
    source_binding: { source: ANTHROPIC_LISTINGS_SENSOR.source_binding.source, mechanism: "poll" },
    fired_at: null,
    fire_count: 0,
  },
};

const listing: Node = {
  id: "lc_what_rove_connector_listing",
  kind: "what",
  created_at: "2026-11-10T08:00:00Z",
  status: "active",
  attributes: { what_type: "artifact", title: "Rove connector listing" },
};

async function waitingLoop(env: ReturnType<typeof newKernel>, what: Node, when: Node, key: string) {
  const { loop } = await env.kernel.proposeLoop({
    name: `Chase ${what.attributes["title"]}`,
    loop_type: "directory-listing",
    accountable_who_id: joe.id,
    nodes: [joe, what, when],
    edges: [{ from_id: what.id, to_id: when.id, edge_type: "is_waiting_on" }],
    actor: "agent:juno",
    rationale: "Nothing else is tracking it.",
  });
  await env.kernel.acceptLoop(loop.id, { acceptor: "joe" });
  return {
    loopId: loop.id,
    wait: () =>
      env.kernel.transition(loop.id, {
        to_state: "waiting",
        actor: "agent:juno",
        evidence: { kind: "communication", id: `lc_comm_${key}` },
        idempotency_key: `wait-${key}`,
      }),
  };
}

test("calendar and portal-read sources each drive a fire_event through the framework", async (t) => {
  await t.test("calendar source", async () => {
    const env = newKernel();
    const { now, advance } = clock(env);
    const { loopId, wait } = await waitingLoop(env, followUp, followUpDue, "cal");
    await wait();
    const framework = new SensorFramework(env.kernel, env.store, { now });
    const calendar = await CalendarSource.register(framework, env.store, { now });
    assert.equal(calendar.sensor.actor, "sensor:calendar");

    // Not yet due: nothing fires, but the sensor still heartbeats (a quiet world, not a dead sensor).
    advance(10 * 60);
    const quiet = await calendar.poll();
    assert.deepEqual(quiet.fired, []);
    assert.equal(quiet.heartbeat, true);
    assert.equal((await env.kernel.getLoop(loopId)).state, "waiting");

    // Past due: the calendar When fires through the framework and the waiting loop re-opens.
    advance(21 * 60);
    const report = await calendar.poll();
    assert.equal(report.fired.length, 1);
    const [fired] = report.fired;
    assert.ok(fired);
    assert.equal(fired.when_id, followUpDue.id);
    assert.equal(fired.scheduled_for, "2026-11-10T09:30:00.000Z");
    assert.equal(fired.next_fire_at, "2026-11-11T09:30:00.000Z");
    assert.equal(fired.applied, true);
    const event = (await env.store.read((tx) => tx.ledger())).find((e) => e.id === fired.event_id);
    assert.ok(event);
    assertValid("ledger-event", event);
    assert.equal(event.event_type, "when_fired");
    assert.equal(event.actor, "sensor:calendar");
    assert.deepEqual(event.subject_ids, [followUpDue.id, loopId]);
    assert.deepEqual(event.payload["event_payload"], {
      scheduled_for: "2026-11-10T09:30:00.000Z",
      next_fire_at: "2026-11-11T09:30:00.000Z",
      missed_occurrences: 0,
    });
    assert.equal((await env.kernel.getLoop(loopId)).state, "open");
    const advanced = await env.store.read((tx) => tx.getNode(followUpDue.id));
    assert.ok(advanced);
    assertValid("node", advanced);
    assert.equal(advanced.attributes["next_fire_at"], "2026-11-11T09:30:00.000Z");

    // The slot fires once: polling again before the next occurrence is quiet.
    advance(60);
    assert.deepEqual((await calendar.poll()).fired, []);
    const beat = await env.store.read((tx) => tx.getNode(calendar.sensor.heartbeat_when_id));
    assert.equal(beat?.attributes["fired_at"], now().toISOString());
  });

  await t.test("portal-read source (Anthropic listings)", async () => {
    const env = newKernel();
    const { now, advance } = clock(env);
    const { loopId, wait } = await waitingLoop(env, listing, listingStatusChanged, "listing");

    // The portal has no API: the reader is a scheduled read of the page.
    let page: PortalObservation[] = [{ subject: "rove-connector", status: "in_review", fields: { version: "1.2.0" } }];
    let reads = 0;
    const framework = new SensorFramework(env.kernel, env.store, { now });
    const listings = await PortalReadSource.register(framework, env.store, ANTHROPIC_LISTINGS_SENSOR, {
      event_type: LISTING_STATUS_CHANGED,
      read: async () => {
        reads++;
        return page;
      },
    });
    assert.equal(listings.sensor.actor, "sensor:anthropic_listings");
    assert.equal(listings.sensor.source_binding.mechanism, "poll");

    // First read: the status is new to the graph, so it is recorded as a fire_event.
    const first = await listings.poll();
    assert.equal(reads, 1);
    assert.equal(first.heartbeat, true);
    assert.deepEqual(first.changes.map((c) => [c.subject, c.from, c.to, c.applied]), [["rove-connector", null, "in_review", true]]);

    await wait();
    // Unchanged on the next scheduled read: no event, only a heartbeat.
    advance(6 * 3600);
    const unchanged = await listings.poll();
    assert.deepEqual(unchanged.changes, []);
    assert.equal(unchanged.heartbeat, true);
    assert.equal((await env.kernel.getLoop(loopId)).state, "waiting");

    // The listing goes live: a fire_event through the framework re-opens the waiting loop.
    advance(6 * 3600);
    page = [{ subject: "rove-connector", status: "live", fields: { version: "1.2.0" } }];
    const live = await listings.poll();
    assert.equal(live.changes.length, 1);
    const [change] = live.changes;
    assert.ok(change);
    assert.equal(change.from, "in_review");
    assert.equal(change.to, "live");
    const event = (await env.store.read((tx) => tx.ledger())).find((e) => e.id === change.event_id);
    assert.ok(event);
    assertValid("ledger-event", event);
    assert.equal(event.event_type, "when_fired");
    assert.equal(event.actor, "sensor:anthropic_listings");
    assert.deepEqual(event.subject_ids, [listingStatusChanged.id, loopId]);
    assert.equal(event.payload["event_type"], LISTING_STATUS_CHANGED);
    assert.equal(event.payload["source"], "anthropic_listings");
    assert.deepEqual(event.payload["event_payload"], {
      subject: "rove-connector",
      from: "in_review",
      to: "live",
      fields: { version: "1.2.0" },
    });
    assert.equal((await env.kernel.getLoop(loopId)).state, "open");
    const when = await env.store.read((tx) => tx.getNode(listingStatusChanged.id));
    assert.equal(when?.attributes["fire_count"], 2);

    // A failed read is not a heartbeat: the sensor goes silent and its miss is recorded.
    advance(6 * 3600);
    const failing = await PortalReadSource.register(framework, env.store, ANTHROPIC_LISTINGS_SENSOR, {
      event_type: LISTING_STATUS_CHANGED,
      read: async () => {
        throw new Error("portal login page changed");
      },
    });
    const failed = await failing.poll();
    assert.equal(failed.heartbeat, false);
    assert.match(failed.error ?? "", /portal login page changed/);
    advance(ANTHROPIC_LISTINGS_SENSOR.heartbeat.interval_seconds + (ANTHROPIC_LISTINGS_SENSOR.heartbeat.grace_seconds ?? 0));
    const missed = await framework.checkHeartbeats();
    assert.deepEqual(missed.map((m) => m.sensor_id), ["anthropic_listings"]);
  });
});
