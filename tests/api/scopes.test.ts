// LC-M3-T1c acceptance: every API operation is refused with 403, before any
// handler runs and with nothing changed, unless the authenticated principal's
// scope set grants it. Scope sets are data loaded beside the per-agent keys
// (src/config.ts loadApiScopes), deny by default, and Joe's principal holds
// every scope (TECH-STACK §9; SPEC B2.6 separates chaser, drafter and sender).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { loadApiScopes } from "../../src/config.ts";
import type { Authority, InMemoryGraphStore, Kernel } from "../../src/kernel/index.ts";
import { createServer, JOE_PRINCIPAL } from "../../src/server.ts";
import { experiment, experimentProposal, joe, newKernel, repoRuns, resultsLand } from "../kernel/fixtures.ts";

const KEYS = new Map([
  ["agent:juno", "test-key-juno"],
  ["agent:reader", "test-key-reader"],
  ["agent:sender", "test-key-sender"],
  ["agent:chaser", "test-key-chaser"],
  ["agent:drafter", "test-key-drafter"],
  ["agent:unscoped", "test-key-unscoped"],
  [JOE_PRINCIPAL, "test-key-joe"],
]);

const SCOPES_DIR = mkdtempSync(join(tmpdir(), "loopcloser-api-scopes-"));
// The scope data as it is mounted: one file per principal, named like its key file.
// agent:unscoped has a key and no scope file; joe needs none.
const SCOPE_FILES: Record<string, string> = {
  "agent:juno": "# intake and loop upkeep, no sends\npropose_loop accept_loop reject_loop\ntransition fire_event\nrecord_communication\nopen_loops what_fires_next health\n",
  "agent:reader": "open_loops\nwhat_fires_next\nhealth\n",
  "agent:sender": "request_send\n",
  "agent:chaser": "transition open_loops what_fires_next\n",
  "agent:drafter": "record_communication open_loops\n",
};

/** Kernel method names in the order the server called them: a refused call must add none. */
const calls: string[] = [];
let server: Server;
let base: string;
let store: InMemoryGraphStore;

before(async () => {
  for (const [principal, ops] of Object.entries(SCOPE_FILES)) writeFileSync(join(SCOPES_DIR, principal), ops);
  const env = newKernel();
  store = env.store;
  const spy = new Proxy(env.kernel, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls.push(String(prop));
        return value.apply(target, args);
      };
    },
  }) as Kernel;
  server = createServer({ kernel: spy, apiKeys: KEYS, scopes: loadApiScopes(SCOPES_DIR) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  rmSync(SCOPES_DIR, { recursive: true, force: true });
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

type Obj = Record<string, any>;

async function call(principal: string, method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; body: Obj }> {
  const res = await fetch(`${base}/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${KEYS.get(principal)!}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Obj };
}

/** Everything the store holds that a call could change. */
const snapshot = () =>
  store.read(async (tx) => ({
    nodes: await tx.listNodes(),
    loops: await tx.listLoops(),
    ledger: await tx.ledger(),
    outbox: await tx.outbox(),
  }));

let seq = 0;

async function openLoop(authority: Authority = "joe-approves-each"): Promise<string> {
  seq += 1;
  const what = { ...experiment, id: `lc_what_scope_${seq}` };
  const proposed = await call("agent:juno", "POST", "/loops/propose", experimentProposal({
    name: `Scope loop ${seq}`,
    nodes: [joe, what, repoRuns, resultsLand],
    edges: [{ from_id: what.id, to_id: repoRuns.id, edge_type: "is_waiting_on" }],
  }));
  assert.equal(proposed.status, 201, JSON.stringify(proposed.body));
  const loopId = proposed.body["loop"]["id"] as string;
  assert.equal((await call("agent:juno", "POST", `/loops/${loopId}/accept`, { acceptor: "joe" })).status, 200);
  if (authority !== "joe-approves-each") await store.transaction(async (tx) => tx.putLoop({ ...(await tx.getLoop(loopId))!, authority }));
  return loopId;
}

const HASH = `sha256:${"ab".repeat(32)}`;
const communication = (loopId: string) => ({
  thread_id: "gmail:thread:scopes",
  channel: "email",
  direction: "outbound",
  participant_who_ids: [joe.id],
  at: "2026-11-10T09:00:00Z",
  body_pointer: `minio://loopcloser/originals/${"ab".repeat(32)}`,
  body_hash: HASH,
  loop_id: loopId,
});

async function draft(loopId: string): Promise<string> {
  const recorded = await call("agent:drafter", "POST", "/communications", communication(loopId));
  assert.equal(recorded.status, 201, JSON.stringify(recorded.body));
  return recorded.body["id"] as string;
}

interface Operation {
  operationId: string;
  /** The kernel method its handler calls. */
  kernel: string;
  method: "GET" | "POST";
  path: string;
  body?: (principal: string) => unknown;
}

/** Every operation the server serves, each with a request the contract accepts. */
function served(loopId: string, communicationId: string): Operation[] {
  return [
    { operationId: "propose_loop", kernel: "proposeLoop", method: "POST", path: "/loops/propose",
      body: () => experimentProposal({ name: `Granted ${++seq}`, nodes: [{ ref: joe.id }, { ...experiment, id: `lc_what_granted_${seq}` }], edges: [], closing_when_id: undefined }) },
    { operationId: "accept_loop", kernel: "acceptLoop", method: "POST", path: `/loops/${loopId}/accept`, body: () => ({ acceptor: "joe" }) },
    { operationId: "reject_loop", kernel: "rejectLoop", method: "POST", path: `/loops/${loopId}/reject`, body: (p) => ({ actor: p, reason: "not now" }) },
    { operationId: "transition", kernel: "transition", method: "POST", path: `/loops/${loopId}/transition`,
      body: (p) => ({ to_state: "chased", actor: p, evidence: { kind: "communication", id: communicationId }, idempotency_key: `scope-${++seq}` }) },
    { operationId: "fire_event", kernel: "fireEvent", method: "POST", path: "/events/fire", body: () => ({ when_id: "lc_when_nope", idempotency_key: `scope-fire-${++seq}` }) },
    { operationId: "record_communication", kernel: "recordCommunication", method: "POST", path: "/communications", body: () => communication(loopId) },
    { operationId: "request_send", kernel: "requestSend", method: "POST", path: `/loops/${loopId}/send-requests`, body: (p) => ({ communication_id: communicationId, actor: p }) },
    { operationId: "approve_send", kernel: "approveSend", method: "POST", path: `/communications/${communicationId}/approve`, body: (p) => ({ approver: p }) },
    { operationId: "open_loops", kernel: "openLoops", method: "GET", path: "/loops" },
    { operationId: "what_fires_next", kernel: "whatFiresNext", method: "GET", path: `/what-fires-next?loop_id=${loopId}` },
    { operationId: "health", kernel: "health", method: "GET", path: "/health" },
  ];
}

test("a principal whose scope set lacks a write operation gets 403 and the ledger and store are unchanged", async () => {
  const loopId = await openLoop();
  const communicationId = await draft(loopId);
  const writes = served(loopId, communicationId).filter((op) => op.method === "POST");
  const before = await snapshot();
  const sendRequest = await store.read((tx) => tx.getSendRequest(communicationId));
  calls.length = 0;

  for (const op of writes) {
    const refused = await call("agent:reader", op.method, op.path, op.body?.("agent:reader"));
    assert.equal(refused.status, 403, `${op.operationId}: ${JSON.stringify(refused.body)}`);
    assert.equal(refused.body["error"], "forbidden");
  }
  // The chaser may transition but not record a communication, propose, or fire.
  for (const op of writes.filter((o) => ["record_communication", "propose_loop", "fire_event", "accept_loop"].includes(o.operationId))) {
    assert.equal((await call("agent:chaser", op.method, op.path, op.body?.("agent:chaser"))).status, 403, op.operationId);
  }

  assert.equal(calls.length, 0, `no handler ran: ${calls.join(", ")}`);
  assert.deepEqual(await snapshot(), before);
  assert.deepEqual(await store.read((tx) => tx.getSendRequest(communicationId)), sendRequest);
  assert.deepEqual((await store.read((tx) => tx.getLoop(loopId)))?.state, before.loops.find((l) => l.id === loopId)?.state);

  // The same principal's granted reads still answer.
  assert.equal((await call("agent:reader", "GET", "/loops")).status, 200);
});

test("chaser and drafter principals get 403 from request_send and nothing is enqueued, while a sender-scoped principal's send on an autonomous loop is enqueued", async () => {
  const loopId = await openLoop("autonomous");
  const communicationId = await draft(loopId);
  const path = `/loops/${loopId}/send-requests`;
  const outbox = () => store.read(async (tx) => (await tx.outbox()).filter((e) => e.payload["communication_id"] === communicationId));
  calls.length = 0;

  for (const principal of ["agent:chaser", "agent:drafter"]) {
    const refused = await call(principal, "POST", path, { communication_id: communicationId, actor: principal });
    assert.equal(refused.status, 403, principal);
    assert.equal(refused.body["error"], "forbidden");
  }
  assert.equal(calls.length, 0, `requestSend never ran: ${calls.join(", ")}`);
  assert.deepEqual(await outbox(), []);
  assert.equal(await store.read((tx) => tx.getSendRequest(communicationId)), undefined);

  const sent = await call("agent:sender", "POST", path, { communication_id: communicationId, actor: "agent:sender" });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  assert.deepEqual(sent.body, { communication_id: communicationId, authority: "autonomous", status: "enqueued" });
  assert.equal((await outbox()).length, 1);
});

test("a keyed principal with no configured scopes is refused every operation, and joe's principal is granted every operation", async () => {
  const loopId = await openLoop();
  const communicationId = await draft(loopId);
  const before = await snapshot();
  calls.length = 0;

  for (const op of served(loopId, communicationId)) {
    const refused = await call("agent:unscoped", op.method, op.path, op.body?.("agent:unscoped"));
    assert.equal(refused.status, 403, `${op.operationId}: ${JSON.stringify(refused.body)}`);
    assert.equal(refused.body["error"], "forbidden");
  }
  assert.equal(calls.length, 0, `no handler ran for the unscoped principal: ${calls.join(", ")}`);
  assert.deepEqual(await snapshot(), before);

  // Joe holds every scope without any scope data of his own: each operation reaches its handler.
  const ops = served(loopId, communicationId);
  for (const op of ops) {
    calls.length = 0;
    const granted = await call(JOE_PRINCIPAL, op.method, op.path, op.body?.(JOE_PRINCIPAL));
    assert.ok(![401, 403].includes(granted.status), `${op.operationId}: ${granted.status} ${JSON.stringify(granted.body)}`);
    assert.ok(calls.includes(op.kernel), `${op.operationId} reached kernel.${op.kernel} (status ${granted.status})`);
  }
});

test("scope data is read per principal beside the keys, and names only operations of the contract", () => {
  const dir = mkdtempSync(join(tmpdir(), "loopcloser-api-scopes-load-"));
  try {
    writeFileSync(join(dir, "agent:a"), "# comment\nopen_loops  health\n\nrequest_send # trailing\n");
    writeFileSync(join(dir, "agent:empty"), "");
    mkdirSync(join(dir, "..data"));
    const scopes = loadApiScopes(dir);
    assert.deepEqual([...scopes.keys()], ["agent:a", "agent:empty"]);
    assert.deepEqual([...scopes.get("agent:a")!].sort(), ["health", "open_loops", "request_send"]);
    assert.equal(scopes.get("agent:empty")!.size, 0);
    assert.equal(loadApiScopes(join(dir, "absent")).size, 0);
    assert.throws(() => createServer({ apiKeys: KEYS, scopes: new Map([["agent:a", ["open_loop"]]]) }), /open_loop/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
