// LC-M1-T2 acceptance: the OpenAPI document covers every SPEC B3 operation,
// and the contract check keeps it in agreement with the B2 domain schemas.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  B3_OPERATIONS,
  checkContract,
  createApiValidator,
  listOperations,
  loadDomainSchemas,
  loadExamples,
  loadOpenApi,
  SCHEMA_ID_BASE,
} from "../../src/contracts/index.ts";

const doc = loadOpenApi();

test("openapi document is OpenAPI 3.1 with a frozen v1 contract version", () => {
  assert.match(String(doc.openapi), /^3\.1\.\d+$/);
  assert.match(String((doc.info as { version?: unknown }).version), /^1\.\d+\.\d+$/);
});

test("openapi document covers every B3 operation exactly once", () => {
  const ops = listOperations(doc);
  const ids = ops.map((o) => o.operationId);
  for (const op of B3_OPERATIONS) {
    assert.equal(ids.filter((id) => id === op).length, 1, `operation ${op} appears exactly once`);
  }
  assert.deepEqual([...ids].sort(), [...B3_OPERATIONS].sort(), "no operations outside SPEC B3");
});

test("contract check: openapi and domain schemas agree", () => {
  assert.deepEqual(checkContract(), []);
});

test("contract check catches drift", () => {
  const drifted = structuredClone(doc) as { paths: Record<string, Record<string, { operationId?: string }>> };
  delete drifted.paths["/loops/{loop_id}/transition"];
  const broken = structuredClone(doc) as { components: { schemas: Record<string, unknown> } };
  broken.components.schemas.Loop = { $ref: "https://loopcloser.noncelogic.invalid/schemas/v1/missing.schema.json" };
  assert.ok(checkContract(drifted).some((p) => p.includes("transition")));
  assert.ok(checkContract(broken).some((p) => p.includes("missing.schema.json")));
});

// LC-CP-SUSPEND: suspended is a non-terminal loop state the frozen contract
// declares, so a caller's transition to it (and back) validates against
// openapi.json, and a suspended loop never reads as closed.
test("the contract declares suspended as a loop state transition accepts", () => {
  const api = createApiValidator(doc);
  const transition = api.request("transition");
  assert.ok(transition, "transition has a request body schema");
  const request = (to_state: string) => ({
    to_state,
    actor: "agent:cortexplane",
    evidence: { kind: "ledger_event", id: "lc_evt_1" },
    idempotency_key: `suspend-${to_state}`,
  });
  assert.ok(transition(request("suspended")), api.ajv.errorsText(transition.errors));
  assert.ok(transition(request("open")), api.ajv.errorsText(transition.errors));
  assert.equal(transition(request("paused")), false, "an undeclared state is still refused");

  const loopSchema = loadDomainSchemas().get("loop") as { $defs: { loop_state: { enum: string[] } } };
  assert.ok(loopSchema.$defs.loop_state.enum.includes("suspended"));

  // A suspended loop record is valid only with the not-closed fields.
  const validateLoop = api.ajv.getSchema(`${SCHEMA_ID_BASE}loop.schema.json`);
  assert.ok(validateLoop);
  const [example] = loadExamples("loop").valid;
  assert.ok(example);
  const open = { ...(example.payload as Record<string, unknown>), state: "open", closed_at: null, close_reason: null };
  assert.ok(validateLoop(open), api.ajv.errorsText(validateLoop.errors));
  assert.ok(validateLoop({ ...open, state: "suspended" }), api.ajv.errorsText(validateLoop.errors));
  assert.equal(validateLoop({ ...open, state: "suspended", closed_at: "2026-11-10T09:00:00Z" }), false);

  // open_loops may be filtered to suspended loops.
  const stateFilter = api.parameter("open_loops", "state");
  assert.ok(stateFilter?.("suspended"));
});
