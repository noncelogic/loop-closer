// The timer loop tick (TECH-STACK §6, SPEC Phase 0 "timer loop + sensors").
//
// Run once a minute (AKS CronJob). In one transaction it claims every due
// calendar When, writes a `when_fired` ledger event for each and advances its
// `next_fire_at`, then reports loops breaching their ageing policy. Missed
// ticks self-heal: due is due whenever the next tick runs, and each firing is
// idempotency-keyed by its scheduled slot so it can never be recorded twice.
import { nextFireAt, parseSchedule } from "./schedule.ts";
import type { AgeingPolicy, LoopAgeingRow, LoopState, PolicyRef, TimerStore } from "./store.ts";

export const CALENDAR_SENSOR_ACTOR = "sensor:calendar";

export interface TickOptions {
  readonly now: Date;
  /** Ledger event id generator (lc_…). */
  readonly newId: () => string;
  readonly actor?: string;
}

export interface FiredWhen {
  readonly when_id: string;
  readonly event_id: string;
  readonly scheduled_for: string;
  readonly next_fire_at: string | null;
  readonly missed_occurrences: number;
}

export interface AgeingBreach {
  readonly loop_id: string;
  readonly loop_type: string;
  readonly state: LoopState;
  readonly state_entered_at: string;
  readonly age_seconds: number;
  readonly max_dwell_seconds: number;
  readonly policy: PolicyRef;
}

export interface TickError {
  readonly when_id: string;
  readonly error: string;
}

export interface TickReport {
  readonly at: string;
  readonly fired: FiredWhen[];
  readonly breaches: AgeingBreach[];
  /** Due Whens whose schedule could not be evaluated; left untouched (still due) so they stay visible. */
  readonly errors: TickError[];
}

export async function runTick(store: TimerStore, opts: TickOptions): Promise<TickReport> {
  const { now, newId } = opts;
  const actor = opts.actor ?? CALENDAR_SENSOR_ACTOR;
  const at = now.toISOString();

  return store.transaction(async (tx) => {
    const fired: FiredWhen[] = [];
    const errors: TickError[] = [];

    for (const when of await tx.claimDueCalendarWhens(now)) {
      const scheduled = new Date(when.next_fire_at);
      let advance;
      try {
        if (typeof when.timezone !== "string") throw new Error(`invalid timezone ${JSON.stringify(when.timezone)}`);
        advance = nextFireAt(parseSchedule(when.schedule), when.timezone, scheduled, now);
      } catch (err) {
        errors.push({ when_id: when.id, error: err instanceof Error ? err.message : String(err) });
        continue;
      }
      const scheduledFor = scheduled.toISOString();
      const next = advance.next?.toISOString() ?? null;
      const eventId = newId();
      await tx.appendLedgerEvent({
        id: eventId,
        at,
        actor,
        event_type: "when_fired",
        subject_ids: [when.id],
        payload: { scheduled_for: scheduledFor, next_fire_at: next, missed_occurrences: advance.missed },
        idempotency_key: `calendar:${when.id}:${scheduledFor}`,
      });
      await tx.setNextFireAt(when.id, next);
      fired.push({ when_id: when.id, event_id: eventId, scheduled_for: scheduledFor, next_fire_at: next, missed_occurrences: advance.missed });
    }

    const breaches = findAgeingBreaches(await tx.listOpenLoopsForAgeing(), now);
    return { at, fired, breaches, errors };
  });
}

/** Loops whose dwell in their current state exceeds the threshold their cited ageing policy sets for it. */
export function findAgeingBreaches(
  rows: ReadonlyArray<{ loop: LoopAgeingRow; policy: AgeingPolicy | null }>,
  now: Date,
): AgeingBreach[] {
  const breaches: AgeingBreach[] = [];
  for (const { loop, policy } of rows) {
    const max = policy?.max_dwell_seconds[loop.state];
    if (max === undefined) continue;
    const age = Math.floor((now.getTime() - Date.parse(loop.state_entered_at)) / 1000);
    if (age > max) {
      breaches.push({
        loop_id: loop.id,
        loop_type: loop.loop_type,
        state: loop.state,
        state_entered_at: loop.state_entered_at,
        age_seconds: age,
        max_dwell_seconds: max,
        policy: { id: loop.ageing_policy.id, version: loop.ageing_policy.version },
      });
    }
  }
  return breaches.sort((a, b) => b.age_seconds - a.age_seconds || a.loop_id.localeCompare(b.loop_id));
}
