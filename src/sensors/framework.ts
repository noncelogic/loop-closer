// Sensor framework (SPEC Phase 0 "timer loop + sensors", TECH-STACK §6).
//
// A sensor is one per external source: it registers the source binding it
// reports through, turns each outside change into a `fire_event` into the
// graph, and heartbeats on its reporting schedule. Polling-based detection
// makes silence read as health, so every sensor carries a heartbeat and a
// sensor that has not reported on schedule is itself recorded as a graph
// event — a dead sensor must look different from a quiet world.
//
// Both heartbeats and missed heartbeats live in the graph as event Whens owned
// by the sensor (no new record types): `sensor_heartbeat` fires on every
// heartbeat (its `fired_at` is the last report), `sensor_heartbeat_missed`
// fires once per reporting slot the sensor stays silent past. The schedule is
// kept in the missed-heartbeat When's source_binding.config, so
// checkHeartbeats() needs nothing but the graph.
import { createValidator, SCHEMA_ID_BASE } from "../contracts/index.ts";
import type { Kernel } from "../kernel/kernel.ts";
import type { GraphStore, GraphTx } from "../kernel/store.ts";
import type { FireEventResult, Node } from "../kernel/types.ts";

export const HEARTBEAT_EVENT_TYPE = "sensor_heartbeat";
export const MISSED_HEARTBEAT_EVENT_TYPE = "sensor_heartbeat_missed";
export const HEARTBEAT_MONITOR_ACTOR = "system:sensor_heartbeat";

const SENSOR_ID = /^[a-z][a-z0-9_-]*$/;

export type SourceMechanism = "webhook" | "poll" | "manual";

export interface SourceBinding {
  /** The system the sensor reports for; event Whens bind to it by `source_binding.source`. */
  source: string;
  mechanism: SourceMechanism;
}

export interface SensorDefinition {
  /** Stable sensor name (`ci`, `gmail`, …); the sensor acts as `sensor:<id>`. */
  id: string;
  source_binding: SourceBinding;
  heartbeat: {
    /** The sensor must report at least once per interval. */
    interval_seconds: number;
    /** Slack past each interval before silence counts as missed. Default 0. */
    grace_seconds?: number;
  };
}

export interface EmitInput {
  event_type: string;
  /** Unique per outside change (e.g. `ci:run:42`): redelivery applies once. */
  idempotency_key: string;
  payload?: Record<string, unknown>;
}

export interface MissedHeartbeat {
  sensor_id: string;
  when_id: string;
  event_id: string;
  last_heartbeat_at: string;
  /** End of the latest reporting slot that passed without a heartbeat. */
  expected_by: string;
  /** Whole reporting intervals elapsed since the last heartbeat (beyond grace). */
  missed_intervals: number;
}

export interface SensorFrameworkOptions {
  now?: () => Date;
}

export class SensorError extends Error {
  override name = "SensorError";
}

/** A registered sensor: what a source adapter (webhook handler, poller) calls. */
export class Sensor {
  readonly id: string;
  readonly actor: string;
  readonly source_binding: SourceBinding;
  readonly heartbeat_when_id: string;
  readonly missed_heartbeat_when_id: string;
  readonly #kernel: Kernel;
  readonly #now: () => Date;

  constructor(kernel: Kernel, def: SensorDefinition, now: () => Date) {
    this.#kernel = kernel;
    this.#now = now;
    this.id = def.id;
    this.actor = sensorActor(def.id);
    this.source_binding = { ...def.source_binding };
    this.heartbeat_when_id = heartbeatWhenId(def.id);
    this.missed_heartbeat_when_id = missedHeartbeatWhenId(def.id);
  }

  /** Turns an outside change into a fire_event on every When bound to event_type from this sensor's source. */
  emit(input: EmitInput): Promise<FireEventResult> {
    return this.#kernel.fireEvent({
      event_type: input.event_type,
      source: this.source_binding.source,
      payload: input.payload ?? {},
      idempotency_key: input.idempotency_key,
      actor: this.actor,
    });
  }

  /** Fires one specific When (e.g. a due calendar When) as this sensor. */
  fireWhen(input: { when_id: string; idempotency_key: string; payload?: Record<string, unknown> }): Promise<FireEventResult> {
    return this.#kernel.fireEvent({
      when_id: input.when_id,
      idempotency_key: input.idempotency_key,
      payload: input.payload ?? {},
      actor: this.actor,
    });
  }

  /** Records that the sensor is alive (it ran, whether or not it saw a change). */
  heartbeat(): Promise<FireEventResult> {
    return this.#kernel.fireEvent({
      when_id: this.heartbeat_when_id,
      idempotency_key: `${HEARTBEAT_EVENT_TYPE}:${this.id}:${this.#now().toISOString()}`,
      actor: this.actor,
    });
  }
}

export class SensorFramework {
  readonly #kernel: Kernel;
  readonly #store: GraphStore;
  readonly #now: () => Date;
  readonly #ajv = createValidator();

  constructor(kernel: Kernel, store: GraphStore, options: SensorFrameworkOptions = {}) {
    this.#kernel = kernel;
    this.#store = store;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Registers a sensor: stores its heartbeat Whens (carrying its source binding
   * and reporting schedule) in the graph. Idempotent; re-registering with a new
   * schedule updates it but keeps the heartbeat history, so a sensor that comes
   * back after an outage still has its silence counted.
   */
  async register(def: SensorDefinition): Promise<Sensor> {
    validateDefinition(def);
    const config = scheduleConfig(def);
    await this.#store.transaction((tx) => {
      const at = this.#now().toISOString();
      // The heartbeat arrives the way the sensor reports; the miss is found by polling the graph.
      const whens: Array<[string, string, Record<string, unknown>]> = [
        [heartbeatWhenId(def.id), HEARTBEAT_EVENT_TYPE, { source: sensorActor(def.id), mechanism: def.source_binding.mechanism, config: { sensor_id: def.id, source_binding: { ...def.source_binding } } }],
        [missedHeartbeatWhenId(def.id), MISSED_HEARTBEAT_EVENT_TYPE, { source: sensorActor(def.id), mechanism: "poll", config }],
      ];
      for (const [id, eventType, binding] of whens) {
        const existing = tx.getNode(id);
        if (existing && existing.kind !== "when") throw new SensorError(`node ${id} exists and is not a When`);
        const node: Node = existing
          ? { ...existing, status: "active", attributes: { ...existing.attributes, source_binding: binding } }
          : {
              id,
              kind: "when",
              created_at: at,
              status: "active",
              attributes: { when_type: "event", event_type: eventType, source_binding: binding, fired_at: null, fire_count: 0 },
            };
        this.#check(node);
        tx.putNode(node);
      }
    });
    return new Sensor(this.#kernel, def, this.#now);
  }

  /**
   * Records a `sensor_heartbeat_missed` firing for every registered sensor
   * whose latest reporting slot ended (plus grace) without a heartbeat. Each
   * missed slot is recorded once; returns only newly recorded misses.
   */
  async checkHeartbeats(): Promise<MissedHeartbeat[]> {
    const now = this.#now();
    const due = await this.#store.read((tx) => findMissed(tx, now));
    const recorded: MissedHeartbeat[] = [];
    for (const m of due) {
      const payload = {
        sensor_id: m.sensor_id,
        last_heartbeat_at: m.last_heartbeat_at,
        expected_by: m.expected_by,
        missed_intervals: m.missed_intervals,
      };
      const result = await this.#kernel.fireEvent({
        when_id: m.when_id,
        idempotency_key: `${MISSED_HEARTBEAT_EVENT_TYPE}:${m.sensor_id}:${m.expected_by}`,
        payload,
        actor: HEARTBEAT_MONITOR_ACTOR,
      });
      if (result.applied) recorded.push({ ...m, event_id: result.ledger_event.id });
    }
    return recorded;
  }

  #check(node: Node): void {
    const validate = this.#ajv.getSchema(`${SCHEMA_ID_BASE}node.schema.json`);
    if (!validate) throw new Error("schema node is not registered");
    if (!validate(node)) throw new SensorError(`sensor When ${node.id} does not match its schema: ${this.#ajv.errorsText(validate.errors)}`);
  }
}

function findMissed(tx: GraphTx, now: Date): Array<Omit<MissedHeartbeat, "event_id">> {
  const missed: Array<Omit<MissedHeartbeat, "event_id">> = [];
  for (const node of tx.listNodes()) {
    const a = node.attributes;
    if (node.kind !== "when" || node.status !== "active" || a["event_type"] !== MISSED_HEARTBEAT_EVENT_TYPE) continue;
    const config = (a["source_binding"] as { config?: Record<string, unknown> } | undefined)?.config ?? {};
    const sensorId = config["sensor_id"];
    const interval = config["heartbeat_interval_seconds"];
    const grace = config["heartbeat_grace_seconds"] ?? 0;
    if (typeof sensorId !== "string" || typeof interval !== "number" || typeof grace !== "number" || interval <= 0) continue;
    const beat = tx.getNode(heartbeatWhenId(sensorId));
    if (!beat) continue;
    const firedAt = beat.attributes["fired_at"];
    const last = typeof firedAt === "string" ? firedAt : beat.created_at;
    const lastMs = Date.parse(last);
    const intervalMs = interval * 1000;
    const silentMs = now.getTime() - lastMs - grace * 1000;
    if (silentMs <= intervalMs) continue;
    // Latest n with last + n·interval + grace strictly before now.
    const n = Math.ceil(silentMs / intervalMs) - 1;
    missed.push({
      sensor_id: sensorId,
      when_id: node.id,
      last_heartbeat_at: new Date(lastMs).toISOString(),
      expected_by: new Date(lastMs + n * intervalMs).toISOString(),
      missed_intervals: n,
    });
  }
  return missed.sort((x, y) => x.sensor_id.localeCompare(y.sensor_id));
}

function validateDefinition(def: SensorDefinition): void {
  if (!SENSOR_ID.test(def.id)) throw new SensorError(`sensor id ${JSON.stringify(def.id)} must match ${SENSOR_ID}`);
  const { source, mechanism } = def.source_binding;
  if (typeof source !== "string" || source.length === 0) throw new SensorError("source_binding.source must be a non-empty string");
  if (!["webhook", "poll", "manual"].includes(mechanism)) throw new SensorError(`unknown source_binding.mechanism ${JSON.stringify(mechanism)}`);
  const { interval_seconds, grace_seconds = 0 } = def.heartbeat;
  if (!Number.isInteger(interval_seconds) || interval_seconds <= 0)
    throw new SensorError("heartbeat.interval_seconds must be a positive integer");
  if (!Number.isInteger(grace_seconds) || grace_seconds < 0) throw new SensorError("heartbeat.grace_seconds must be a non-negative integer");
}

function scheduleConfig(def: SensorDefinition): Record<string, unknown> {
  return {
    sensor_id: def.id,
    heartbeat_interval_seconds: def.heartbeat.interval_seconds,
    heartbeat_grace_seconds: def.heartbeat.grace_seconds ?? 0,
  };
}

function sensorActor(id: string): string {
  return `sensor:${id}`;
}

function heartbeatWhenId(id: string): string {
  return `lc_when_sensor_${id}_heartbeat`;
}

function missedHeartbeatWhenId(id: string): string {
  return `lc_when_sensor_${id}_heartbeat_missed`;
}
