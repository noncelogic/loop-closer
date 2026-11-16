// LC-M3-T2 acceptance: loop-type policies as data (SPEC B4). The
// factory-notification loop type inherits authority autonomous from its policy
// (owner decision 2026-11-15 item 5, notifications-design.md) and may send only
// to the owner's own receivers; every other loop type keeps joe-approves-each.
import { test } from "node:test";
import assert from "node:assert/strict";
import { KernelError, LOOP_TYPE_POLICIES, type Kernel, type Node } from "../../src/kernel/index.ts";
import { assertValid, experiment, experimentProposal, joe, newKernel, repoRuns, resultsLand } from "./fixtures.ts";

const T0 = "2026-11-10T08:00:00Z";

/** Joe's phone: a receiver Joe registered by owning it. */
const joePhone: Node = {
  id: "lc_who_joe_phone",
  kind: "who",
  created_at: T0,
  status: "active",
  attributes: { who_type: "device", name: "Joe's phone", contact_points: [], external_ids: {} },
};

const stranger: Node = {
  id: "lc_who_stranger",
  kind: "who",
  created_at: T0,
  status: "active",
  attributes: { who_type: "person", name: "Someone else", contact_points: [], external_ids: {} },
};

const HASH = `sha256:${"ab".repeat(32)}`;

async function openNotificationLoop(kernel: Kernel, suffix: string): Promise<string> {
  const what = { ...experiment, id: `lc_what_notify_${suffix}`, attributes: { what_type: "action", title: "Tell Joe the factory is blocked" } };
  const proposed = await kernel.proposeLoop(experimentProposal({
    name: `Factory notification ${suffix}`,
    loop_type: "factory-notification",
    nodes: [joe, joePhone, stranger, what, repoRuns, resultsLand],
    edges: [{ from_id: joe.id, to_id: joePhone.id, edge_type: "owns" }],
    closing_when_id: resultsLand.id,
  }));
  await kernel.acceptLoop(proposed.loop.id, { acceptor: "joe" });
  return proposed.loop.id;
}

function outbound(loopId: string, participants: string[]) {
  return {
    thread_id: "factory:notify",
    channel: "message" as const,
    direction: "outbound" as const,
    participant_who_ids: participants,
    at: "2026-11-10T09:00:00Z",
    body_pointer: "minio://loopcloser/originals/x",
    body_hash: HASH,
    loop_id: loopId,
  };
}

test("a factory-notification loop inherits autonomous authority and other types keep joe-approves-each", async () => {
  const { kernel, store } = newKernel();

  const loopId = await openNotificationLoop(kernel, "a");
  const loop = await kernel.getLoop(loopId);
  assertValid("loop", loop);
  assert.equal(loop.authority, "autonomous");
  const policy = LOOP_TYPE_POLICIES.find((p) => p.loop_type === "factory-notification");
  assert.ok(policy, "factory-notification has a loop-type policy");
  assert.equal(policy.authority, "autonomous");
  assert.deepEqual(loop.policy_refs.escalation, { id: policy.escalation.id, version: policy.escalation.version });
  assert.deepEqual([...policy.escalation.stop_conditions], ["ack", "resolve", "answered"]);
  assert.ok("max_attempts" in policy.escalation && "min_interval_seconds" in policy.escalation);

  // must_allow: a send to the owner's receiver (Joe, or a receiver Joe owns) is enqueued without approval.
  for (const receiver of [joe.id, joePhone.id]) {
    const comm = await kernel.recordCommunication(outbound(loopId, [receiver]));
    const result = await kernel.requestSend(loopId, { communication_id: comm.id, actor: "agent:sender" });
    assert.deepEqual(result, { communication_id: comm.id, authority: "autonomous", status: "enqueued" });
    const queued = await store.read((tx) => tx.outbox().filter((e) => e.payload["communication_id"] === comm.id));
    assert.equal(queued.length, 1);
  }

  // must_catch: no other loop type inherits autonomous, including near-miss names.
  for (const loop_type of ["publishing", "factory-notifications", "notification", "bcba-comms"]) {
    const what = { ...experiment, id: `lc_what_other_${loop_type}` };
    const other = await kernel.proposeLoop(experimentProposal({ loop_type, nodes: [joe, what, repoRuns, resultsLand], edges: [] }));
    assert.equal(other.loop.authority, "joe-approves-each", `${loop_type} keeps joe-approves-each`);
    await kernel.acceptLoop(other.loop.id, { acceptor: "joe" });
    const comm = await kernel.recordCommunication(outbound(other.loop.id, [joe.id]));
    const result = await kernel.requestSend(other.loop.id, { communication_id: comm.id, actor: "agent:sender" });
    assert.equal(result.status, "pending_approval");
  }
  for (const p of LOOP_TYPE_POLICIES)
    if (p.loop_type !== "factory-notification") assert.notEqual(p.authority, "autonomous", `${p.loop_type} is not autonomous`);
});

test("a factory-notification send to a receiver other than the owner's is refused", async () => {
  const { kernel, store } = newKernel();
  const loopId = await openNotificationLoop(kernel, "b");

  for (const participants of [[stranger.id], [joe.id, stranger.id]]) {
    const comm = await kernel.recordCommunication(outbound(loopId, participants));
    await assert.rejects(
      kernel.requestSend(loopId, { communication_id: comm.id, actor: "agent:sender" }),
      (err: unknown) => {
        assert.ok(err instanceof KernelError);
        assert.equal(err.code, "conflict");
        assert.deepEqual(err.details, { refused_receiver_ids: [stranger.id] });
        return true;
      },
    );
    // Nothing is sent...
    const queued = await store.read((tx) => tx.outbox().filter((e) => e.payload["communication_id"] === comm.id));
    assert.deepEqual(queued, []);
    const sent = await store.read((tx) => tx.ledger().filter((e) => e.event_type === "communication_sent" && e.subject_ids.includes(comm.id)));
    assert.deepEqual(sent, []);
    assert.equal((await store.read((tx) => tx.getCommunication(comm.id)))?.sent_under_authority, null);
    // ...and the refusal is recorded; it cannot be approved or retried into a send.
    const request = await store.read((tx) => tx.getSendRequest(comm.id));
    assert.equal(request?.status, "refused");
    assert.deepEqual(request?.refused_receiver_ids, [stranger.id]);
    await assert.rejects(kernel.approveSend(comm.id, { approver: "joe" }), (err: unknown) => err instanceof KernelError && err.code === "conflict");
    await assert.rejects(kernel.requestSend(loopId, { communication_id: comm.id, actor: "agent:sender" }), (err: unknown) => err instanceof KernelError && err.code === "conflict");
  }
});
