// LC-M3-T1 acceptance: the loopcloser HTTP server answers the loop operations
// of contracts/openapi.json through the kernel, with request and response
// bodies that validate against the frozen contract.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { connect, type AddressInfo } from "node:net";
import type { Server } from "node:http";
import { B3_OPERATIONS, createApiValidator } from "../../src/contracts/index.ts";
import { Kernel, type InMemoryGraphStore } from "../../src/kernel/index.ts";
import { createServer } from "../../src/server.ts";
import { experiment, experimentProposal, joe, newKernel, repoRuns, resultsLand } from "../kernel/fixtures.ts";

const KEY = "test-key-juno";
const api = createApiValidator();

let server: Server;
let base: string;
let store: InMemoryGraphStore;
let tick: (seconds: number) => void;

before(async () => {
  const env = newKernel();
  store = env.store;
  tick = env.tick;
  server = createServer({ kernel: env.kernel, apiKeys: new Map([["agent:juno", KEY]]), scopes: new Map([["agent:juno", B3_OPERATIONS]]) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

interface Call {
  status: number;
  body: unknown;
}

/** Calls an operation; both the request and the response are checked against the contract. */
async function call(operationId: string, method: string, path: string, body?: unknown, key: string | null = KEY): Promise<Call> {
  if (body !== undefined) {
    const validate = api.request(operationId);
    assert.ok(validate, `${operationId} has a request schema`);
    assert.ok(validate(body), `request for ${operationId} should match the contract: ${api.ajv.errorsText(validate.errors)}`);
  }
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (key !== null) headers["authorization"] = `Bearer ${key}`;
  const res = await fetch(`${base}/v1${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
  const parsed: unknown = await res.json();
  const validate = api.response(operationId, res.status);
  assert.ok(validate, `${operationId} declares a ${res.status} response (body: ${JSON.stringify(parsed)})`);
  assert.ok(validate(parsed), `${operationId} ${res.status} response should match the contract: ${api.ajv.errorsText(validate.errors)}`);
  return { status: res.status, body: parsed };
}

type Obj = Record<string, any>;
const evidence = { kind: "communication", id: "lc_comm_1" } as const;

async function proposeAndAccept(name: string, whatId: string): Promise<string> {
  const what = { ...experiment, id: whatId };
  const proposal = experimentProposal({
    name,
    nodes: [{ ref: joe.id }, what, { ref: repoRuns.id }, { ref: resultsLand.id }],
    edges: [{ from_id: what.id, to_id: repoRuns.id, edge_type: "is_waiting_on" }],
  });
  const proposed = await call("propose_loop", "POST", "/loops/propose", proposal);
  assert.equal(proposed.status, 201);
  const loopId = (proposed.body as Obj)["loop"]["id"] as string;
  const accepted = await call("accept_loop", "POST", `/loops/${loopId}/accept`, { acceptor: "joe" });
  assert.equal(accepted.status, 200);
  return loopId;
}

test("propose, accept and transition a loop over HTTP against the frozen contract", async () => {
  // Writes need the API key.
  const anonymous = await call("propose_loop", "POST", "/loops/propose", experimentProposal(), null);
  assert.equal(anonymous.status, 401);
  const wrongKey = await call("propose_loop", "POST", "/loops/propose", experimentProposal(), "not-a-key");
  assert.equal(wrongKey.status, 401);

  const proposed = await call("propose_loop", "POST", "/loops/propose", experimentProposal());
  assert.equal(proposed.status, 201);
  const loop = (proposed.body as Obj)["loop"];
  assert.equal(loop["state"], "proposed");
  assert.equal((proposed.body as Obj)["ledger_event"]["event_type"], "loop_proposed");

  // The dedup check answers with the contract's DuplicateLoop body.
  const duplicate = await call("propose_loop", "POST", "/loops/propose", experimentProposal({
    nodes: [{ ref: joe.id }, { ref: experiment.id }],
    edges: [],
    closing_when_id: undefined,
  }));
  assert.equal(duplicate.status, 409);
  assert.deepEqual((duplicate.body as Obj)["existing_loop_ids"], [loop["id"]]);

  // A request that does not match the contract is a 400, before the kernel sees it.
  const bad = await fetch(`${base}/v1/loops/${loop["id"]}/accept`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ acceptor: "joe", extra: true }),
  });
  assert.equal(bad.status, 400);

  const accepted = await call("accept_loop", "POST", `/loops/${loop["id"]}/accept`, { acceptor: "joe" });
  assert.equal(accepted.status, 200);
  assert.equal((accepted.body as Obj)["loop"]["state"], "open");

  const again = await call("accept_loop", "POST", `/loops/${loop["id"]}/accept`, { acceptor: "joe" });
  assert.equal(again.status, 409);
  const missing = await call("accept_loop", "POST", "/loops/lc_loop_nope/accept", { acceptor: "joe" });
  assert.equal(missing.status, 404);

  tick(60);
  const moved = await call("transition", "POST", `/loops/${loop["id"]}/transition`, {
    to_state: "waiting",
    actor: "agent:juno",
    evidence,
    idempotency_key: "http-t-1",
  });
  assert.equal(moved.status, 200);
  assert.equal((moved.body as Obj)["loop"]["state"], "waiting");
  assert.deepEqual((moved.body as Obj)["ledger_event"]["payload"], { from_state: "open", to_state: "waiting", evidence });

  const illegal = await call("transition", "POST", `/loops/${loop["id"]}/transition`, {
    to_state: "proposed",
    actor: "agent:juno",
    evidence,
    idempotency_key: "http-t-2",
  });
  assert.equal(illegal.status, 409);

  // Reads follow the contract: open_loops lists the waiting loop.
  const listed = await call("open_loops", "GET", "/loops?state=waiting");
  assert.equal(listed.status, 200);
  assert.deepEqual(((listed.body as Obj)["loops"] as Obj[]).map((l) => l["loop"]["id"]), [loop["id"]]);
  assert.equal((await call("open_loops", "GET", "/loops?breaching_only=maybe")).status, 400);
  assert.equal((await call("open_loops", "GET", "/loops", undefined, null)).status, 401);

  // fire_event closes it through its closing When.
  const fired = await call("fire_event", "POST", "/events/fire", { when_id: resultsLand.id, idempotency_key: "http-fire-1" });
  assert.equal(fired.status, 200);
  assert.deepEqual((fired.body as Obj)["loop_ids"], [loop["id"]]);
  const unknownWhen = await call("fire_event", "POST", "/events/fire", { when_id: "lc_when_nope", idempotency_key: "http-fire-2" });
  assert.equal(unknownWhen.status, 404);
  const closed = await call("open_loops", "GET", `/loops?accountable_who_id=${joe.id}`);
  assert.ok(!((closed.body as Obj)["loops"] as Obj[]).some((l) => l["loop"]["id"] === loop["id"]));

  // reject_loop closes a proposed loop at intake.
  const other = await call("propose_loop", "POST", "/loops/propose", experimentProposal({
    name: "Another paper",
    nodes: [{ ref: joe.id }, { ...experiment, id: "lc_what_other" }],
    edges: [],
    closing_when_id: undefined,
  }));
  assert.equal(other.status, 201);
  const rejected = await call("reject_loop", "POST", `/loops/${(other.body as Obj)["loop"]["id"]}/reject`, {
    actor: "joe",
    reason: "Not worth pursuing",
  });
  assert.equal(rejected.status, 200);
  assert.equal((rejected.body as Obj)["loop"]["state"], "closed_with_reason");
  assert.equal((rejected.body as Obj)["loop"]["close_reason"], "rejected");
  assert.equal((rejected.body as Obj)["ledger_event"]["event_type"], "loop_rejected");

  // health answers the contract's metrics.
  const health = await call("health", "GET", "/health?window=P7D");
  assert.equal(health.status, 200);
  assert.equal((health.body as Obj)["window"], "P7D");
  assert.equal((await call("health", "GET", "/health?window=soon")).status, 400);
});

test("a repeated transition with the same idempotency key returns the first result", async () => {
  const loopId = await proposeAndAccept("Idempotent loop", "lc_what_idem");
  const request = { to_state: "chased", actor: "agent:juno", evidence, idempotency_key: "http-idem-1" };

  const first = await call("transition", "POST", `/loops/${loopId}/transition`, request);
  assert.equal(first.status, 200);
  tick(60);
  const second = await call("transition", "POST", `/loops/${loopId}/transition`, request);
  assert.equal(second.status, 200);
  assert.deepEqual(second.body, first.body);

  // Applied once: one transition event with that key in the ledger.
  const events = await store.read(async (tx) => (await tx.ledger()).filter((e) => e.idempotency_key === "http-idem-1"));
  assert.equal(events.length, 1);

  // The same key for a different change is a conflict.
  const reused = await call("transition", "POST", `/loops/${loopId}/transition`, { ...request, to_state: "waiting" });
  assert.equal(reused.status, 409);
});

test("a replayed transition returns the first result after a later transition", async () => {
  const loopId = await proposeAndAccept("Replay after change", "lc_what_replay");
  const toWaiting = { to_state: "waiting", actor: "agent:juno", evidence, idempotency_key: "http-replay-a" };

  const first = await call("transition", "POST", `/loops/${loopId}/transition`, toWaiting);
  assert.equal(first.status, 200);
  assert.equal((first.body as Obj)["loop"]["state"], "waiting");
  tick(60);
  const later = await call("transition", "POST", `/loops/${loopId}/transition`, { ...toWaiting, to_state: "chased", idempotency_key: "http-replay-b" });
  assert.equal(later.status, 200);
  assert.equal((later.body as Obj)["loop"]["state"], "chased");

  const replay = await call("transition", "POST", `/loops/${loopId}/transition`, toWaiting);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, first.body);

  // The replay changed nothing: the loop stays chased.
  const loop = await store.read((tx) => tx.getLoop(loopId));
  assert.equal(loop?.state, "chased");
});

test("a request target that is not a valid URL is a client error and the server keeps serving", async () => {
  const { port } = server.address() as AddressInfo;
  const raw = await new Promise<string>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => socket.end("GET //[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"));
    let data = "";
    socket.on("data", (chunk) => (data += chunk.toString("utf8")));
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
  });
  assert.match(raw, /^HTTP\/1\.1 400 /);

  const healthz = await fetch(`${base}/healthz`);
  assert.equal(healthz.status, 200);
});

test("what-fires-next lists the next firing of an open loop", async () => {
  const loopId = await proposeAndAccept("Firing loop", "lc_what_fires");

  const next = await call("what_fires_next", "GET", `/what-fires-next?loop_id=${loopId}`);
  assert.equal(next.status, 200);
  const byWhen = new Map(((next.body as Obj)["effects"] as Obj[]).map((e) => [e["when_id"], e]));
  assert.equal(byWhen.get(resultsLand.id)?.["next_state"], "closed");
  assert.equal(byWhen.get(resultsLand.id)?.["loop_id"], loopId);
  assert.ok(byWhen.has(repoRuns.id));

  const forWhen = await call("what_fires_next", "GET", `/what-fires-next?when_id=${resultsLand.id}`);
  assert.equal(forWhen.status, 200);
  assert.ok(((forWhen.body as Obj)["effects"] as Obj[]).some((e) => e["loop_id"] === loopId && e["next_state"] === "closed"));

  assert.equal((await call("what_fires_next", "GET", "/what-fires-next")).status, 400);
  assert.equal((await call("what_fires_next", "GET", `/what-fires-next?loop_id=${loopId}&when_id=${resultsLand.id}`)).status, 400);
  assert.equal((await call("what_fires_next", "GET", "/what-fires-next?loop_id=lc_loop_nope")).status, 404);
});

test("GET /healthz keeps answering without a key", async () => {
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { service: "loopcloser", status: "ok" });
});

test("a response body that does not match the contract is withheld", async () => {
  const env = newKernel();
  class DriftingKernel extends Kernel {
    override async openLoops(): Promise<{ loops: never[] }> {
      return { loops: [], unexpected: true } as unknown as { loops: never[] };
    }
  }
  const drifting = createServer({ kernel: new DriftingKernel(env.store), apiKeys: new Map([["agent:juno", KEY]]), scopes: new Map([["agent:juno", B3_OPERATIONS]]) });
  await new Promise<void>((resolve) => drifting.listen(0, "127.0.0.1", resolve));
  try {
    const original = console.error;
    console.error = () => undefined;
    try {
      const res = await fetch(`http://127.0.0.1:${(drifting.address() as AddressInfo).port}/v1/loops`, {
        headers: { authorization: KEY },
      });
      assert.equal(res.status, 500);
      const body = (await res.json()) as Obj;
      assert.equal(body["error"], "internal");
      assert.ok(!("unexpected" in body));
    } finally {
      console.error = original;
    }
  } finally {
    await new Promise<void>((resolve) => drifting.close(() => resolve()));
  }
});

// LC-M4-T1: a loop may carry an opaque external reference to the key result it serves.
const okr = { system: "plane", id: "KR-42" } as const;

test("a loop proposed with a key-result reference returns it from open_loops", async () => {
  const proposed = await call("propose_loop", "POST", "/loops/propose", experimentProposal({
    name: "Serves KR-42",
    nodes: [{ ref: joe.id }, { ...experiment, id: "lc_what_kr_carry" }],
    edges: [],
    closing_when_id: undefined,
    key_result_ref: okr,
  }));
  assert.equal(proposed.status, 201);
  const loop = (proposed.body as Obj)["loop"];
  assert.deepEqual(loop["key_result_ref"], okr);

  const listed = await call("open_loops", "GET", `/loops?accountable_who_id=${joe.id}`);
  const found = ((listed.body as Obj)["loops"] as Obj[]).find((l) => l["loop"]["id"] === loop["id"]);
  assert.ok(found, "the proposed loop is listed");
  assert.deepEqual(found["loop"]["key_result_ref"], okr);

  // A loop proposed without a reference behaves as before: no key_result_ref field.
  const plain = await call("propose_loop", "POST", "/loops/propose", experimentProposal({
    name: "Serves nothing in particular",
    nodes: [{ ref: joe.id }, { ...experiment, id: "lc_what_kr_none" }],
    edges: [],
    closing_when_id: undefined,
  }));
  assert.equal(plain.status, 201);
  assert.equal("key_result_ref" in (plain.body as Obj)["loop"], false);

  // A malformed reference is refused by the contract.
  const bad = await fetch(`${base}/v1/loops/propose`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify(experimentProposal({
      nodes: [{ ref: joe.id }, { ...experiment, id: "lc_what_kr_bad" }],
      edges: [],
      closing_when_id: undefined,
      key_result_ref: { system: "plane" } as never,
    })),
  });
  assert.equal(bad.status, 400);
});

test("open_loops filters by key-result reference", async () => {
  const propose = async (whatId: string, ref?: { system: string; id: string }): Promise<string> => {
    const res = await call("propose_loop", "POST", "/loops/propose", experimentProposal({
      name: `Filter ${whatId}`,
      nodes: [{ ref: joe.id }, { ...experiment, id: whatId }],
      edges: [],
      closing_when_id: undefined,
      ...(ref ? { key_result_ref: ref } : {}),
    }));
    assert.equal(res.status, 201);
    return (res.body as Obj)["loop"]["id"] as string;
  };
  const a = await propose("lc_what_kr_a", { system: "plane", id: "KR-7" });
  const b = await propose("lc_what_kr_b", { system: "plane", id: "KR-8" });
  const c = await propose("lc_what_kr_c", { system: "linear", id: "KR-7" });
  const none = await propose("lc_what_kr_d");

  const ids = async (query: string): Promise<string[]> => {
    const res = await call("open_loops", "GET", `/loops?${query}`);
    assert.equal(res.status, 200);
    return ((res.body as Obj)["loops"] as Obj[]).map((l) => l["loop"]["id"] as string);
  };
  assert.deepEqual(await ids("key_result_system=plane&key_result_id=KR-7"), [a]);
  assert.deepEqual(await ids("key_result_system=linear&key_result_id=KR-7"), [c]);
  assert.deepEqual(await ids("key_result_system=plane&key_result_id=KR-404"), []);
  // One half of a reference alone is not a reference.
  assert.equal((await call("open_loops", "GET", "/loops?key_result_id=KR-7")).status, 400);
  assert.equal((await call("open_loops", "GET", "/loops?key_result_system=plane")).status, 400);
  // Without the filter every loop is listed, with or without a reference.
  const all = await ids(`accountable_who_id=${joe.id}`);
  for (const id of [a, b, c, none]) assert.ok(all.includes(id));
});
