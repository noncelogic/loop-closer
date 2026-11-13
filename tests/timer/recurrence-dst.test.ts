// LC-M2-T1b acceptance: a recurring calendar When keeps its local wall-clock
// time across DST changes. Each next_fire_at comes from the recurrence rule
// (anchored on its dtstart) and the timezone, never from the previous firing
// instant, so a DST gap cannot shift every later occurrence.
//
// US 2026: spring-forward Sun 2026-03-08 (02:00 EST -> 03:00 EDT),
//          fall-back     Sun 2026-11-01 (02:00 EDT -> 01:00 EST).
import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryTimerStore, type TimerState } from "../../src/timer/store.ts";
import { runTick } from "../../src/timer/tick.ts";

const TZ = "America/New_York";

function storeWith(schedule: Record<string, unknown>, nextFireAt: string): InMemoryTimerStore {
  const state: TimerState = {
    nodes: [
      {
        id: "lc_when_daily",
        kind: "when",
        created_at: "2026-01-01T00:00:00Z",
        status: "active",
        attributes: { when_type: "calendar", schedule, timezone: TZ, next_fire_at: nextFireAt },
      },
    ],
    ledger: [],
    loops: [],
    ageing_policies: [],
  };
  return new InMemoryTimerStore(state);
}

/** Run the per-minute tick (every `stepMinutes`) over [from, to) and return each fired slot. */
async function tickThrough(store: InMemoryTimerStore, from: string, to: string, stepMinutes = 1): Promise<string[]> {
  let n = 0;
  const fired: string[] = [];
  for (let t = Date.parse(from); t < Date.parse(to); t += stepMinutes * 60_000) {
    const report = await runTick(store, { now: new Date(t), newId: () => `lc_evt_dst_${++n}` });
    for (const f of report.fired) fired.push(f.scheduled_for);
  }
  return fired;
}

function localTime(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(iso));
}

test("a daily 02:30 America/New_York When fires at 03:30 on the spring-forward day and at 02:30 on the following day", async () => {
  // dtstart 2026-03-01 02:30 EST.
  const store = storeWith({ rrule: "FREQ=DAILY", dtstart: "2026-03-01T07:30:00Z" }, "2026-03-07T07:30:00Z");
  const fired = await tickThrough(store, "2026-03-07T05:00:00Z", "2026-03-11T05:00:00Z", 5);
  assert.deepEqual(fired, [
    "2026-03-07T07:30:00.000Z", // Sat 02:30 EST
    "2026-03-08T07:30:00.000Z", // Sun 03:30 EDT: 02:30 does not exist
    "2026-03-09T06:30:00.000Z", // Mon 02:30 EDT: back on the rule's local time
    "2026-03-10T06:30:00.000Z", // Tue 02:30 EDT
  ]);
  assert.deepEqual(fired.map(localTime), [
    "2026-03-07, 02:30 EST",
    "2026-03-08, 03:30 EDT",
    "2026-03-09, 02:30 EDT",
    "2026-03-10, 02:30 EDT",
  ]);
  const node = store.snapshot().nodes[0]!;
  assert.equal(node.attributes["next_fire_at"], "2026-03-11T06:30:00.000Z");
});

test("a daily 01:30 America/New_York When fires exactly once on the fall-back day", async () => {
  // dtstart 2026-10-01 01:30 EDT; 01:30 occurs twice on 2026-11-01 (05:30Z EDT, 06:30Z EST).
  const store = storeWith({ rrule: "FREQ=DAILY", dtstart: "2026-10-01T05:30:00Z" }, "2026-10-31T05:30:00Z");
  const fired = await tickThrough(store, "2026-10-31T04:00:00Z", "2026-11-03T05:00:00Z");
  assert.deepEqual(fired.map(localTime), [
    "2026-10-31, 01:30 EDT",
    "2026-11-01, 01:30 EDT",
    "2026-11-02, 01:30 EST",
  ]);
  assert.equal(fired.filter((iso) => localTime(iso).startsWith("2026-11-01")).length, 1);
  // One ledger event per firing: the repeated 01:30 hour never re-fires.
  assert.equal(store.snapshot().ledger.length, 3);
});

test("a daily 02:30 America/New_York When without a dtstart keeps 02:30 across the spring-forward day", async () => {
  // No dtstart: the first firing (Sat 02:30 EST) is pinned as the anchor, so the
  // Sunday 03:30 EDT firing does not become the anchor for Monday onwards.
  const store = storeWith({ rrule: "FREQ=DAILY" }, "2026-03-07T07:30:00Z");
  const fired = await tickThrough(store, "2026-03-07T05:00:00Z", "2026-03-11T05:00:00Z", 5);
  assert.deepEqual(fired.map(localTime), [
    "2026-03-07, 02:30 EST",
    "2026-03-08, 03:30 EDT",
    "2026-03-09, 02:30 EDT",
    "2026-03-10, 02:30 EDT",
  ]);
  const node = store.snapshot().nodes[0]!;
  assert.deepEqual(node.attributes["schedule"], { rrule: "FREQ=DAILY", dtstart: "2026-03-07T07:30:00.000Z" });
  assert.equal(node.attributes["next_fire_at"], "2026-03-11T06:30:00.000Z");
});
