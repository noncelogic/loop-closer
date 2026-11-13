// Sensor sources (SPEC Phase 0 "timer loop + sensors"): the adapters that turn
// one external source into fire_events through the sensor framework.
//
// - CalendarSource: time itself. Each poll fires every due calendar When in
//   the graph (idempotency-keyed by its scheduled slot, as the timer tick does)
//   and advances its next_fire_at.
// - PortalReadSource: a scheduled read of a portal with no API (the Anthropic
//   listings check is the canonical instance). Each poll reads the portal,
//   compares every subject's status with the last one this sensor recorded in
//   the ledger, and emits a fire_event per change.
//
// Every successful poll heartbeats, whether or not the world changed. A poll
// that cannot see the world (a failed portal read) does not, so the framework
// records the sensor as silent: a dead sensor looks different from a quiet one.
import { KernelError } from "../kernel/kernel.ts";
import type { GraphStore, GraphTx } from "../kernel/store.ts";
import type { Node } from "../kernel/types.ts";
import { nextFireAt, parseSchedule } from "../timer/schedule.ts";
import type { Sensor, SensorDefinition, SensorFramework } from "./framework.ts";

export const CALENDAR_SENSOR: SensorDefinition = {
  id: "calendar",
  source_binding: { source: "calendar", mechanism: "poll" },
  heartbeat: { interval_seconds: 60, grace_seconds: 120 },
};

/** No listings API exists: the sensor reads the portal on a schedule. */
export const ANTHROPIC_LISTINGS_SENSOR: SensorDefinition = {
  id: "anthropic_listings",
  source_binding: { source: "anthropic_listings", mechanism: "poll" },
  heartbeat: { interval_seconds: 6 * 3600, grace_seconds: 3600 },
};

export const LISTING_STATUS_CHANGED = "listing_status_changed";

export interface SourceOptions {
  now?: () => Date;
}

export interface CalendarFiring {
  when_id: string;
  event_id: string;
  applied: boolean;
  scheduled_for: string;
  next_fire_at: string | null;
  missed_occurrences: number;
}

export interface SourceError {
  subject: string;
  error: string;
}

export interface CalendarPollReport {
  fired: CalendarFiring[];
  /** Due Whens whose schedule could not be evaluated; left due so they stay visible. */
  errors: SourceError[];
  heartbeat: boolean;
}

export class CalendarSource {
  readonly sensor: Sensor;
  readonly #store: GraphStore;
  readonly #now: () => Date;

  private constructor(sensor: Sensor, store: GraphStore, now: () => Date) {
    this.sensor = sensor;
    this.#store = store;
    this.#now = now;
  }

  static async register(
    framework: SensorFramework,
    store: GraphStore,
    options: SourceOptions & { definition?: SensorDefinition } = {},
  ): Promise<CalendarSource> {
    const sensor = await framework.register(options.definition ?? CALENDAR_SENSOR);
    return new CalendarSource(sensor, store, options.now ?? (() => new Date()));
  }

  async poll(): Promise<CalendarPollReport> {
    const now = this.#now();
    const due = await this.#store.read((tx) => dueCalendarWhens(tx, now));
    const fired: CalendarFiring[] = [];
    const errors: SourceError[] = [];
    for (const when of due) {
      const scheduledFor = when.attributes["next_fire_at"] as string;
      let advance;
      try {
        const timezone = when.attributes["timezone"];
        if (typeof timezone !== "string") throw new Error(`invalid timezone ${JSON.stringify(timezone)}`);
        advance = nextFireAt(parseSchedule(when.attributes["schedule"]), timezone, new Date(scheduledFor), now);
      } catch (err) {
        errors.push({ subject: when.id, error: message(err) });
        continue;
      }
      const slot = new Date(scheduledFor).toISOString();
      const next = advance.next?.toISOString() ?? null;
      const result = await this.sensor.fireWhen({
        when_id: when.id,
        idempotency_key: `calendar:${when.id}:${slot}`,
        payload: { scheduled_for: slot, next_fire_at: next, missed_occurrences: advance.missed },
      });
      // Advance only if nobody else moved it meanwhile. A crash between the
      // firing and this write re-fires the same slot key next poll: a no-op.
      await this.#store.transaction((tx) => {
        const current = tx.getNode(when.id);
        if (current?.attributes["next_fire_at"] !== scheduledFor) return;
        const pinned = advance.schedule ? { schedule: advance.schedule } : {};
        tx.putNode({ ...current, attributes: { ...current.attributes, next_fire_at: next, ...pinned } });
      });
      fired.push({
        when_id: when.id,
        event_id: result.ledger_event.id,
        applied: result.applied,
        scheduled_for: slot,
        next_fire_at: next,
        missed_occurrences: advance.missed,
      });
    }
    await this.sensor.heartbeat();
    return { fired, errors, heartbeat: true };
  }
}

function dueCalendarWhens(tx: GraphTx, now: Date): Node[] {
  return tx
    .listNodes()
    .filter((n) => {
      const next = n.attributes["next_fire_at"];
      return (
        n.kind === "when" &&
        n.status === "active" &&
        n.attributes["when_type"] === "calendar" &&
        typeof next === "string" &&
        Date.parse(next) <= now.getTime()
      );
    })
    .sort((a, b) => Date.parse(a.attributes["next_fire_at"] as string) - Date.parse(b.attributes["next_fire_at"] as string) || a.id.localeCompare(b.id));
}

/** One subject as read off the portal page (e.g. a listing and its review status). */
export interface PortalObservation {
  subject: string;
  status: string;
  /** Other public fields read alongside the status (carried in the event payload). */
  fields?: Record<string, unknown>;
}

export interface PortalReadConfig {
  /** Event type emitted on a status change; Whens bind to it from the sensor's source. */
  event_type: string;
  /** The scheduled read. Throwing means the sensor could not see the portal. */
  read: () => Promise<PortalObservation[]>;
}

export interface PortalChange {
  subject: string;
  from: string | null;
  to: string;
  event_id: string;
  applied: boolean;
}

export interface PortalPollReport {
  changes: PortalChange[];
  /** Changes no When is bound to yet; not recorded, so they are seen again next poll. */
  unbound: Array<{ subject: string; from: string | null; to: string }>;
  heartbeat: boolean;
  /** Set when the read failed; no heartbeat is recorded then. */
  error?: string;
}

export class PortalReadSource {
  readonly sensor: Sensor;
  readonly #store: GraphStore;
  readonly #config: PortalReadConfig;

  private constructor(sensor: Sensor, store: GraphStore, config: PortalReadConfig) {
    this.sensor = sensor;
    this.#store = store;
    this.#config = config;
  }

  static async register(
    framework: SensorFramework,
    store: GraphStore,
    definition: SensorDefinition,
    config: PortalReadConfig,
  ): Promise<PortalReadSource> {
    const sensor = await framework.register(definition);
    return new PortalReadSource(sensor, store, config);
  }

  async poll(): Promise<PortalPollReport> {
    let observations: PortalObservation[];
    try {
      observations = await this.#config.read();
    } catch (err) {
      return { changes: [], unbound: [], heartbeat: false, error: message(err) };
    }
    const changes: PortalChange[] = [];
    const unbound: PortalPollReport["unbound"] = [];
    for (const obs of observations) {
      const last = await this.#store.read((tx) => this.#lastRecorded(tx, obs.subject));
      if (last?.status === obs.status) continue;
      const from = last?.status ?? null;
      const payload: Record<string, unknown> = { subject: obs.subject, from, to: obs.status };
      if (obs.fields !== undefined) payload["fields"] = obs.fields;
      try {
        const result = await this.sensor.emit({
          event_type: this.#config.event_type,
          // Keyed by the change it follows, so a status that later recurs is a new change.
          idempotency_key: `${this.sensor.id}:${obs.subject}:${last?.event_id ?? "first"}:${obs.status}`,
          payload,
        });
        changes.push({ subject: obs.subject, from, to: obs.status, event_id: result.ledger_event.id, applied: result.applied });
      } catch (err) {
        if (!(err instanceof KernelError && err.code === "not_found")) throw err;
        unbound.push({ subject: obs.subject, from, to: obs.status });
      }
    }
    await this.sensor.heartbeat();
    return { changes, unbound, heartbeat: true };
  }

  /** The latest status change this sensor recorded for `subject`. */
  #lastRecorded(tx: GraphTx, subject: string): { status: string; event_id: string } | undefined {
    const ledger = tx.ledger();
    for (let i = ledger.length - 1; i >= 0; i--) {
      const e = ledger[i]!;
      if (e.event_type !== "when_fired" || e.actor !== this.sensor.actor || e.payload["event_type"] !== this.#config.event_type) continue;
      const p = e.payload["event_payload"] as Record<string, unknown> | undefined;
      if (p?.["subject"] === subject && typeof p["to"] === "string") return { status: p["to"], event_id: e.id };
    }
    return undefined;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
