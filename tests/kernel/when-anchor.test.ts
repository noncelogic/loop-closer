// LC-M2-T1c acceptance: a recurring calendar When written without a dtstart is
// stored with its first local wall-clock firing (its next_fire_at, read in its
// own timezone) as its recurrence anchor, so no reader of the schedule derives
// the anchor from its last firing.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Node } from "../../src/kernel/index.ts";
import { assertValid, experiment, experimentProposal, joe, newKernel } from "./fixtures.ts";

const TZ = "America/New_York";

function calendarWhen(schedule: Record<string, unknown>, nextFireAt: string): Node {
  return {
    id: "lc_when_daily_check",
    kind: "when",
    created_at: "2026-11-10T08:00:00Z",
    status: "active",
    attributes: { when_type: "calendar", schedule, timezone: TZ, next_fire_at: nextFireAt },
  };
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

async function write(when: Node) {
  const env = newKernel();
  await env.kernel.proposeLoop(
    experimentProposal({ nodes: [joe, experiment, when], edges: [], closing_when_id: when.id }),
  );
  const stored = await env.store.read((tx) => tx.getNode(when.id));
  assert.ok(stored, "the When is stored");
  assertValid("node", stored);
  return { ...env, stored };
}

test("a daily 02:30 America/New_York When written without dtstart is stored with a 02:30 local anchor", async () => {
  // First firing: Sat 2026-03-07 02:30 EST, the day before spring-forward.
  const when = calendarWhen({ rrule: "FREQ=DAILY" }, "2026-03-07T07:30:00Z");
  const { kernel, stored } = await write(when);
  const schedule = stored.attributes["schedule"] as { rrule: string; dtstart?: string };
  assert.equal(schedule.rrule, "FREQ=DAILY");
  assert.equal(typeof schedule.dtstart, "string", "the recurrence anchor is stored with the When");
  assert.equal(localTime(schedule.dtstart!), "2026-03-07, 02:30 EST");
  assert.equal(stored.attributes["next_fire_at"], "2026-03-07T07:30:00Z");

  // Re-proposing the same When by value is the same node, not a conflict.
  await assert.rejects(
    kernel.proposeLoop(experimentProposal({ nodes: [joe, experiment, when], edges: [], closing_when_id: when.id })),
    { code: "duplicate_loop" },
  );
});

test("a recurring When written with a dtstart keeps that dtstart unchanged", async () => {
  // dtstart 2026-03-01 02:30 EST; first firing later than dtstart.
  const schedule = { rrule: "FREQ=DAILY", dtstart: "2026-03-01T07:30:00Z" };
  const { stored } = await write(calendarWhen(schedule, "2026-03-09T06:30:00Z"));
  assert.deepEqual(stored.attributes["schedule"], schedule);
});
