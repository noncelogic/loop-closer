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
