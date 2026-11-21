// LC-EST-IMAGE-PRECONDITIONS acceptance: docs/ops/estate-image-preconditions.json
// names every registry, secret and OpenBao input the estate-image workflows
// and the aks-obs-01 overlay read, each with the board item (CLOSER-<n>) that
// provisions it. Name and presence only: no value is read or written.
//
// Inputs collected from the repository:
// - every `vars.<NAME>` and `secrets.<NAME>` a `${{ }}` expression references
//   in an estate-image workflow (.github/workflows/estate-image*.yml) or in an
//   `estate-image*` job of any other workflow (ci.yml's pull-request dry runs).
//   GitHub-provided contexts (`secrets.GITHUB_TOKEN`, `github.*`, `steps.*`)
//   are not estate preconditions and are ignored;
// - every `remoteRef.key` (and its `property`) an ExternalSecret in the
//   rendered aks-obs-01 overlay reads from OpenBao.
// A record entry no workflow reads yet is allowed; an input missing from the
// record, or an entry without a provisioning item, fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { kustomizeBuild, parseObjects, repoRoot, type Obj } from "../../tests/deploy/manifest-check.ts";

const RECORD = join(repoRoot, "docs", "ops", "estate-image-preconditions.json");
const WORKFLOWS = join(repoRoot, ".github", "workflows");
const OVERLAY = join(repoRoot, "deploy", "overlays", "aks-obs-01");
const PROVISIONING_ITEM = /^CLOSER-[1-9][0-9]*$/;
/** Secrets GitHub provides to every run; never provisioned by the estate. */
const GITHUB_PROVIDED_SECRETS = new Set(["GITHUB_TOKEN"]);

type Kind = "github-variable" | "github-secret" | "openbao";
type Entry = { kind: Kind; name: string; properties?: string[]; provisioning: string; read_by?: string[] };
type Input = { kind: Kind; name: string; property?: string; source: string };

/** The `vars.*` and `secrets.*` names a workflow fragment references in `${{ }}` expressions. */
function expressionInputs(text: string, source: string): Input[] {
  const found: Input[] = [];
  for (const expr of text.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) {
    for (const ref of (expr[1] ?? "").matchAll(/(?<![\w.])(vars|secrets)\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)/g)) {
      const [, ctx, name] = ref as unknown as [string, string, string];
      if (ctx === "secrets" && GITHUB_PROVIDED_SECRETS.has(name)) continue;
      found.push({ kind: ctx === "vars" ? "github-variable" : "github-secret", name, source });
    }
    for (const ref of (expr[1] ?? "").matchAll(/(?<![\w.])(vars|secrets)\s*\[\s*['"]([^'"]+)['"]\s*\]/g)) {
      const [, ctx, name] = ref as unknown as [string, string, string];
      if (ctx === "secrets" && GITHUB_PROVIDED_SECRETS.has(name)) continue;
      found.push({ kind: ctx === "vars" ? "github-variable" : "github-secret", name, source });
    }
  }
  return found;
}

/**
 * Inputs the estate-image workflows declare: the whole of every
 * estate-image*.yml workflow, and each `estate-image*` job elsewhere.
 * `files` maps a workflow file name to its text.
 */
function workflowInputs(files: Record<string, string>): Input[] {
  const inputs: Input[] = [];
  for (const [file, text] of Object.entries(files)) {
    if (/^estate-image.*\.ya?ml$/.test(file)) {
      inputs.push(...expressionInputs(text, `.github/workflows/${file}`));
      continue;
    }
    const jobs = ((parse(text) as Obj | null)?.["jobs"] ?? {}) as Obj;
    for (const [id, job] of Object.entries(jobs)) {
      if (!id.startsWith("estate-image")) continue;
      inputs.push(...expressionInputs(JSON.stringify(job), `.github/workflows/${file}#${id}`));
    }
  }
  return inputs;
}

/** The OpenBao keys and properties every ExternalSecret in `objects` reads through remoteRef. */
function externalSecretInputs(objects: Obj[]): Input[] {
  const inputs: Input[] = [];
  for (const o of objects) {
    if (o["kind"] !== "ExternalSecret") continue;
    const source = `ExternalSecret/${o["metadata"]?.["name"]}`;
    for (const d of (o["spec"]?.["data"] ?? []) as Obj[]) {
      const ref = d["remoteRef"] as Obj | undefined;
      if (!ref?.["key"]) continue;
      const input: Input = { kind: "openbao", name: String(ref["key"]), source };
      if (ref["property"] !== undefined) input.property = String(ref["property"]);
      inputs.push(input);
    }
  }
  return inputs;
}

/** Inputs with no record entry of the same kind and name (and, for OpenBao, property). */
function missingFromRecord(entries: Entry[], inputs: Input[]): string[] {
  const missing: string[] = [];
  for (const i of inputs) {
    const entry = entries.find((e) => e.kind === i.kind && e.name === i.name);
    if (!entry) {
      missing.push(`${i.kind} ${i.name} (read by ${i.source})`);
    } else if (i.property !== undefined && !(entry.properties ?? []).includes(i.property)) {
      missing.push(`${i.kind} ${i.name} property ${i.property} (read by ${i.source})`);
    }
  }
  return missing;
}

/** Shape errors in a record: unknown kind, empty name, duplicate, or no CLOSER-<n> provisioning item. */
function recordErrors(record: unknown): string[] {
  const errors: string[] = [];
  const entries = (record as Obj | null)?.["preconditions"];
  if (!Array.isArray(entries) || entries.length === 0) return ["record has no preconditions list"];
  const seen = new Set<string>();
  for (const [n, e] of (entries as Obj[]).entries()) {
    const label = `entry ${n} (${e?.["kind"]} ${e?.["name"]})`;
    if (!["github-variable", "github-secret", "openbao"].includes(e?.["kind"])) errors.push(`${label}: unknown kind`);
    if (typeof e?.["name"] !== "string" || e["name"] === "") errors.push(`${label}: no name`);
    if (typeof e?.["provisioning"] !== "string" || !PROVISIONING_ITEM.test(e["provisioning"])) {
      errors.push(`${label}: no provisioning board item (CLOSER-<n>)`);
    }
    if ("value" in (e ?? {})) errors.push(`${label}: records a value; the record holds names only`);
    const id = `${e?.["kind"]} ${e?.["name"]}`;
    if (seen.has(id)) errors.push(`${label}: duplicate`);
    seen.add(id);
  }
  return errors;
}

function loadRecord(): Entry[] {
  const record = JSON.parse(readFileSync(RECORD, "utf8")) as unknown;
  assert.deepEqual(recordErrors(record), [], "the preconditions record is well formed");
  return (record as { preconditions: Entry[] }).preconditions;
}

function repoWorkflows(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const f of readdirSync(WORKFLOWS)) {
    if (/\.ya?ml$/.test(f)) files[f] = readFileSync(join(WORKFLOWS, f), "utf8");
  }
  return files;
}

test("lists every vars and secrets input the estate-image workflows declare", () => {
  const entries = loadRecord();
  const inputs = workflowInputs(repoWorkflows());
  const names = new Set(inputs.map((i) => `${i.kind} ${i.name}`));
  // The publish and its pull-request check read both repository variables.
  assert.ok(names.has("github-variable ESTATE_REGISTRY"), "estate-image reads vars.ESTATE_REGISTRY");
  assert.ok(names.has("github-variable OPENBAO_ADDR"), "estate-image reads vars.OPENBAO_ADDR");
  assert.deepEqual(missingFromRecord(entries, inputs), [], "every estate-image workflow input is recorded");

  // A new vars.* or secrets.* reference in an estate-image workflow or job is caught...
  const added = workflowInputs({
    "estate-image.yml": "jobs:\n  p:\n    steps:\n      - env:\n          X: ${{ vars.NEW_VAR }}\n          Y: ${{ secrets['NEW_SECRET'] }}\n",
    "ci.yml": "jobs:\n  estate-image-x:\n    steps:\n      - env:\n          Z: ${{ secrets.CI_SECRET }}\n",
  });
  assert.deepEqual(
    missingFromRecord(entries, added).map((m) => m.split(" (")[0]),
    ["github-variable NEW_VAR", "github-secret NEW_SECRET", "github-secret CI_SECRET"],
  );
  // ...while GitHub-provided contexts and non-estate-image jobs are not inputs.
  assert.deepEqual(
    workflowInputs({
      "estate-image.yml": "jobs:\n  p:\n    steps:\n      - with:\n          t: ${{ secrets.GITHUB_TOKEN }}\n          s: ${{ github.sha }} ${{ steps.push.outputs.digest }}\n",
      "ci.yml": "jobs:\n  image:\n    steps:\n      - env:\n          Z: ${{ secrets.OTHER }}\n",
    }),
    [],
  );
});

test("lists the OpenBao path the aks-obs-01 registry pull ExternalSecret reads", () => {
  const entries = loadRecord();
  const inputs = externalSecretInputs(parseObjects(kustomizeBuild(OVERLAY)));
  const pull = inputs.filter((i) => i.source === "ExternalSecret/loopcloser-registry-pull");
  assert.deepEqual(
    pull.map((i) => `${i.name}#${i.property}`).sort(),
    ["kv/loopcloser/registry-pull#password", "kv/loopcloser/registry-pull#registry", "kv/loopcloser/registry-pull#username"],
    "the overlay's registry pull ExternalSecret reads registry, username and password",
  );
  assert.deepEqual(missingFromRecord(entries, inputs), [], "every overlay ExternalSecret remoteRef is recorded");
  const entry = entries.find((e) => e.kind === "openbao" && e.name === "kv/loopcloser/registry-pull");
  assert.equal(entry?.provisioning, "CLOSER-165", "the pull credential is provisioned by CLOSER-165");

  // A remoteRef key or property the record does not name is caught.
  const extra = externalSecretInputs([
    {
      kind: "ExternalSecret",
      metadata: { name: "new" },
      spec: {
        data: [
          { secretKey: "a", remoteRef: { key: "kv/loopcloser/other", property: "token" } },
          { secretKey: "b", remoteRef: { key: "kv/loopcloser/registry-pull", property: "email" } },
        ],
      },
    },
  ]);
  assert.deepEqual(missingFromRecord(entries, extra).map((m) => m.split(" (")[0]), [
    "openbao kv/loopcloser/other",
    "openbao kv/loopcloser/registry-pull property email",
  ]);
});

test("refuses a precondition without a provisioning board item", () => {
  loadRecord();
  const entry = { kind: "github-variable", name: "ESTATE_REGISTRY" };
  for (const provisioning of [undefined, "", "TBD", "closer-235", "LC-EST-IMAGE-PRECONDITIONS", "CLOSER-"]) {
    const record = { preconditions: [provisioning === undefined ? entry : { ...entry, provisioning }] };
    assert.deepEqual(
      recordErrors(record),
      ["entry 0 (github-variable ESTATE_REGISTRY): no provisioning board item (CLOSER-<n>)"],
      `provisioning ${JSON.stringify(provisioning)} is refused`,
    );
  }
  assert.deepEqual(recordErrors({ preconditions: [{ ...entry, provisioning: "CLOSER-235" }] }), []);
  // An entry no workflow reads yet is allowed: extra entries never fail the input checks.
  assert.deepEqual(
    missingFromRecord([{ kind: "github-secret", name: "NOT_READ_YET", provisioning: "CLOSER-235" }], []),
    [],
  );
});
