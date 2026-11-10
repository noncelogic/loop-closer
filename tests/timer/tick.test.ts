// LC-M2-T1 acceptance: the per-minute timer tick (TECH-STACK §6, SPEC Phase 0).
//
// A tick claims every due calendar When inside one transaction, writes a
// `when_fired` ledger event for each, advances its `next_fire_at`
// atomically, and reports loops breaching their ageing policy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createValidator, loadDomainSchemas } from "../../src/contracts/index.ts";
import { InMemoryTimerStore, type TimerState } from "../../src/timer/store.ts";
import { runTick } from "../../src/timer/tick.ts";
import { nextFireAt } from "../../src/timer/schedule.ts";

const NOW = new Date("2026-11-09T14:00:30Z");

function seed(): TimerState {
  return {
    nodes: [
      // One-off deadline, due: fires once, then disarms (next_fire_at = null).
      {
        id: "lc_when_deadline",
        kind: "when",
        created_at: "2026-11-07T15:30:00Z",
        status: "active",
        attributes: {
          when_type: "calendar",
          schedule: { at: "2026-11-09T13:00:00Z" },
          timezone: "America/New_York",
          next_fire_at: "2026-11-09T13:00:00Z",
        },
      },
      // Weekly Monday 09:00 New York, due exactly now: advances one week.
      {
        id: "lc_when_review",
        kind: "when",
        created_at: "2026-11-07T15:30:00Z",
        status: "active",
        attributes: {
          when_type: "calendar",
          schedule: { rrule: "FREQ=WEEKLY;BYDAY=MO" },
          timezone: "America/New_York",
          next_fire_at: "2026-11-09T14:00:00Z",
        },
      },
      // Daily, ticks missed for three days (pod down): fires once, skips to the next future slot.
      {
        id: "lc_when_daily",
        kind: "when",
        created_at: "2026-11-01T00:00:00Z",
        status: "active",
        attributes: {
          when_type: "calendar",
          schedule: { rrule: "FREQ=DAILY" },
          timezone: "UTC",
          next_fire_at: "2026-11-06T08:00:00Z",
        },
      },
      // Not yet due.
      {
        id: "lc_when_future",
        kind: "when",
        created_at: "2026-11-07T15:30:00Z",
        status: "active",
        attributes: {
          when_type: "calendar",
          schedule: { at: "2026-12-01T17:00:00Z" },
          timezone: "America/New_York",
          next_fire_at: "2026-12-01T17:00:00Z",
        },
      },
      // Due but tombstoned: never fires.
      {
        id: "lc_when_dead",
        kind: "when",
        created_at: "2026-11-07T15:30:00Z",
        status: "tombstoned",
        attributes: {
          when_type: "calendar",
          schedule: { at: "2026-11-08T00:00:00Z" },
          timezone: "UTC",
          next_fire_at: "2026-11-08T00:00:00Z",
        },
      },
      // Event Whens are fired by fire_event, not the clock.
      {
        id: "lc_when_reply",
        kind: "when",
        created_at: "2026-11-07T15:30:00Z",
        status: "active",
        attributes: {
          when_type: "event",
          event_type: "reply_received",
          source_binding: { source: "gmail", mechanism: "poll" },
          fired_at: null,
          fire_count: 0,
        },
      },
    ],
    ledger: [],
    loops: [
      { id: "lc_loop_stale", loop_type: "outreach", state: "waiting", state_entered_at: "2026-11-01T12:00:00Z", ageing_policy: { id: "lc_policy_ageing_outreach", version: 1 } },
      { id: "lc_loop_fresh", loop_type: "outreach", state: "waiting", state_entered_at: "2026-11-08T12:00:00Z", ageing_policy: { id: "lc_policy_ageing_outreach", version: 1 } },
      { id: "lc_loop_nolimit", loop_type: "outreach", state: "open", state_entered_at: "2026-01-01T00:00:00Z", ageing_policy: { id: "lc_policy_ageing_outreach", version: 1 } },
      { id: "lc_loop_closed", loop_type: "outreach", state: "closed", state_entered_at: "2026-01-01T00:00:00Z", ageing_policy: { id: "lc_policy_ageing_outreach", version: 1 } },
    ],
    ageing_policies: [
      // Version 2 exists but loops cite v1: the cited version governs.
      { id: "lc_policy_ageing_outreach", version: 1, max_dwell_seconds: { waiting: 3 * 86_400, chased: 86_400 } },
      { id: "lc_policy_ageing_outreach", version: 2, max_dwell_seconds: { waiting: 30 * 86_400 } },
    ],
  };
}

function idGen(): () => string {
  let n = 0;
  return () => `lc_evt_tick_${++n}`;
}

function when(store: InMemoryTimerStore, id: string): Record<string, unknown> {
  const node = store.snapshot().nodes.find((n) => n.id === id);
  assert.ok(node, id);
  return node.attributes;
}

test("tick claims due Whens in one transaction, writes ledger events and advances next fire time", async () => {
  const store = new InMemoryTimerStore(seed());
  const report = await runTick(store, { now: NOW, newId: idGen() });

  // One transaction for the whole tick.
  assert.equal(store.transactionsCommitted, 1);
  assert.equal(store.transactionsRolledBack, 0);

  // Exactly the due, active, calendar Whens were claimed and fired.
  assert.deepEqual(report.fired.map((f) => f.when_id).sort(), ["lc_when_daily", "lc_when_deadline", "lc_when_review"]);

  // One schema-valid when_fired ledger event per firing, idempotency-keyed by the scheduled slot.
  const ledger = store.snapshot().ledger;
  assert.equal(ledger.length, 3);
  const ajv = createValidator();
  const validate = ajv.getSchema(String(loadDomainSchemas().get("ledger-event")?.$id));
  assert.ok(validate);
  for (const evt of ledger) {
    assert.ok(validate(evt), ajv.errorsText(validate.errors));
    assert.equal(evt.event_type, "when_fired");
    assert.equal(evt.actor, "sensor:calendar");
    assert.equal(evt.at, NOW.toISOString());
    assert.equal(evt.subject_ids.length, 1);
  }
  const review = ledger.find((e) => e.subject_ids[0] === "lc_when_review");
  assert.ok(review);
  assert.equal(review.idempotency_key, "calendar:lc_when_review:2026-11-09T14:00:00.000Z");
  assert.equal(review.payload["scheduled_for"], "2026-11-09T14:00:00.000Z");
  assert.equal(review.payload["next_fire_at"], "2026-11-16T14:00:00.000Z");

  // next_fire_at advanced in the same transaction.
  assert.equal(when(store, "lc_when_deadline")["next_fire_at"], null);
  assert.equal(when(store, "lc_when_review")["next_fire_at"], "2026-11-16T14:00:00.000Z");
  assert.equal(when(store, "lc_when_daily")["next_fire_at"], "2026-11-10T08:00:00.000Z");
  const daily = report.fired.find((f) => f.when_id === "lc_when_daily");
  assert.equal(daily?.missed_occurrences, 3); // 11-07, 11-08, 11-09 slots skipped
  assert.equal(when(store, "lc_when_future")["next_fire_at"], "2026-12-01T17:00:00Z");
  assert.equal(when(store, "lc_when_dead")["next_fire_at"], "2026-11-08T00:00:00Z");

  // Ageing-policy breaches, judged against the cited policy version.
  assert.deepEqual(report.breaches, [
    {
      loop_id: "lc_loop_stale",
      loop_type: "outreach",
      state: "waiting",
      state_entered_at: "2026-11-01T12:00:00Z",
      age_seconds: Math.floor((NOW.getTime() - Date.parse("2026-11-01T12:00:00Z")) / 1000),
      max_dwell_seconds: 3 * 86_400,
      policy: { id: "lc_policy_ageing_outreach", version: 1 },
    },
  ]);

  // A second tick in the same minute finds nothing due: firing is not repeated.
  const again = await runTick(store, { now: NOW, newId: idGen() });
  assert.deepEqual(again.fired, []);
  assert.equal(store.snapshot().ledger.length, 3);
});

test("a failing tick rolls back every claim, event and advance", async () => {
  const store = new InMemoryTimerStore(seed());
  const before = store.snapshot();
  let n = 0;
  const newId = () => {
    if (++n === 2) throw new Error("boom");
    return `lc_evt_x_${n}`;
  };
  await assert.rejects(runTick(store, { now: NOW, newId }), /boom/);
  assert.equal(store.transactionsRolledBack, 1);
  assert.deepEqual(store.snapshot(), before);
});

test("concurrent ticks never fire the same When twice", async () => {
  const store = new InMemoryTimerStore(seed());
  const gen = idGen();
  const [a, b] = await Promise.all([runTick(store, { now: NOW, newId: gen }), runTick(store, { now: NOW, newId: gen })]);
  assert.equal(a.fired.length + b.fired.length, 3);
  assert.equal(store.snapshot().ledger.length, 3);
});

test("an unparseable schedule is reported without blocking other Whens", async () => {
  const state = seed();
  state.nodes.push({
    id: "lc_when_bad",
    kind: "when",
    created_at: "2026-11-07T15:30:00Z",
    status: "active",
    attributes: { when_type: "calendar", schedule: { rrule: "FREQ=SECONDLY" }, timezone: "UTC", next_fire_at: "2026-11-09T00:00:00Z" },
  });
  const store = new InMemoryTimerStore(state);
  const report = await runTick(store, { now: NOW, newId: idGen() });
  assert.equal(report.fired.length, 3);
  assert.equal(report.errors.length, 1);
  assert.equal(report.errors[0]?.when_id, "lc_when_bad");
  assert.equal(when(store, "lc_when_bad")["next_fire_at"], "2026-11-09T00:00:00Z");
});

test("recurrence keeps local wall-clock time across a DST change", () => {
  // 2026-11-01 is the US fall-back; 09:00 EDT = 13:00Z, 09:00 EST = 14:00Z.
  const next = nextFireAt({ rrule: "FREQ=WEEKLY;BYDAY=MO" }, "America/New_York", new Date("2026-10-26T13:00:00Z"), new Date("2026-10-26T13:00:30Z"));
  assert.equal(next.next?.toISOString(), "2026-11-02T14:00:00.000Z");
  // BYDAY with several days and an INTERVAL.
  const tue = nextFireAt({ rrule: "FREQ=WEEKLY;BYDAY=MO,TH" }, "UTC", new Date("2026-11-09T08:00:00Z"), new Date("2026-11-09T08:00:00Z"));
  assert.equal(tue.next?.toISOString(), "2026-11-12T08:00:00.000Z");
  const hourly = nextFireAt({ rrule: "FREQ=HOURLY;INTERVAL=2" }, "UTC", new Date("2026-11-09T08:00:00Z"), new Date("2026-11-09T08:00:00Z"));
  assert.equal(hourly.next?.toISOString(), "2026-11-09T10:00:00.000Z");
  const until = nextFireAt({ rrule: "FREQ=DAILY;UNTIL=20261110T000000Z" }, "UTC", new Date("2026-11-09T08:00:00Z"), new Date("2026-11-09T08:00:00Z"));
  assert.equal(until.next, null);
});
