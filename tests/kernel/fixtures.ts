// Shared fixtures for the LC-M1-T4 kernel tests: a research-papers loop
// subgraph (SPEC B7 Phase 1 worked example, trimmed) and schema checks.
import assert from "node:assert/strict";
import { createValidator, SCHEMA_ID_BASE } from "../../src/contracts/index.ts";
import { InMemoryGraphStore, Kernel, type Node, type ProposeLoopInput } from "../../src/kernel/index.ts";

const ajv = createValidator();

export function assertValid(object: "loop" | "ledger-event" | "node" | "edge", value: unknown): void {
  const validate = ajv.getSchema(`${SCHEMA_ID_BASE}${object}.schema.json`);
  assert.ok(validate, `${object} schema registered`);
  assert.ok(validate(value), `${object} should match its schema: ${ajv.errorsText(validate.errors)}`);
}

export function newKernel(): { kernel: Kernel; store: InMemoryGraphStore; tick: (seconds: number) => void } {
  let now = Date.parse("2026-11-10T09:00:00Z");
  let seq = 0;
  const store = new InMemoryGraphStore();
  const kernel = new Kernel(store, {
    now: () => new Date(now),
    newId: (prefix) => `lc_${prefix}_${++seq}`,
  });
  return { kernel, store, tick: (seconds) => void (now += seconds * 1000) };
}

const T0 = "2026-11-10T08:00:00Z";

export const joe: Node = {
  id: "lc_who_joe",
  kind: "who",
  created_at: T0,
  status: "active",
  attributes: { who_type: "person", name: "Joe", contact_points: [], external_ids: {} },
};

export const experiment: Node = {
  id: "lc_what_experiment",
  kind: "what",
  created_at: T0,
  status: "active",
  attributes: { what_type: "action", title: "Run the experiment the paper proposes" },
};

export const repoRuns: Node = {
  id: "lc_when_repo_runs",
  kind: "when",
  created_at: T0,
  status: "active",
  attributes: {
    when_type: "event",
    event_type: "repo_runs",
    source_binding: { source: "ci", mechanism: "webhook" },
    fired_at: null,
    fire_count: 0,
  },
};

export const resultsLand: Node = {
  id: "lc_when_results_land",
  kind: "when",
  created_at: T0,
  status: "active",
  attributes: {
    when_type: "event",
    event_type: "results_landed",
    source_binding: { source: "manual", mechanism: "manual" },
    fired_at: null,
    fire_count: 0,
  },
};

/** experiment is_waiting_on repo-runs; results-landing closes the loop. */
export function experimentProposal(overrides: Partial<ProposeLoopInput> = {}): ProposeLoopInput {
  return {
    name: "Replicate paper 2611.01234",
    loop_type: "publishing",
    accountable_who_id: joe.id,
    nodes: [joe, experiment, repoRuns, resultsLand],
    edges: [
      { from_id: experiment.id, to_id: repoRuns.id, edge_type: "is_waiting_on" },
      { from_id: repoRuns.id, to_id: experiment.id, edge_type: "enables" },
    ],
    closing_when_id: resultsLand.id,
    actor: "agent:juno",
    rationale: "Top-ranked paper; Joe chose to pursue it.",
    ...overrides,
  };
}
