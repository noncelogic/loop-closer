// LC-M3-T1b acceptance: the loopcloser HTTP server answers the communication
// operations of contracts/openapi.json (record_communication, request_send,
// approve_send). Under joe-approves-each a send request only records a pending
// approval; the send is enqueued once Joe approves that communication, or at
// once where the loop's authority is autonomous.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApiValidator, createValidator, SCHEMA_ID_BASE } from "../../src/contracts/index.ts";
import type { Authority, InMemoryGraphStore } from "../../src/kernel/index.ts";
import { createServer } from "../../src/server.ts";
import { experiment, experimentProposal, joe, newKernel, repoRuns, resultsLand } from "../kernel/fixtures.ts";

const KEY = "test-key-juno";
const api = createApiValidator();
const ajv = createValidator();

let server: Server;
let base: string;
let store: InMemoryGraphStore;

before(async () => {
  const env = newKernel();
  store = env.store;
  server = createServer({ kernel: env.kernel, apiKeys: new Map([["agent:juno", KEY]]) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

type Obj = Record<string, any>;

/** Calls an operation; both the request and the response are checked against the contract. */
async function call(operationId: string, path: string, body: unknown): Promise<{ status: number; body: Obj }> {
  const validateRequest = api.request(operationId);
  assert.ok(validateRequest, `${operationId} has a request schema`);
  assert.ok(validateRequest(body), `request for ${operationId} should match the contract: ${api.ajv.errorsText(validateRequest.errors)}`);
  const res = await fetch(`${base}/v1${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = (await res.json()) as Obj;
  const validate = api.response(operationId, res.status);
  assert.ok(validate, `${operationId} declares a ${res.status} response (body: ${JSON.stringify(parsed)})`);
  assert.ok(validate(parsed), `${operationId} ${res.status} response should match the contract: ${api.ajv.errorsText(validate.errors)}`);
  return { status: res.status, body: parsed };
}

let seq = 0;

/** An accepted loop; its authority is set as Joe would set it on the loop type's policy. */
async function openLoop(authority: Authority = "joe-approves-each"): Promise<string> {
  seq += 1;
  const what = { ...experiment, id: `lc_what_comm_${seq}` };
  const proposed = await call("propose_loop", "/loops/propose", experimentProposal({
    name: `Comms loop ${seq}`,
    nodes: [joe, what, repoRuns, resultsLand],
    edges: [{ from_id: what.id, to_id: repoRuns.id, edge_type: "is_waiting_on" }],
  }));
  assert.equal(proposed.status, 201);
  const loopId = proposed.body["loop"]["id"] as string;
  assert.equal((await call("accept_loop", `/loops/${loopId}/accept`, { acceptor: "joe" })).status, 200);
  if (authority !== "joe-approves-each")
    await store.transaction((tx) => tx.putLoop({ ...tx.getLoop(loopId)!, authority }));
  return loopId;
}

const HASH = `sha256:${"ab".repeat(32)}`;

async function draft(loopId: string, direction: "outbound" | "inbound" = "outbound"): Promise<Obj> {
  const recorded = await call("record_communication", "/communications", {
    thread_id: "gmail:thread:abc",
    channel: "email",
    direction,
    participant_who_ids: [joe.id],
    at: "2026-11-10T09:00:00Z",
    body_pointer: `minio://loopcloser/originals/${"ab".repeat(32)}`,
    body_hash: HASH,
    loop_id: loopId,
  });
  assert.equal(recorded.status, 201);
  const validate = ajv.getSchema(`${SCHEMA_ID_BASE}communication.schema.json`)!;
  assert.ok(validate(recorded.body), ajv.errorsText(validate.errors));
  return recorded.body;
}

const outboxFor = (communicationId: string) =>
  store.read((tx) => tx.outbox().filter((e) => e.payload["communication_id"] === communicationId));

test("record_communication stores a communication on an existing loop", async () => {
  const loopId = await openLoop();
  const inbound = await draft(loopId, "inbound");
  assert.equal(inbound["loop_id"], loopId);
  assert.equal(inbound["sent_under_authority"], null);
  const stored = await store.read((tx) => tx.getCommunication(inbound["id"]));
  assert.deepEqual(stored, inbound);

  const unknownLoop = await call("record_communication", "/communications", {
    thread_id: "t", channel: "email", direction: "outbound", participant_who_ids: [joe.id],
    at: "2026-11-10T09:00:00Z", body_pointer: "p", body_hash: HASH, loop_id: "lc_loop_nope",
  });
  assert.equal(unknownLoop.status, 404);

  const bad = await fetch(`${base}/v1/communications`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ thread_id: "t", loop_id: loopId }),
  });
  assert.equal(bad.status, 400);
});

test("a send request under joe-approves-each waits for approval", async () => {
  const loopId = await openLoop();
  const comm = await draft(loopId);

  const requested = await call("request_send", `/loops/${loopId}/send-requests`, { communication_id: comm["id"], actor: "agent:sender" });
  assert.equal(requested.status, 202);
  assert.deepEqual(requested.body, { communication_id: comm["id"], authority: "joe-approves-each", status: "pending_approval" });

  // Nothing is sent: no outbox entry, no communication_sent event.
  assert.deepEqual(await outboxFor(comm["id"]), []);
  const sent = await store.read((tx) => tx.ledger().filter((e) => e.event_type === "communication_sent" && e.subject_ids.includes(comm["id"])));
  assert.deepEqual(sent, []);
  assert.equal((await store.read((tx) => tx.getSendRequest(comm["id"])))?.status, "pending_approval");

  // Asking again does not enqueue either.
  const again = await call("request_send", `/loops/${loopId}/send-requests`, { communication_id: comm["id"], actor: "agent:sender" });
  assert.equal(again.status, 409);
  assert.deepEqual(await outboxFor(comm["id"]), []);
});

test("an approved communication is enqueued once", async () => {
  const loopId = await openLoop();
  const comm = await draft(loopId);
  assert.equal((await call("request_send", `/loops/${loopId}/send-requests`, { communication_id: comm["id"], actor: "agent:sender" })).status, 202);

  const approved = await call("approve_send", `/communications/${comm["id"]}/approve`, { approver: "joe" });
  assert.equal(approved.status, 200);
  assert.equal(approved.body["communication_id"], comm["id"]);
  assert.equal(approved.body["status"], "released");
  const event = approved.body["ledger_event"];
  assert.equal(event["event_type"], "communication_sent");
  assert.equal(event["actor"], "joe");
  assert.deepEqual(event["subject_ids"], [comm["id"], loopId]);

  const queued = await outboxFor(comm["id"]);
  assert.equal(queued.length, 1);
  assert.equal(queued[0]!.topic, "send");
  assert.equal(queued[0]!.ledger_event_id, event["id"]);
  const stored = await store.read((tx) => tx.getCommunication(comm["id"]));
  assert.equal(stored?.sent_under_authority, "joe-approves-each");

  // A second approval releases nothing more.
  const twice = await call("approve_send", `/communications/${comm["id"]}/approve`, { approver: "joe" });
  assert.equal(twice.status, 409);
  assert.equal((await outboxFor(comm["id"])).length, 1);
});

test("an approval of an unknown or unrequested communication enqueues nothing", async () => {
  const before = await store.read((tx) => tx.outbox().length);
  const unknown = await call("approve_send", "/communications/lc_comm_nope/approve", { approver: "joe" });
  assert.equal(unknown.status, 404);

  // A drafted communication nobody asked to send has no pending approval to release.
  const loopId = await openLoop();
  const comm = await draft(loopId);
  const unrequested = await call("approve_send", `/communications/${comm["id"]}/approve`, { approver: "joe" });
  assert.equal(unrequested.status, 409);
  assert.equal(await store.read((tx) => tx.outbox().length), before);
});

test("a send request under autonomous authority enqueues the send", async () => {
  const loopId = await openLoop("autonomous");
  const comm = await draft(loopId);

  const requested = await call("request_send", `/loops/${loopId}/send-requests`, { communication_id: comm["id"], actor: "agent:sender" });
  assert.equal(requested.status, 202);
  assert.deepEqual(requested.body, { communication_id: comm["id"], authority: "autonomous", status: "enqueued" });
  const queued = await outboxFor(comm["id"]);
  assert.equal(queued.length, 1);
  const event = await store.read((tx) => tx.ledger().find((e) => e.id === queued[0]!.ledger_event_id));
  assert.equal(event?.event_type, "communication_sent");
  assert.equal((await store.read((tx) => tx.getCommunication(comm["id"])))?.sent_under_authority, "autonomous");

  // Already enqueued: no approval to give and no second send.
  assert.equal((await call("approve_send", `/communications/${comm["id"]}/approve`, { approver: "joe" })).status, 409);
  assert.equal((await call("request_send", `/loops/${loopId}/send-requests`, { communication_id: comm["id"], actor: "agent:sender" })).status, 409);
  assert.equal((await outboxFor(comm["id"])).length, 1);
});

test("a send request is refused for a communication that is not this loop's outbound draft", async () => {
  const loopId = await openLoop("autonomous");
  const otherLoop = await openLoop("autonomous");
  const inbound = await draft(loopId, "inbound");
  const elsewhere = await draft(otherLoop);
  const before = await store.read((tx) => tx.outbox().length);

  const send = (loop: string, communication_id: string) =>
    call("request_send", `/loops/${loop}/send-requests`, { communication_id, actor: "agent:sender" });
  assert.equal((await send(loopId, inbound["id"])).status, 409);
  assert.equal((await send(loopId, elsewhere["id"])).status, 409);
  assert.equal((await send(loopId, "lc_comm_nope")).status, 404);
  assert.equal((await send("lc_loop_nope", elsewhere["id"])).status, 404);
  assert.equal(await store.read((tx) => tx.outbox().length), before);
});
