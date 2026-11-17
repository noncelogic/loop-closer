// Regression lock for the ci break fixed by PR #24 (red run 43793365208, green again at 43795676003).
//
// Culprit: 7b451b4 "LC-M3-T2: Add the factory-notification loop type with autonomous authority (#22)".
// Its second commit (644abd7, COND-59-fix1) added the HTTP test "over HTTP, the sender cannot make an
// outsider an owner's receiver through graph claims" to tests/api/communications.test.ts, building its
// own server with `createServer({ kernel, apiKeys })` and no `scopes`.
//
// Root cause: a semantic merge conflict. The PR branch was cut from 28c2b0e, before 5e238ce (#21,
// LC-M3-T1c) made per-agent operation scopes default-deny in src/server.ts. On that old base a
// scope-less server let agent:sender call propose_loop, so the test passed on the branch. Merged onto
// 5e238ce, the same server denies every non-Joe operation, the sender's propose_loop got 403 instead of
// 201, and main went red. Git merged the two PRs cleanly because they touched different lines.
//
// Why pull request checks missed it: the branch's own commit (24a2de4, run 43789771736) went green, and
// the run that tested the merge with the newer main (644abd7, run 43791850417) did fail its `test`
// job, but that red check did not block the merge (main has no required status check), and the failure
// read as one behavioural assertion deep in the full `npm test` run rather than as "this server has no
// scopes". This test is a static, millisecond check that names the cause directly: every server a test
// under tests/ builds must grant scopes explicitly, so a test written against the old allow-by-default
// behaviour fails here on the PR, with the file and line, whatever base it was written against.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");

/**
 * Servers that may omit `scopes`, each with the reason. A server built here grants no operation to any
 * non-Joe principal, so it is only fit for tests that never reach an authorised operation.
 */
const SCOPELESS_ALLOWED: ReadonlyMap<string, string> = new Map([
  ["tests/api/server-malformed-url.test.ts", "only sends unparsable request targets, rejected before any operation is authorised"],
]);

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : testFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

/** The service's server factory: only calls bound to this module's `createServer` are scanned. */
const SERVICE_SERVER = join(ROOT, "src", "server.ts");

/**
 * The local names under which `file` imports `createServer` from src/server.ts, by name or under an
 * alias. A `createServer` imported from anywhere else (node:http, node:https) is not the service's server.
 */
function serviceServerBindings(source: string, file: string): Set<string> {
  const names = new Set<string>();
  const imports = /\bimport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
  for (let match = imports.exec(source); match; match = imports.exec(source)) {
    const [, specifiers, from] = match;
    if (!from!.startsWith(".") || resolve(dirname(file), from!) !== SERVICE_SERVER) continue;
    if (/^\s*import\s+type\b/.test(match[0])) continue;
    for (const raw of specifiers!.split(",")) {
      const spec = raw.trim().match(/^(type\s+)?createServer(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
      if (spec && !spec[1]) names.add(spec[2] ?? "createServer");
    }
  }
  return names;
}

/**
 * Each call in `file`'s `source` to src/server.ts's `createServer` (under whatever local name it is
 * imported), as its full argument text and 1-based line.
 */
function createServerCalls(source: string, file: string): { args: string; line: number }[] {
  const calls: { args: string; line: number }[] = [];
  for (const name of serviceServerBindings(source, file)) {
    const pattern = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}\\s*\\(`, "g");
    for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
      const start = match.index + match[0].length;
      let depth = 1;
      let end = start;
      while (end < source.length && depth > 0) {
        const ch = source[end];
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
        end++;
      }
      calls.push({ args: source.slice(start, end - 1), line: source.slice(0, match.index).split("\n").length });
    }
  }
  return calls.sort((a, b) => a.line - b.line);
}

const grantsScopes = (args: string): boolean => /\bscopes\s*[:,}]/.test(args);

/** A file two levels under the repository root, as every test under tests/<area>/ is. */
const FIXTURE = join(ROOT, "tests", "api", "fixture.test.ts");

test("the scan refuses a scope-less service server called by its own name or through an aliased import from src/server.ts", () => {
  const byName = createServerCalls(
    'import { createServer } from "../../src/server.ts";\n\nconst s = createServer({ kernel, apiKeys });',
    FIXTURE,
  );
  assert.deepEqual(byName.map((c) => c.line), [3]);
  assert.equal(grantsScopes(byName[0]!.args), false);

  const aliased = createServerCalls(
    'import { JOE_PRINCIPAL, createServer as makeServer } from "../../src/server.ts";\nconst s = makeServer({ kernel, apiKeys });',
    FIXTURE,
  );
  assert.deepEqual(aliased.map((c) => c.line), [2]);
  assert.equal(grantsScopes(aliased[0]!.args), false);

  const scoped = createServerCalls(
    'import {\n  createServer,\n} from "../../src/server.ts";\ncreateServer({\n  kernel,\n  apiKeys: KEYS,\n  scopes: new Map([["a", ["x"]]]),\n})',
    FIXTURE,
  );
  assert.equal(scoped.length, 1);
  assert.equal(grantsScopes(scoped[0]!.args), true);
  const shorthand = createServerCalls('import { createServer } from "../../src/server.ts";\ncreateServer({ apiKeys, scopes })', FIXTURE);
  assert.equal(grantsScopes(shorthand[0]!.args), true);
});

test("the scan allows a createServer call imported from node:http or node:https, with or without an alias", () => {
  for (const source of [
    'import { createServer } from "node:http";\nconst s = createServer(handler);',
    'import { createServer as createHttpServer, type Server } from "node:http";\nconst s = createHttpServer(handler);',
    'import { createServer } from "node:https";\nconst s = createServer(options, handler);',
    'import { createServer as createHttpsServer } from "node:https";\nconst s = createHttpsServer(options, handler);',
    'import { createServer } from "../../src/other.ts";\nconst s = createServer({ kernel, apiKeys });',
  ]) {
    assert.deepEqual(createServerCalls(source, FIXTURE), [], source);
  }
});

test("every service server a test under tests/ builds grants operation scopes explicitly (scopes are default-deny since #21)", () => {
  const offenders: string[] = [];
  let seen = 0;
  for (const file of testFiles(join(ROOT, "tests"))) {
    const rel = relative(ROOT, file).split("\\").join("/");
    if (rel === "tests/api/server-scopes-explicit.test.ts") continue;
    for (const call of createServerCalls(readFileSync(file, "utf8"), file)) {
      seen++;
      if (!grantsScopes(call.args) && !SCOPELESS_ALLOWED.has(rel)) offenders.push(`${rel}:${call.line}`);
    }
  }
  assert.ok(seen > 0, "found no calls to src/server.ts's createServer under tests/: the scan is broken");
  assert.deepEqual(
    offenders,
    [],
    "these servers pass no `scopes`, so every non-Joe operation they serve is denied with 403; grant the operations the test drives",
  );
});
