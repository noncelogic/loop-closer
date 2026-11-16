// LC-BUG-COMMS-PROPOSE-403: the communications scenario proposes its loop under an identity whose
// per-agent scope grant includes propose_loop, so the proposal is admitted; an identity without
// that grant is still refused with 403 (scopes are default-deny since LC-M3-T1c).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createServer } from "../../src/server.ts";
import type { InMemoryGraphStore } from "../../src/kernel/index.ts";
import { experiment, experimentProposal, joe, newKernel, repoRuns, resultsLand } from "./fixtures.ts";

const KEYS = new Map([
  ["agent:sender", "test-key-sender"],
  ["agent:drafter", "test-key-drafter"],
  ["joe", "test-key-joe"],
]);
// The sender's grant is exactly what the communications scenario drives; the drafter lacks propose_loop.
const SCOPES = new Map<string, readonly string[]>([
  ["agent:sender", ["propose_loop", "record_communication", "request_send"]],
  ["agent:drafter", ["record_communication", "open_loops"]],
]);

let server: Server;
let base: string;
let store: InMemoryGraphStore;

before(async () => {
  const env = newKernel();
  store = env.store;
  server = createServer({ kernel: env.kernel, apiKeys: KEYS, scopes: SCOPES });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function propose(principal: string, n: number): Promise<{ status: number; body: Record<string, any> }> {
  const what = { ...experiment, id: `lc_what_comms_propose_${n}` };
  const res = await fetch(`${base}/loops/propose`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEYS.get(principal)!}`, "content-type": "application/json" },
    body: JSON.stringify(experimentProposal({
      name: `Comms propose ${n}`,
      loop_type: "factory-notification",
      nodes: [joe, what, repoRuns, resultsLand],
      edges: [{ from_id: what.id, to_id: repoRuns.id, edge_type: "is_waiting_on" }],
      actor: principal,
    })),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

test("proposes a loop under an identity granted propose_loop", async () => {
  const proposed = await propose("agent:sender", 1);
  assert.equal(proposed.status, 201, JSON.stringify(proposed.body));
  const loopId = proposed.body["loop"]["id"] as string;
  assert.ok(await store.read((tx) => tx.getLoop(loopId)), "the admitted proposal is stored");
});

test("refuses a proposal from an identity without the propose_loop grant", async () => {
  const eventsBefore = await store.read((tx) => tx.ledger().length);
  const refused = await propose("agent:drafter", 2);
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.equal(refused.body["error"], "forbidden");
  assert.equal(await store.read((tx) => tx.ledger().length), eventsBefore, "a refused proposal records nothing");
});
