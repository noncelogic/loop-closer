// LC-M4-T2 acceptance: an agent with the ledger_events scope reads the ledger
// in commit order after a cursor it was given, page by page, with a next
// cursor; across pages no event is skipped or repeated, and a page with nothing
// new is empty and hands back the same cursor (SPEC B2.4: the ledger is the
// system's memory of itself; harnesses are replaceable readers).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApiValidator } from "../../src/contracts/index.ts";
import type { InMemoryGraphStore, Kernel, LedgerEvent } from "../../src/kernel/index.ts";
import { createServer } from "../../src/server.ts";
import { experiment, experimentProposal, joe, newKernel, repoRuns, resultsLand } from "../kernel/fixtures.ts";

const KEYS = new Map([
  ["agent:juno", "test-key-juno"],
  ["agent:historian", "test-key-historian"],
  ["agent:reader", "test-key-reader"],
  ["agent:unscoped", "test-key-unscoped"],
]);
const SCOPES = new Map<string, string[]>([
  ["agent:juno", ["propose_loop", "accept_loop", "transition"]],
  ["agent:historian", ["ledger_events"]],
  ["agent:reader", ["open_loops", "what_fires_next", "health"]],
]);

const api = createApiValidator();
/** Kernel method names in the order the server called them. */
const calls: string[] = [];
let server: Server;
let base: string;
let store: InMemoryGraphStore;

before(async () => {
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
  server = createServer({ kernel: spy, apiKeys: KEYS, scopes: SCOPES });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

type Obj = Record<string, any>;

/** Calls an operation; every response body is checked against the contract. */
async function call(principal: string, operationId: string, method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; body: Obj }> {
  const res = await fetch(`${base}/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${KEYS.get(principal)!}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const parsed = (await res.json()) as Obj;
  const validate = api.response(operationId, res.status);
  assert.ok(validate, `${operationId} declares a ${res.status} response (body: ${JSON.stringify(parsed)})`);
  assert.ok(validate(parsed), `${operationId} ${res.status} response should match the contract: ${api.ajv.errorsText(validate.errors)}`);
  return { status: res.status, body: parsed };
}

let seq = 0;

/** Commits a proposal, an acceptance and a transition: three ledger events. */
async function commitLoop(): Promise<void> {
  seq += 1;
  const what = { ...experiment, id: `lc_what_ledger_${seq}` };
  const proposed = await call("agent:juno", "propose_loop", "POST", "/loops/propose", experimentProposal({
    name: `Ledger loop ${seq}`,
    nodes: [joe, what, repoRuns, resultsLand],
    edges: [{ from_id: what.id, to_id: repoRuns.id, edge_type: "is_waiting_on" }],
  }));
  assert.equal(proposed.status, 201, JSON.stringify(proposed.body));
  const loopId = proposed.body["loop"]["id"] as string;
  assert.equal((await call("agent:juno", "accept_loop", "POST", `/loops/${loopId}/accept`, { acceptor: "joe" })).status, 200);
  const moved = await call("agent:juno", "transition", "POST", `/loops/${loopId}/transition`, {
    to_state: "waiting",
    actor: "agent:juno",
    evidence: { kind: "communication", id: "lc_comm_1" },
    idempotency_key: `ledger-${seq}`,
  });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
}

async function page(cursor: string | undefined, limit: number): Promise<{ events: LedgerEvent[]; next_cursor: string }> {
  const q = new URLSearchParams({ limit: String(limit) });
  if (cursor !== undefined) q.set("after", cursor);
  const res = await call("agent:historian", "ledger_events", "GET", `/ledger/events?${q}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body as { events: LedgerEvent[]; next_cursor: string };
}

test("paging after a cursor returns every committed event once in commit order", async () => {
  await commitLoop();
  await commitLoop();

  // Page through, committing more between pages: nothing skipped, nothing repeated.
  const read: LedgerEvent[] = [];
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    const p = await page(cursor, 2);
    assert.ok(p.events.length <= 2, "a page holds at most limit events");
    if (p.events.length === 0) {
      assert.equal(p.next_cursor, cursor, "an empty page hands back the same cursor");
      break;
    }
    assert.notEqual(p.next_cursor, cursor, "the cursor advances past a non-empty page");
    read.push(...p.events);
    cursor = p.next_cursor;
    pages += 1;
    assert.ok(pages < 50, "paging terminates");
    if (pages === 2) await commitLoop();
  }

  const committed = await store.read((tx) => tx.ledger());
  assert.equal(committed.length, 9);
  assert.equal(new Set(read.map((e) => e.id)).size, read.length, "no event repeated");
  assert.deepEqual(read, committed, "every committed event once, in commit order");

  // Nothing new: the same cursor, again and again.
  for (let i = 0; i < 2; i += 1) assert.deepEqual(await page(cursor, 5), { events: [], next_cursor: cursor });

  // New commits are exactly what follows the held cursor.
  await commitLoop();
  const fresh = await page(cursor, 100);
  assert.deepEqual(fresh.events, (await store.read((tx) => tx.ledger())).slice(9));
  assert.equal(fresh.events.length, 3);

  // The default page starts at the beginning of the ledger.
  const first = await call("agent:historian", "ledger_events", "GET", "/ledger/events");
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { events: await store.read((tx) => tx.ledger()), next_cursor: fresh.next_cursor });

  // A cursor that was never handed out, or a bad limit, is a bad request.
  for (const q of ["after=999999", "after=not-a-cursor", "limit=0", "limit=10000", "limit=two"]) {
    const bad = await call("agent:historian", "ledger_events", "GET", `/ledger/events?${q}`);
    assert.equal(bad.status, 400, `${q}: ${JSON.stringify(bad.body)}`);
  }
});

test("an agent without the scope is refused", async () => {
  await commitLoop();
  calls.length = 0;
  for (const principal of ["agent:reader", "agent:juno", "agent:unscoped"]) {
    const refused = await call(principal, "ledger_events", "GET", "/ledger/events");
    assert.equal(refused.status, 403, `${principal}: ${JSON.stringify(refused.body)}`);
    assert.equal(refused.body["error"], "forbidden");
    assert.equal(refused.body["events"], undefined, "no events leak with a refusal");
  }
  assert.equal(calls.length, 0, `no handler ran: ${calls.join(", ")}`);

  const anonymous = await fetch(`${base}/v1/ledger/events`);
  assert.equal(anonymous.status, 401);

  assert.equal((await call("agent:historian", "ledger_events", "GET", "/ledger/events")).status, 200);
  assert.ok(calls.includes("ledgerEvents"));
});
