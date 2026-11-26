// Journey (COND-342; delivery.yaml `deploy.journeys`): a loop's whole life,
// driven over HTTP against a deployed candidate, the way its principals use it.
// Hermes (an agent, scoped by deploy/base/api-scopes/hermes) proposes a loop
// and may not accept it; Joe accepts it; Hermes sees it open; Joe fires its
// closing When and it closes; the ledger Hermes reads records each step. A
// caller without a key is refused.
//
// Runs only against a candidate deployed by .github/scripts/deploy-candidate.mjs
// (the deploy workflow's `deploy` job): CANDIDATE_URL is its API and
// CANDIDATE_KEYS_DIR holds each principal's key. Every id carries a fresh
// suffix, so a journey repeated on the same candidate starts a new loop.
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const base = process.env["CANDIDATE_URL"] ?? "";
const keysDir = process.env["CANDIDATE_KEYS_DIR"] ?? "";
const keys: Record<string, string> = {};

before(() => {
  assert.ok(base && keysDir, "CANDIDATE_URL and CANDIDATE_KEYS_DIR are unset: deploy a candidate first (deploy-candidate.mjs up)");
  for (const who of ["joe", "hermes"]) keys[who] = readFileSync(join(keysDir, who), "utf8").trim();
});

async function call(who: string | null, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (who !== null) headers["authorization"] = `Bearer ${keys[who]}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${base}/v1${path}`, {
    method,
    headers,
    signal: AbortSignal.timeout(15_000),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json() };
}

function proposal(suffix: string): Record<string, unknown> {
  const at = "2026-11-25T08:00:00Z";
  const joe = `lc_who_joe_${suffix}`;
  const experiment = `lc_what_experiment_${suffix}`;
  const repoRuns = `lc_when_repo_runs_${suffix}`;
  const resultsLand = `lc_when_results_land_${suffix}`;
  const when = (id: string, eventType: string, source: string) => ({
    id,
    kind: "when",
    created_at: at,
    status: "active",
    attributes: { when_type: "event", event_type: eventType, source_binding: { source, mechanism: source === "ci" ? "webhook" : "manual" }, fired_at: null, fire_count: 0 },
  });
  return {
    name: `Replicate paper ${suffix}`,
    loop_type: "publishing",
    accountable_who_id: joe,
    nodes: [
      { id: joe, kind: "who", created_at: at, status: "active", attributes: { who_type: "person", name: "Joe", contact_points: [], external_ids: {} } },
      { id: experiment, kind: "what", created_at: at, status: "active", attributes: { what_type: "action", title: "Run the experiment the paper proposes" } },
      when(repoRuns, "repo_runs", "ci"),
      when(resultsLand, "results_landed", "manual"),
    ],
    edges: [
      { from_id: experiment, to_id: repoRuns, edge_type: "is_waiting_on" },
      { from_id: repoRuns, to_id: experiment, edge_type: "enables" },
    ],
    closing_when_id: resultsLand,
    actor: "agent:hermes",
    rationale: "Journey: a top-ranked paper the owner chose to pursue.",
  };
}

test("a loop is proposed by an agent, accepted by Joe, closed by its closing When, and ledgered", { timeout: 60_000 }, async () => {
  const health = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(15_000) });
  assert.deepEqual(await health.json(), { service: "loopcloser", status: "ok" });

  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const input = proposal(suffix);

  const proposed = await call("hermes", "POST", "/loops/propose", input);
  assert.equal(proposed.status, 201, JSON.stringify(proposed.body));
  const loopId: string = proposed.body.loop.id;
  assert.equal(proposed.body.loop.state, "proposed");

  const refused = await call("hermes", "POST", `/loops/${loopId}/accept`, { acceptor: "hermes" });
  assert.equal(refused.status, 403, `an agent may not accept a loop: ${JSON.stringify(refused.body)}`);

  const accepted = await call("joe", "POST", `/loops/${loopId}/accept`, { acceptor: "joe" });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.loop.state, "open");

  const open = await call("hermes", "GET", "/loops");
  assert.equal(open.status, 200, JSON.stringify(open.body));
  const mine = (open.body.loops as Array<{ loop: { id: string; state: string } }>).filter((o) => o.loop.id === loopId);
  assert.deepEqual(mine.map((o) => o.loop.state), ["open"], "Hermes sees the accepted loop open");

  const fired = await call("joe", "POST", "/events/fire", { when_id: input["closing_when_id"], idempotency_key: `journey-${suffix}` });
  assert.equal(fired.status, 200, JSON.stringify(fired.body));
  assert.deepEqual(fired.body.loop_ids, [loopId]);

  const stillOpen = await call("joe", "GET", "/loops");
  assert.equal(stillOpen.status, 200, JSON.stringify(stillOpen.body));
  assert.equal((stillOpen.body.loops as Array<{ loop: { id: string } }>).some((o) => o.loop.id === loopId), false, "the closed loop left the open loops");

  // One page: a fresh candidate's ledger holds far fewer than 500 events.
  const ledger = await call("hermes", "GET", "/ledger/events?limit=500");
  assert.equal(ledger.status, 200, JSON.stringify(ledger.body));
  const events = ledger.body.events as Array<{ event_type: string; subject_ids: string[]; payload: Record<string, unknown> }>;
  assert.ok(events.length < 500, "the ledger did not fit one page");
  const ofLoop = events.filter((e) => e.subject_ids.includes(loopId));
  assert.deepEqual(
    ofLoop.map((e) => (e.event_type === "transition" ? `transition:${String(e.payload["to_state"])}` : e.event_type)),
    ["loop_proposed", "loop_accepted", "when_fired", "transition:closed"],
  );
});

test("a caller without an agent key is refused", { timeout: 30_000 }, async () => {
  const anonymous = await call(null, "GET", "/loops");
  assert.equal(anonymous.status, 401, JSON.stringify(anonymous.body));
});
