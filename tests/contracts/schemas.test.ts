// LC-M1-T2 acceptance: every SPEC B2 object schema validates its example payloads.
//
// Each B2 object has a versioned JSON Schema under contracts/schemas/v1/ and
// example payloads under contracts/examples/v1/<object>/. Valid examples must
// pass; invalid examples must be rejected (so a schema that accepts anything
// cannot pass this test).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  B2_OBJECTS,
  SCHEMA_VERSION,
  SUPERSESSION_TYPES,
  createValidator,
  loadDomainSchemas,
  loadExamples,
} from "../../src/contracts/index.ts";

const schemas = loadDomainSchemas();

test("every B2 object has a versioned schema", () => {
  assert.deepEqual([...schemas.keys()].sort(), [...B2_OBJECTS].sort());
  for (const [name, schema] of schemas) {
    assert.match(String(schema.$id), new RegExp(`/${SCHEMA_VERSION}/${name}\\.schema\\.json$`), `${name} $id`);
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema", `${name} $schema`);
  }
});

for (const name of B2_OBJECTS) {
  test(`${name}: schema validates its example payloads`, () => {
    const ajv = createValidator();
    const validate = ajv.getSchema(String(schemas.get(name)?.$id));
    assert.ok(validate, `${name} schema compiles`);
    const { valid, invalid } = loadExamples(name);
    assert.ok(valid.length > 0, `${name} has at least one valid example`);
    assert.ok(invalid.length > 0, `${name} has at least one invalid example`);
    for (const ex of valid) {
      assert.ok(validate(ex.payload), `${ex.file} should be valid: ${ajv.errorsText(validate.errors)}`);
    }
    for (const ex of invalid) {
      assert.equal(validate(ex.payload), false, `${ex.file} should be rejected`);
    }
  });
}

test("typed supersession vocabulary is exactly the SPEC B2.8 set", () => {
  const schema = schemas.get("supersession");
  const typeEnum = (schema?.$defs as Record<string, { enum?: unknown[] }> | undefined)?.supersession_type?.enum;
  assert.deepEqual(typeEnum, [...SUPERSESSION_TYPES]);
  assert.deepEqual([...SUPERSESSION_TYPES].sort(), [
    "fact_replacement",
    "loop_supersession",
    "objective_revision",
    "same_as_merge",
    "split",
    "valid_during",
  ]);
});

test("the event When schema declares the change condition", () => {
  const ajv = createValidator();
  const node = schemas.get("node");
  const validate = ajv.getSchema(String(node?.$id));
  assert.ok(validate, "node schema compiles");
  const defs = node?.$defs as Record<string, { properties?: Record<string, { required?: string[]; properties?: Record<string, unknown> }>; required?: string[] }>;
  const condition = defs.event_when?.properties?.["change_condition"];
  assert.ok(condition, "event_when declares change_condition");
  assert.deepEqual(condition.required, ["field"]);
  assert.deepEqual(Object.keys(condition.properties ?? {}).sort(), ["field", "last_value"]);
  assert.ok(!defs.event_when?.required?.includes("change_condition"), "the condition is optional");

  const when = (attributes: Record<string, unknown>) => ({
    id: "lc_when_watch",
    kind: "when",
    created_at: "2026-11-07T15:30:00Z",
    status: "active",
    attributes: {
      when_type: "event",
      event_type: "status_observed",
      source_binding: { source: "cortexplane", mechanism: "poll" },
      fired_at: null,
      fire_count: 0,
      ...attributes,
    },
  });
  assert.ok(validate(when({})), "a When without a condition stays valid");
  assert.ok(validate(when({ change_condition: { field: "status" } })), "never fired: no last value yet");
  assert.ok(validate(when({ change_condition: { field: "status", last_value: null } })), "null is an observed value");
  assert.ok(validate(when({ change_condition: { field: "status", last_value: { a: [1] } } })));
  assert.equal(validate(when({ change_condition: {} })), false, "the condition names a field");
  assert.equal(validate(when({ change_condition: { field: "" } })), false);
  assert.equal(validate(when({ change_condition: { field: "status", fields: ["x"] } })), false, "one field only");
  assert.equal(validate(when({ change_condition: "status" })), false);
});
