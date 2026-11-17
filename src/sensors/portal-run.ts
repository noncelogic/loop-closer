// One scheduled portal read (SPEC B7: the portal has no API, so the sensor is
// a read on a schedule). runPortalRead registers the listings sensor on the
// given graph store, runs one PortalReadSource poll with the injected read and
// returns its report. The comparison state is the graph itself: the poll
// compares each listing with the last status this sensor recorded in the
// ledger, so separate invocations (one process per schedule slot) see each
// change once.
//
// A failed read throws PortalReadFailedError after the poll has declined to
// heartbeat, so the caller exits non-zero and the framework's missed-heartbeat
// check sees a silent sensor: a stale sensor stays distinct from a quiet world.
import { Kernel, type KernelOptions } from "../kernel/kernel.ts";
import type { GraphStore } from "../kernel/store.ts";
import { SensorFramework, type SensorDefinition } from "./framework.ts";
import {
  ANTHROPIC_LISTINGS_SENSOR,
  LISTING_STATUS_CHANGED,
  PortalReadSource,
  type PortalObservation,
  type PortalPollReport,
} from "./sources.ts";

export interface PortalReadRunOptions {
  /** The scheduled read (e.g. PublicListingReader.read); throwing means the portal could not be seen. */
  read: () => Promise<PortalObservation[]>;
  now?: () => Date;
  newId?: KernelOptions["newId"];
  /** Defaults to ANTHROPIC_LISTINGS_SENSOR. */
  definition?: SensorDefinition;
  /** Defaults to LISTING_STATUS_CHANGED. */
  event_type?: string;
}

/** The read failed: no heartbeat was recorded. */
export class PortalReadFailedError extends Error {
  override name = "PortalReadFailedError";
  readonly sensor_id: string;

  constructor(sensorId: string, message: string) {
    super(message);
    this.sensor_id = sensorId;
  }
}

export async function runPortalRead(store: GraphStore, options: PortalReadRunOptions): Promise<PortalPollReport> {
  const now = options.now ?? (() => new Date());
  const kernel = new Kernel(store, { now, ...(options.newId ? { newId: options.newId } : {}) });
  const framework = new SensorFramework(kernel, store, { now });
  const definition = options.definition ?? ANTHROPIC_LISTINGS_SENSOR;
  const source = await PortalReadSource.register(framework, store, definition, {
    event_type: options.event_type ?? LISTING_STATUS_CHANGED,
    read: options.read,
  });
  const report = await source.poll();
  if (report.error !== undefined) throw new PortalReadFailedError(definition.id, report.error);
  return report;
}
