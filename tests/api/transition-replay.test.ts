// LC-M3-REPLAY-FIRST acceptance: replaying a transition with an idempotency key
// already used answers with the result that key first produced (its to_state and
// ledger event), never the loop's current state, and applies nothing.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { B3_OPERATIONS, createApiValidator } from "../../src/contracts/index.ts";
import type { InMemoryGraphStore } from "../../src/kernel/index.ts";
import { createServer } from "../../src/server.ts";
import { experiment, experimentProposal, joe, newKernel, repoRuns, resultsLand } from "../kernel/fixtures.ts";

const KEY = "test-key-replay";
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

type Obj = Record<string, any>;

/** Calls an operation; the request and the response are both checked against the contract. */
async function call(operationId: string, path: string, body: unknown): Promise<{ status: number; body: Obj }> {
  const request = api.request(operationId);
  assert.ok(request && request(body), `request for ${operationId} should match the contract`);
  const res = await fetch(`${base}/v1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  });
  const parsed = (await res.json()) as Obj;
  const response = api.response(operationId, res.status);
  assert.ok(response && response(parsed), `${operationId} ${res.status} response should match the contract: ${JSON.stringify(parsed)}`);
  return { status: res.status, body: parsed };
}

test("replaying key A after a later transition with key B returns the original waiting result and leaves the ledger unchanged", async () => {
  const what = { ...experiment, id: "lc_what_replay_first" };
  const proposed = await call(
    "propose_loop",
    "/loops/propose",
    experimentProposal({
      name: "Replay first result",
      nodes: [joe, what, repoRuns, resultsLand],
      edges: [{ from_id: what.id, to_id: repoRuns.id, edge_type: "is_waiting_on" }],
    }),
  );
  assert.equal(proposed.status, 201);
  const loopId = proposed.body["loop"]["id"] as string;
  assert.equal((await call("accept_loop", `/loops/${loopId}/accept`, { acceptor: "joe" })).status, 200);

  const evidence = { kind: "communication", id: "lc_comm_replay" };
  const keyA = { to_state: "waiting", actor: "agent:juno", evidence, idempotency_key: "replay-first-a" };
  const keyB = { to_state: "chased", actor: "agent:juno", evidence, idempotency_key: "replay-first-b" };

  const first = await call("transition", `/loops/${loopId}/transition`, keyA);
  assert.equal(first.status, 200);
  assert.equal(first.body["loop"]["state"], "waiting");
  tick(60);
  const later = await call("transition", `/loops/${loopId}/transition`, keyB);
  assert.equal(later.status, 200);
  assert.equal(later.body["loop"]["state"], "chased");

  const ledgerBefore = await store.read((tx) => tx.ledger());
  const loopBefore = await store.read((tx) => tx.getLoop(loopId));
  tick(60);

  const replay = await call("transition", `/loops/${loopId}/transition`, keyA);
  assert.equal(replay.status, 200);
  // The original waiting result, not the loop's current (chased) state.
  assert.equal(replay.body["loop"]["state"], "waiting");
  assert.equal(replay.body["ledger_event"]["payload"]["to_state"], "waiting");
  assert.deepEqual(replay.body["ledger_event"], first.body["ledger_event"]);
  assert.deepEqual(replay.body, first.body);

  // Nothing applied: the ledger and the loop are exactly as before the replay.
  assert.deepEqual(await store.read((tx) => tx.ledger()), ledgerBefore);
  assert.deepEqual(await store.read((tx) => tx.getLoop(loopId)), loopBefore);
  assert.equal(loopBefore?.state, "chased");
});
