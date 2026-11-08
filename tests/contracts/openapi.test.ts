// LC-M1-T2 acceptance: the OpenAPI document covers every SPEC B3 operation,
// and the contract check keeps it in agreement with the B2 domain schemas.
import { test } from "node:test";
import assert from "node:assert/strict";
import { B3_OPERATIONS, checkContract, listOperations, loadOpenApi } from "../../src/contracts/index.ts";

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
