// LC-M1-T4 acceptance: propose_loop runs the dedup check before admission;
// accept_loop admits a proposed loop (SPEC B2.3 intake, B3).
import { test } from "node:test";
import assert from "node:assert/strict";
import { KernelError } from "../../src/kernel/index.ts";
import { assertValid, experiment, experimentProposal, joe, newKernel, repoRuns, resultsLand } from "./fixtures.ts";

test("propose then accept admits a loop after the dedup check", async () => {
  const { kernel, store, tick } = newKernel();

  // propose: a Loop in `proposed` state + a loop_proposed ledger event. Obliges nobody yet.
  const proposed = await kernel.proposeLoop(experimentProposal());
  assertValid("loop", proposed.loop);
  assertValid("ledger-event", proposed.ledger_event);
  assert.equal(proposed.loop.state, "proposed");
  assert.equal(proposed.loop.opened_at, null);
  assert.equal(proposed.loop.authority, "joe-approves-each");
  assert.equal(proposed.loop.closing_when_id, resultsLand.id);
  assert.deepEqual(
    [...proposed.loop.member_node_ids].sort(),
    [joe.id, experiment.id, repoRuns.id, resultsLand.id].sort(),
  );
  assert.equal(proposed.ledger_event.event_type, "loop_proposed");
  assert.equal(proposed.ledger_event.actor, "agent:juno");
  assert.ok(proposed.ledger_event.subject_ids.includes(proposed.loop.id));
  const loopId = proposed.loop.id;

  // The subgraph was stored: nodes and edges are in the graph.
  const edges = await store.read((tx) => tx.edgesTouching(experiment.id));
  assert.equal(edges.length, 2);
  for (const e of edges) assertValid("edge", e);

  // A proposed loop's Whens are not armed: firing does not move it.
  const early = await kernel.fireEvent({ when_id: resultsLand.id, idempotency_key: "early-fire" });
  assert.deepEqual(early.loop_ids, []);
  assert.equal((await kernel.getLoop(loopId)).state, "proposed");

  // dedup: same accountable Who + same What → rejected before admission, nothing written.
  const ledgerBefore = (await store.read((tx) => tx.ledger())).length;
  await assert.rejects(
    kernel.proposeLoop(experimentProposal({ name: "Same experiment, again", nodes: [{ ref: joe.id }, { ref: experiment.id }], edges: [], closing_when_id: undefined })),
    (err: unknown) => {
      assert.ok(err instanceof KernelError);
      assert.equal(err.code, "duplicate_loop");
      assert.deepEqual(err.details, { existing_loop_ids: [loopId] });
      return true;
    },
  );
  assert.equal((await store.read((tx) => tx.ledger())).length, ledgerBefore, "a duplicate writes nothing");

  // An unrelated What on the same Who is not a duplicate.
  const other = await kernel.proposeLoop({
    name: "Publish the packet",
    loop_type: "publishing",
    accountable_who_id: joe.id,
    nodes: [
      { ref: joe.id },
      {
        id: "lc_what_packet",
        kind: "what",
        created_at: "2026-11-10T08:00:00Z",
        status: "active",
        attributes: { what_type: "deliverable", title: "Sanitised packet" },
      },
    ],
    edges: [],
    actor: "agent:juno",
    rationale: "Separate deliverable.",
  });
  assert.equal(other.loop.state, "proposed");

  // accept: proposed → open, opened_at set, loop_accepted ledger event.
  tick(60);
  const accepted = await kernel.acceptLoop(loopId, { acceptor: "joe" });
  assertValid("loop", accepted.loop);
  assertValid("ledger-event", accepted.ledger_event);
  assert.equal(accepted.loop.state, "open");
  assert.equal(accepted.loop.opened_at, "2026-11-10T09:01:00.000Z");
  assert.equal(accepted.ledger_event.event_type, "loop_accepted");
  assert.deepEqual(accepted.ledger_event.payload, { from_state: "proposed", to_state: "open" });

  // Accepting twice is a conflict, not a second admission.
  await assert.rejects(kernel.acceptLoop(loopId, { acceptor: "joe" }), { code: "conflict" });
  await assert.rejects(kernel.acceptLoop("lc_loop_missing", { acceptor: "joe" }), { code: "not_found" });

  // The admitted loop answers open_loops from the stored graph.
  const open = await kernel.openLoops({ state: "open" });
  assert.deepEqual(open.loops.map((l) => l.loop.id), [loopId]);
  assert.deepEqual([...(open.loops[0]?.governing_when_ids ?? [])].sort(), [repoRuns.id, resultsLand.id].sort());
  const all = await kernel.openLoops({ accountable_who_id: joe.id });
  assert.deepEqual(all.loops.map((l) => l.loop.id).sort(), [loopId, other.loop.id].sort());
});

test("propose_loop rejects subgraphs that do not hold together", async () => {
  const { kernel } = newKernel();
  await assert.rejects(
    kernel.proposeLoop(experimentProposal({ accountable_who_id: experiment.id })),
    { code: "bad_request" },
    "accountable must be a Who",
  );
  await assert.rejects(
    kernel.proposeLoop(experimentProposal({ nodes: [joe, repoRuns], edges: [], closing_when_id: undefined })),
    { code: "bad_request" },
    "a loop needs a What",
  );
  await assert.rejects(
    kernel.proposeLoop(experimentProposal({ nodes: [{ ref: "lc_who_nobody" }] })),
    { code: "not_found" },
  );
  await assert.rejects(
    kernel.proposeLoop(experimentProposal({ edges: [{ from_id: experiment.id, to_id: "lc_when_elsewhere", edge_type: "depends_on" }] })),
    { code: "bad_request" },
    "edges stay inside the proposed subgraph",
  );
});
