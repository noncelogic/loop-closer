// Domain schemas (SPEC B2) and API contract (SPEC B3) for the loopcloser service.
//
// The JSON Schemas under contracts/schemas/<version>/ are the source of truth
// for the B2 objects. contracts/openapi.json describes the B3 operations and
// references those schemas by $id instead of redefining them. checkContract()
// is the guard that keeps the two in agreement.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";

export const SCHEMA_VERSION = "v1";
export const SCHEMA_ID_BASE = `https://loopcloser.noncelogic.invalid/schemas/${SCHEMA_VERSION}/`;

/** SPEC B2 objects, one schema file each (B2.1–B2.9; B2.7 is template + run). */
export const B2_OBJECTS = [
  "node",
  "edge",
  "loop",
  "ledger-event",
  "communication",
  "authority",
  "workflow-template",
  "workflow-run",
  "supersession",
  "tombstone",
] as const;
export type B2Object = (typeof B2_OBJECTS)[number];

/** SPEC B2.8 typed supersession vocabulary. */
export const SUPERSESSION_TYPES = [
  "fact_replacement",
  "valid_during",
  "same_as_merge",
  "split",
  "objective_revision",
  "loop_supersession",
] as const;

/** SPEC B3 operations; each must be exactly one OpenAPI operationId. */
export const B3_OPERATIONS = [
  "propose_loop",
  "accept_loop",
  "reject_loop",
  "transition",
  "fire_event",
  "open_loops",
  "what_fires_next",
  "supersede",
  "merge_nodes",
  "split_nodes",
  "record_communication",
  "request_send",
  "approve_send",
  "health",
  "export",
] as const;

type Json = Record<string, unknown>;

// Works from src/ (tests, tsx) and dist/ (built service): both sit one level below the repo root.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const contractsDir = join(repoRoot, "contracts");

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Every schema file of the current version, including shared `_`-prefixed definitions. */
export function loadSchemaFiles(): Map<string, Json> {
  const dir = join(contractsDir, "schemas", SCHEMA_VERSION);
  const out = new Map<string, Json>();
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".schema.json")) continue;
    out.set(file.slice(0, -".schema.json".length), readJson(join(dir, file)) as Json);
  }
  return out;
}

/** The B2 object schemas (shared definition files excluded). */
export function loadDomainSchemas(): Map<string, Json> {
  return new Map([...loadSchemaFiles()].filter(([name]) => !name.startsWith("_")));
}

export interface Example {
  file: string;
  payload: unknown;
}

export function loadExamples(object: string): { valid: Example[]; invalid: Example[] } {
  const base = join(contractsDir, "examples", SCHEMA_VERSION, object);
  const load = (kind: "valid" | "invalid"): Example[] => {
    const dir = join(base, kind);
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
    } catch {
      return [];
    }
    return files.map((f) => ({ file: join(object, kind, f), payload: readJson(join(dir, f)) }));
  };
  return { valid: load("valid"), invalid: load("invalid") };
}

export function loadOpenApi(): Json {
  return readJson(join(contractsDir, "openapi.json")) as Json;
}

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** A JSON Schema 2020-12 validator with every domain schema registered by $id. */
export function createValidator(): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, strictTypes: false });
  ajv.addFormat("date-time", { type: "string", validate: (s: string) => DATE_TIME.test(s) && !Number.isNaN(Date.parse(s)) });
  ajv.addFormat("uri", { type: "string", validate: (s: string) => URL.canParse(s) });
  ajv.addKeyword({ keyword: "example" }); // OpenAPI annotation
  for (const schema of loadSchemaFiles().values()) ajv.addSchema(schema);
  return ajv;
}

const METHODS = ["get", "put", "post", "delete", "patch", "head", "options", "trace"] as const;

export interface OperationRef {
  operationId: string | undefined;
  method: string;
  path: string;
  operation: Json;
}

export function listOperations(doc: Json): OperationRef[] {
  const out: OperationRef[] = [];
  for (const [path, item] of Object.entries((doc.paths ?? {}) as Record<string, Json>)) {
    for (const method of METHODS) {
      const operation = item[method] as Json | undefined;
      if (!operation) continue;
      const id = operation.operationId;
      out.push({ operationId: typeof id === "string" ? id : undefined, method, path, operation });
    }
  }
  return out;
}

function collectRefs(node: unknown, at: string, out: { ref: string; at: string }[]): void {
  if (Array.isArray(node)) {
    node.forEach((v, i) => collectRefs(v, `${at}/${i}`, out));
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === "$ref" && typeof v === "string") out.push({ ref: v, at });
      else collectRefs(v, `${at}/${k}`, out);
    }
  }
}

function resolveLocal(doc: Json, pointer: string): unknown {
  let cur: unknown = doc;
  for (const raw of pointer.replace(/^#?\//, "").split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!cur || typeof cur !== "object" || !(key in cur)) return undefined;
    cur = (cur as Json)[key];
  }
  return cur;
}

/**
 * Returns every disagreement between the OpenAPI document and the domain
 * schemas; an empty list means the contract holds.
 */
export function checkContract(doc: Json = loadOpenApi()): string[] {
  const problems: string[] = [];
  const schemas = loadSchemaFiles();
  const ids = new Map<string, string>();
  for (const [name, schema] of schemas) ids.set(String(schema.$id), name);

  // 1. Every B3 operation exactly once; nothing outside B3.
  const ops = listOperations(doc);
  for (const op of B3_OPERATIONS) {
    const n = ops.filter((o) => o.operationId === op).length;
    if (n !== 1) problems.push(`B3 operation ${op} appears ${n} times in openapi.json (want 1)`);
  }
  for (const o of ops) {
    if (!o.operationId) problems.push(`${o.method.toUpperCase()} ${o.path} has no operationId`);
    else if (!(B3_OPERATIONS as readonly string[]).includes(o.operationId))
      problems.push(`${o.method.toUpperCase()} ${o.path}: operationId ${o.operationId} is not a SPEC B3 operation`);
  }

  // 2. Every $ref resolves: local refs into the document, external refs to a domain schema $id.
  const refs: { ref: string; at: string }[] = [];
  collectRefs(doc, "#", refs);
  const referenced = new Set<string>();
  for (const { ref, at } of refs) {
    if (ref.startsWith("#")) {
      if (resolveLocal(doc, ref) === undefined) problems.push(`${at}: unresolved local $ref ${ref}`);
      continue;
    }
    const [base = "", fragment] = ref.split("#", 2);
    const name = ids.get(base);
    if (!name) {
      problems.push(`${at}: $ref ${ref} is not a domain schema $id`);
      continue;
    }
    referenced.add(name);
    if (fragment && resolveLocal(schemas.get(name) as Json, fragment) === undefined)
      problems.push(`${at}: $ref ${ref} points at a missing definition in ${name}.schema.json`);
  }

  // 3. Every B2 object is part of the API contract.
  for (const name of B2_OBJECTS) {
    if (!schemas.has(name)) problems.push(`domain schema ${name}.schema.json is missing`);
    else if (!referenced.has(name)) problems.push(`domain schema ${name} is not referenced by openapi.json`);
  }

  // 4. Every request/response schema compiles against the domain schemas.
  if (problems.length === 0) {
    const ajv = createValidator();
    // OpenAPI component schemas become $defs of one registered schema so local refs resolve.
    const base = "urn:loopcloser:openapi";
    const rebase = (node: unknown): unknown => {
      if (Array.isArray(node)) return node.map(rebase);
      if (!node || typeof node !== "object") return node;
      const out: Json = {};
      for (const [k, v] of Object.entries(node)) {
        out[k] =
          k === "$ref" && typeof v === "string" && v.startsWith("#/components/schemas/")
            ? `${base}#/$defs/${v.slice("#/components/schemas/".length)}`
            : rebase(v);
      }
      return out;
    };
    const components = ((doc.components as Json | undefined)?.schemas ?? {}) as Json;
    ajv.addSchema({ $id: base, $defs: rebase(components) as Json });
    const compile = (where: string, schema: unknown): void => {
      try {
        ajv.compile(rebase(schema) as Json);
      } catch (err) {
        problems.push(`${where}: schema does not compile: ${(err as Error).message}`);
      }
    };
    for (const name of Object.keys(components)) compile(`components.schemas.${name}`, { $ref: `#/components/schemas/${name}` });
    for (const o of ops) {
      for (const p of (o.operation.parameters ?? []) as Json[]) compile(`${o.operationId} parameter ${String(p.name)}`, p.schema);
      const body = o.operation.requestBody as Json | undefined;
      const bodyJson = (body?.content as Json | undefined)?.["application/json"] as Json | undefined;
      if (bodyJson?.schema) compile(`${o.operationId} requestBody`, bodyJson.schema);
      for (const [status, res] of Object.entries((o.operation.responses ?? {}) as Record<string, Json>)) {
        const resolved = (typeof res.$ref === "string" ? resolveLocal(doc, res.$ref) : res) as Json | undefined;
        const json = (resolved?.content as Json | undefined)?.["application/json"] as Json | undefined;
        if (json?.schema) compile(`${o.operationId} response ${status}`, json.schema);
      }
    }
  }

  // 5. supersede's type field is the B2.8 vocabulary, by reference not by copy.
  const supersessionId = String(schemas.get("supersession")?.$id);
  const supersede = ops.find((o) => o.operationId === "supersede");
  const supersedeRefs: { ref: string; at: string }[] = [];
  collectRefs(supersede?.operation, "#", supersedeRefs);
  collectRefs(resolveLocal(doc, "#/components/schemas/SupersedeRequest"), "#", supersedeRefs);
  if (!supersedeRefs.some((r) => r.ref === `${supersessionId}#/$defs/supersession_type`))
    problems.push("supersede request does not reference the B2.8 supersession_type vocabulary");

  return problems;
}
