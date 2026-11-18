// Loop Closer kernel (SPEC B3, Phase 0): intake (propose → dedup → accept),
// manual `transition` and `fire_event`, and the `open_loops` /
// `what_fires_next` queries — all answered from the stored graph, never by
// similarity. Every state change is written with its ledger event in one
// store transaction.
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createValidator, SCHEMA_ID_BASE } from "../contracts/index.ts";
import { anchorCalendarWhen } from "../timer/schedule.ts";
import { DEFAULT_AUTHORITY, LOOP_TYPE_POLICIES, loopTypePolicy, type LoopTypePolicy } from "./policies.ts";
import type { GraphStore, GraphTx } from "./store.ts";
import type {
  AcceptLoopInput,
  ApproveSendInput,
  ApproveSendResult,
  Authority,
  Communication,
  Edge,
  EdgeType,
  FireEventInput,
  FireEventResult,
  FiringEffect,
  HealthMetrics,
  LedgerEvent,
  LedgerEventsPage,
  LedgerEventType,
  Loop,
  LoopState,
  LoopWithEvent,
  Node,
  OpenLoop,
  OpenLoopsFilter,
  PolicyRef,
  ProposeLoopInput,
  RecordCommunicationInput,
  RejectLoopInput,
  RequestSendInput,
  SendRequest,
  SendRequestResult,
  TransitionInput,
  TransitionResult,
} from "./types.ts";

export type KernelErrorCode = "bad_request" | "not_found" | "conflict" | "duplicate_loop";

/** A rejected operation; `code` maps onto the OpenAPI error responses (400/404/409). */
export class KernelError extends Error {
  readonly code: KernelErrorCode;
  readonly details: unknown;
  constructor(code: KernelErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "KernelError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Sources whose every change is about one subject (e.g. one directory listing).
 * An event When bound to one of them must name that subject in
 * source_binding.config.subject; otherwise it would hear every subject's change,
 * or none, and each listing is its own loop (SPEC B2.3).
 */
const SUBJECT_BOUND_SOURCES: ReadonlySet<string> = new Set(["anthropic_listings"]);

/** An event When's change condition: the one payload field it watches and its value at the last firing. */
function changeCondition(when: Node): { field: string; last_value?: unknown } | undefined {
  const condition = when.attributes["change_condition"] as { field?: unknown; last_value?: unknown } | undefined;
  if (condition === undefined || typeof condition.field !== "string") return undefined;
  return condition as { field: string; last_value?: unknown };
}

/**
 * Whether an event's payload satisfies a When's change condition: always for a
 * When without one; otherwise the payload must report the field, and its value
 * must differ (by value) from the value at the When's last firing. A When that
 * has never fired under its condition (no last_value) fires on its first observation.
 */
function changeConditionMet(when: Node, payload: Record<string, unknown>): boolean {
  const condition = changeCondition(when);
  if (!condition) return true;
  if (!Object.hasOwn(payload, condition.field)) return false;
  if (!Object.hasOwn(condition, "last_value")) return true;
  return !isDeepStrictEqual(payload[condition.field], condition.last_value);
}

/** Refuses an event When bound to a subject-bound source that names no subject. */
function requireBoundSubject(node: Node): void {
  if (node.kind !== "when" || node.attributes["when_type"] !== "event") return;
  const binding = node.attributes["source_binding"] as { source?: unknown; config?: Record<string, unknown> } | undefined;
  if (typeof binding?.source !== "string" || !SUBJECT_BOUND_SOURCES.has(binding.source)) return;
  const subject = binding.config?.["subject"];
  if (typeof subject !== "string" || subject.trim() === "")
    throw new KernelError(
      "bad_request",
      `When ${node.id} is bound to ${binding.source} but its source_binding.config.subject names no subject`,
    );
}

export interface KernelOptions {
  now?: () => Date;
  /** Returns a fresh `lc_…` id; `prefix` names the record kind (loop, edge, evt). */
  newId?: (prefix: string) => string;
  /** Policy refs cited by new loops whose type has no loop-type policy (SPEC B4). */
  defaultPolicyRefs?: { ageing: PolicyRef; escalation: PolicyRef };
  /** Loop-type policies (SPEC B4); defaults to LOOP_TYPE_POLICIES. */
  loopTypePolicies?: readonly LoopTypePolicy[];
  /**
   * The service owner's registered receivers (Who ids), set by the operator
   * when the service starts. They are the only receivers an `owner_only` loop
   * type may send to; nothing a caller writes into the graph (the loop's
   * accountable Who, `owns` edges) adds to them. Defaults to none: every
   * `owner_only` send is refused until receivers are registered.
   */
  ownerReceiverIds?: readonly string[];
}

const DEFAULT_POLICY_REFS = {
  ageing: { id: "lc_policy_ageing_default", version: 1 },
  escalation: { id: "lc_policy_escalation_default", version: 1 },
} as const;

/** Loop states whose Whens are armed (accepted, not suspended and not closed). */
export const ARMED_LOOP_STATES: ReadonlySet<LoopState> = new Set(["open", "waiting", "chased"]);
const ARMED = ARMED_LOOP_STATES;
/** The non-terminal paused state: neither armed nor closed; left only back to open. */
const SUSPENDED: LoopState = "suspended";
const CLOSED: ReadonlySet<LoopState> = new Set(["closed", "closed_with_reason"]);

/**
 * Valid manual transitions. `proposed` leaves only via accept_loop / reject_loop;
 * closed states are terminal (re-opening is a new loop or a manual_correction).
 * `suspended` pauses an open loop (its Whens are held, see #heldWhenIds) and
 * resumes only to open.
 */
export const LOOP_TRANSITIONS: Readonly<Record<LoopState, readonly LoopState[]>> = {
  proposed: [],
  open: ["waiting", "chased", "suspended", "closed", "closed_with_reason"],
  waiting: ["open", "chased", "closed", "closed_with_reason"],
  chased: ["open", "waiting", "closed", "closed_with_reason"],
  suspended: ["open"],
  closed: [],
  closed_with_reason: [],
};

/** Edges along which a When firing unblocks a member node. */
function unblocks(edge: Edge, whenId: string, members: ReadonlySet<string>): boolean {
  const causal: readonly EdgeType[] = ["causes", "enables"];
  if (edge.from_id === whenId && members.has(edge.to_id)) return causal.includes(edge.edge_type);
  if (edge.to_id === whenId && members.has(edge.from_id)) return edge.edge_type === "is_waiting_on";
  return false;
}

function isRef(n: Node | { ref: string }): n is { ref: string } {
  return "ref" in n;
}

export class Kernel {
  readonly #store: GraphStore;
  readonly #now: () => Date;
  readonly #newId: (prefix: string) => string;
  readonly #policyRefs: { ageing: PolicyRef; escalation: PolicyRef };
  readonly #loopTypePolicies: readonly LoopTypePolicy[];
  readonly #ownerReceiverIds: ReadonlySet<string>;
  readonly #ajv = createValidator();

  constructor(store: GraphStore, options: KernelOptions = {}) {
    this.#store = store;
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? ((prefix) => `lc_${prefix}_${randomUUID()}`);
    this.#policyRefs = options.defaultPolicyRefs ?? DEFAULT_POLICY_REFS;
    this.#loopTypePolicies = options.loopTypePolicies ?? LOOP_TYPE_POLICIES;
    this.#ownerReceiverIds = new Set(options.ownerReceiverIds ?? []);
  }

  // ---- intake -------------------------------------------------------------

  /**
   * propose_loop: resolves the proposed subgraph, runs the dedup check against
   * non-closed loops on the same accountable Who + What, and only then stores
   * the subgraph and a `proposed` Loop with its loop_proposed ledger event.
   */
  proposeLoop(input: ProposeLoopInput): Promise<LoopWithEvent> {
    return this.#store.transaction(async (tx) => {
      const at = this.#at();
      const members = new Map<string, Node>();
      const created: Node[] = [];
      for (const proposed of input.nodes) {
        // A recurring calendar When is stored with its recurrence anchor (LC-M2-T1c).
        const entry = isRef(proposed) || proposed.kind !== "when" ? proposed : { ...proposed, attributes: anchorCalendarWhen(proposed.attributes) };
        if (isRef(entry)) {
          const existing = await tx.getNode(entry.ref);
          if (!existing) throw new KernelError("not_found", `node ${entry.ref} does not exist`);
          members.set(existing.id, existing);
          continue;
        }
        this.#check("node", entry, "bad_request");
        requireBoundSubject(entry);
        const existing = await tx.getNode(entry.id);
        if (existing && !isDeepStrictEqual(existing, entry))
          throw new KernelError("conflict", `node ${entry.id} already exists with different content; reference it with { ref }`);
        if (!existing) created.push(entry);
        members.set(entry.id, entry);
      }

      let accountable = members.get(input.accountable_who_id);
      if (!accountable) {
        accountable = await tx.getNode(input.accountable_who_id);
        if (!accountable) throw new KernelError("not_found", `accountable Who ${input.accountable_who_id} does not exist`);
        members.set(accountable.id, accountable);
      }
      if (accountable.kind !== "who") throw new KernelError("bad_request", `accountable_who_id ${accountable.id} is not a Who`);
      for (const n of members.values())
        if (n.status !== "active") throw new KernelError("bad_request", `node ${n.id} is ${n.status}, not active`);

      const whatIds = [...members.values()].filter((n) => n.kind === "what").map((n) => n.id);
      if (whatIds.length === 0) throw new KernelError("bad_request", "a loop needs at least one What in its subgraph");

      const closingWhenId = input.closing_when_id ?? null;
      if (closingWhenId !== null && members.get(closingWhenId)?.kind !== "when")
        throw new KernelError("bad_request", `closing_when_id ${closingWhenId} is not a When in the proposed subgraph`);

      for (const e of input.edges)
        if (!members.has(e.from_id) || !members.has(e.to_id))
          throw new KernelError("bad_request", `edge ${e.from_id} -${e.edge_type}-> ${e.to_id} leaves the proposed subgraph`);

      // Dedup check, before anything is admitted.
      const duplicates = (await tx.listLoops())
        .filter(
          (l) =>
            !CLOSED.has(l.state) &&
            l.accountable_who_id === accountable.id &&
            l.member_node_ids.some((id) => whatIds.includes(id)),
        )
        .map((l) => l.id);
      if (duplicates.length > 0)
        throw new KernelError(
          "duplicate_loop",
          `an open loop already covers Who ${accountable.id} and the same What`,
          { existing_loop_ids: duplicates },
        );

      for (const n of created) await tx.putNode(n);
      const edgeIds: string[] = [];
      for (const e of input.edges) {
        const edge: Edge = {
          id: this.#newId("edge"),
          from_id: e.from_id,
          to_id: e.to_id,
          edge_type: e.edge_type,
          created_by: input.actor,
          created_at: at,
          evidence: e.evidence ?? null,
          status: "active",
        };
        this.#check("edge", edge, "bad_request");
        await tx.putEdge(edge);
        edgeIds.push(edge.id);
      }

      // The loop inherits its type's authority and escalation policy (SPEC B2.6, B4).
      const policy = loopTypePolicy(input.loop_type, this.#loopTypePolicies);
      const policyRefs = structuredClone(this.#policyRefs);
      if (policy) policyRefs.escalation = { id: policy.escalation.id, version: policy.escalation.version };
      const loop: Loop = {
        id: this.#newId("loop"),
        name: input.name,
        loop_type: input.loop_type,
        state: "proposed",
        accountable_who_id: accountable.id,
        member_node_ids: [...members.keys()],
        closing_when_id: closingWhenId,
        authority: policy?.authority ?? DEFAULT_AUTHORITY,
        opened_at: null,
        closed_at: null,
        close_reason: null,
        policy_refs: policyRefs,
        ...(input.key_result_ref === undefined
          ? {}
          : { key_result_ref: { system: input.key_result_ref.system, id: input.key_result_ref.id } }),
      };
      this.#check("loop", loop, "bad_request");
      await tx.putLoop(loop);
      const ledger_event = await this.#append(tx, {
        at,
        actor: input.actor,
        event_type: "loop_proposed",
        subject_ids: [loop.id, ...created.map((n) => n.id), ...edgeIds],
        payload: { rationale: input.rationale, created_node_ids: created.map((n) => n.id), edge_ids: edgeIds },
        idempotency_key: null,
      });
      return { loop, ledger_event };
    });
  }

  /** accept_loop: proposed → open; the loop's Whens become armed. */
  acceptLoop(loopId: string, input: AcceptLoopInput): Promise<LoopWithEvent> {
    return this.#store.transaction(async (tx) => {
      const loop = await this.#loop(tx, loopId);
      if (loop.state !== "proposed")
        throw new KernelError("conflict", `loop ${loopId} is ${loop.state}; only a proposed loop can be accepted`);
      const at = this.#at();
      const next: Loop = { ...loop, state: "open", opened_at: at };
      this.#check("loop", next);
      await tx.putLoop(next);
      const ledger_event = await this.#append(tx, {
        at,
        actor: input.acceptor,
        event_type: "loop_accepted",
        subject_ids: [loopId],
        payload: { from_state: "proposed", to_state: "open" },
        idempotency_key: null,
      });
      return { loop: next, ledger_event };
    });
  }

  /** reject_loop: proposed → closed_with_reason (rejected) at intake; the ledger event is kept. */
  rejectLoop(loopId: string, input: RejectLoopInput): Promise<LoopWithEvent> {
    return this.#store.transaction(async (tx) => {
      const loop = await this.#loop(tx, loopId);
      if (loop.state !== "proposed")
        throw new KernelError("conflict", `loop ${loopId} is ${loop.state}; only a proposed loop can be rejected`);
      const at = this.#at();
      const next: Loop = { ...loop, state: "closed_with_reason", closed_at: at, close_reason: "rejected" };
      this.#check("loop", next);
      await tx.putLoop(next);
      const ledger_event = await this.#append(tx, {
        at,
        actor: input.actor,
        event_type: "loop_rejected",
        subject_ids: [loopId],
        payload: { from_state: "proposed", to_state: "closed_with_reason", reason: input.reason },
        idempotency_key: null,
      });
      return { loop: next, ledger_event };
    });
  }

  // ---- manual firing ------------------------------------------------------

  /** transition: a validated state change + ledger event, atomically; a replayed idempotency key applies once. */
  transition(loopId: string, input: TransitionInput): Promise<TransitionResult> {
    return this.#store.transaction(async (tx) => {
      const prior = await tx.findEventByIdempotencyKey(input.idempotency_key);
      if (prior) {
        const same =
          prior.event_type === "transition" &&
          prior.subject_ids[0] === loopId &&
          prior.payload["to_state"] === input.to_state;
        if (!same) throw new KernelError("conflict", `idempotency key ${input.idempotency_key} was already used for a different change`);
        return { loop: await this.#loop(tx, loopId), ledger_event: prior, applied: false };
      }
      const loop = await this.#loop(tx, loopId);
      if (input.to_state === "closed_with_reason") {
        if (!input.close_reason) throw new KernelError("bad_request", "closed_with_reason needs a close_reason");
        if (input.close_reason === "rejected")
          throw new KernelError("bad_request", "close_reason rejected is reserved for reject_loop at intake");
      } else if (input.close_reason !== undefined) {
        throw new KernelError("bad_request", `close_reason only applies to closed_with_reason, not ${input.to_state}`);
      }
      const { loop: next, ledger_event } = await this.#move(tx, loop, input.to_state, {
        actor: input.actor,
        evidence: input.evidence,
        idempotency_key: input.idempotency_key,
        close_reason: input.close_reason ?? null,
      });
      return { loop: next, ledger_event, applied: true };
    });
  }

  /**
   * fire_event: records the firing of a When (by id, or every event-When bound
   * to event_type + source; with a subject, only those whose binding names exactly
   * that subject -- a When naming no subject does not hear subject changes) as one when_fired ledger event, then applies the
   * transitions the firing causes on armed loops (see whatFiresNext). By
   * event_type + source, a When with a change_condition fires only when the
   * payload's value of its field differs from the value at its last firing (the
   * first observation always fires); the ledger event lists it under
   * unchanged_when_ids instead of when_ids. A When held by a suspended loop
   * (see #heldWhenIds) does not fire: by event_type + source it is listed under
   * held_when_ids instead of when_ids; by id the firing is refused. A replayed idempotency key applies once. Workflow runs arrive with templates.
   */
  fireEvent(input: FireEventInput): Promise<FireEventResult> {
    return this.#store.transaction(async (tx) => {
      const prior = await tx.findEventByIdempotencyKey(input.idempotency_key);
      if (prior) {
        if (prior.event_type !== "when_fired")
          throw new KernelError("conflict", `idempotency key ${input.idempotency_key} was already used for a different change`);
        return { ledger_event: prior, applied: false, loop_ids: (prior.payload["loop_ids"] as string[] | undefined) ?? [], workflow_runs: [] };
      }

      let whens: Node[];
      if ("when_id" in input) {
        const when = await tx.getNode(input.when_id);
        if (!when || when.kind !== "when") throw new KernelError("not_found", `When ${input.when_id} does not exist`);
        if ((await this.#heldWhenIds(tx)).has(when.id))
          throw new KernelError("conflict", `When ${when.id} is held: every loop it belongs to is suspended`);
        whens = [when];
      } else {
        whens = (await tx.listNodes()).filter((n) => {
          const a = n.attributes;
          const binding = a["source_binding"] as { source?: unknown; config?: Record<string, unknown> } | undefined;
          const target = binding?.config?.["subject"];
          return n.kind === "when" && n.status === "active" && a["when_type"] === "event" &&
            a["event_type"] === input.event_type && binding?.source === input.source &&
            (input.subject === undefined || target === input.subject);
        });
        if (whens.length === 0) {
          const about = input.subject === undefined ? "" : ` about ${input.subject}`;
          throw new KernelError("not_found", `no When is bound to event ${input.event_type} from ${input.source}${about}`);
        }
      }

      // A When held by a suspended loop does not fire; a change-condition When
      // fires (by event_type + source) only on a new value of its field.
      const heldIds = await this.#heldWhenIds(tx);
      const bound = whens;
      const held = bound.filter((w) => heldIds.has(w.id));
      const matched = bound.filter((w) => !heldIds.has(w.id));
      const unchanged: Node[] = [];
      if ("event_type" in input) {
        whens = matched.filter((w) => {
          const changed = changeConditionMet(w, input.payload);
          if (!changed) unchanged.push(w);
          return changed;
        });
      }

      const at = this.#at();
      const actor = input.actor ?? "system:fire_event";
      for (const when of whens) {
        if (when.attributes["when_type"] !== "event") continue; // calendar scheduling belongs to the timer loop
        const fireCount = typeof when.attributes["fire_count"] === "number" ? when.attributes["fire_count"] : 0;
        const attributes: Record<string, unknown> = { ...when.attributes, fired_at: at, fire_count: fireCount + 1 };
        const condition = changeCondition(when);
        if (condition && "event_type" in input) {
          attributes["change_condition"] = { ...condition, last_value: input.payload[condition.field] };
        }
        const fired: Node = { ...when, attributes };
        this.#check("node", fired);
        await tx.putNode(fired);
      }

      const effects: FiringEffect[] = [];
      for (const w of whens) effects.push(...(await this.#effectsOfWhen(tx, w.id)));
      const loopIds = [...new Set(effects.map((e) => e.loop_id))];
      const payload: Record<string, unknown> = { when_ids: whens.map((w) => w.id), loop_ids: loopIds };
      if (unchanged.length > 0) payload["unchanged_when_ids"] = unchanged.map((w) => w.id);
      if (held.length > 0) payload["held_when_ids"] = held.map((w) => w.id);
      if ("event_type" in input) Object.assign(payload, { event_type: input.event_type, source: input.source });
      if (input.payload !== undefined) payload["event_payload"] = input.payload;
      const ledger_event = await this.#append(tx, {
        at,
        actor,
        event_type: "when_fired",
        subject_ids: [...bound.map((w) => w.id), ...loopIds],
        payload,
        idempotency_key: input.idempotency_key,
      });

      const evidence = { kind: "ledger_event", id: ledger_event.id } as const;
      for (const effect of effects) {
        if (!effect.next_state) continue;
        const loop = await this.#loop(tx, effect.loop_id);
        if (loop.state === effect.next_state || !LOOP_TRANSITIONS[loop.state].includes(effect.next_state)) continue;
        await this.#move(tx, loop, effect.next_state, { actor, evidence, idempotency_key: null, close_reason: null });
      }
      return { ledger_event, applied: true, loop_ids: loopIds, workflow_runs: [] };
    });
  }

  // ---- communications -----------------------------------------------------

  /**
   * record_communication: stores a Communication on an existing loop. An
   * inbound one is recorded with its communication_received ledger event; an
   * outbound one is a draft (sent_under_authority null) until a send of it is
   * released, which writes communication_sent.
   */
  recordCommunication(input: RecordCommunicationInput): Promise<Communication> {
    return this.#store.transaction(async (tx) => {
      await this.#loop(tx, input.loop_id);
      const communication: Communication = { id: this.#newId("comm"), ...input, sent_under_authority: null };
      this.#check("communication", communication, "bad_request");
      await tx.putCommunication(communication);
      if (communication.direction === "inbound")
        await this.#append(tx, {
          at: this.#at(),
          actor: "system:record_communication",
          event_type: "communication_received",
          subject_ids: [communication.id, communication.loop_id],
          payload: { communication_id: communication.id, loop_id: communication.loop_id },
          idempotency_key: null,
        });
      return communication;
    });
  }

  /**
   * request_send (SPEC B2.6): the sender asks to send an outbound draft of the
   * loop. Only `autonomous` authority enqueues the send; any other authority
   * (default joe-approves-each) records a pending approval and sends nothing.
   * Where the loop type's policy limits receivers to the owner's own, a send
   * addressed to anyone else is refused: the refusal is recorded (a `refused`
   * send request) and nothing is sent. One request per communication.
   */
  async requestSend(loopId: string, input: RequestSendInput): Promise<SendRequestResult> {
    const outcome = await this.#store.transaction(async (tx): Promise<SendRequestResult | { refused: SendRequest }> => {
      const loop = await this.#loop(tx, loopId);
      const communication = await this.#communication(tx, input.communication_id);
      if (communication.loop_id !== loop.id)
        throw new KernelError("conflict", `communication ${communication.id} belongs to loop ${communication.loop_id}, not ${loop.id}`);
      if (communication.direction !== "outbound")
        throw new KernelError("conflict", `communication ${communication.id} is inbound; only an outbound draft can be sent`);
      if (!ARMED.has(loop.state))
        throw new KernelError("conflict", `loop ${loop.id} is ${loop.state}; sends are requested only on open loops`);
      const prior = await tx.getSendRequest(communication.id);
      if (prior)
        throw new KernelError("conflict", `a send of communication ${communication.id} was already requested (${prior.status})`);

      const request: SendRequest = {
        communication_id: communication.id,
        loop_id: loop.id,
        authority: loop.authority,
        status: "pending_approval",
        requested_by: input.actor,
        requested_at: this.#at(),
      };
      const outsiders = this.#receiversOutsideScope(loop, communication);
      if (outsiders.length > 0) {
        const refused: SendRequest = { ...request, status: "refused", refused_receiver_ids: outsiders };
        await tx.putSendRequest(refused);
        return { refused };
      }
      await tx.putSendRequest(request);
      if (loop.authority === "autonomous") {
        await this.#release(tx, communication, request, input.actor, { released_by: "autonomous" });
        return { communication_id: communication.id, authority: loop.authority, status: "enqueued" };
      }
      return { communication_id: communication.id, authority: loop.authority, status: "pending_approval" };
    });
    if ("refused" in outcome) {
      const ids = outcome.refused.refused_receiver_ids ?? [];
      throw new KernelError(
        "conflict",
        `loop ${loopId} may send only to its owner's receivers; refused ${ids.join(", ")}`,
        { refused_receiver_ids: ids },
      );
    }
    return outcome;
  }

  /**
   * approve_send: Joe releases exactly this communication to the sender. Only a
   * pending approval can be released, and only once.
   */
  approveSend(communicationId: string, input: ApproveSendInput): Promise<ApproveSendResult> {
    return this.#store.transaction(async (tx) => {
      const communication = await this.#communication(tx, communicationId);
      const request = await tx.getSendRequest(communicationId);
      if (!request) throw new KernelError("conflict", `no send of communication ${communicationId} is awaiting approval`);
      if (request.status !== "pending_approval")
        throw new KernelError("conflict", `communication ${communicationId} is already ${request.status}`);
      const loop = await this.#loop(tx, request.loop_id);
      if (!ARMED.has(loop.state))
        throw new KernelError("conflict", `loop ${loop.id} is ${loop.state}; its sends are no longer released`);
      const ledger_event = await this.#release(tx, communication, request, input.approver, { approved_by: input.approver });
      return { communication_id: communicationId, status: "released", ledger_event };
    });
  }

  // ---- queries ------------------------------------------------------------

  /** open_loops: every non-closed loop matching the filters, with age and governing Whens. */
  openLoops(filter: OpenLoopsFilter = {}): Promise<{ loops: OpenLoop[] }> {
    return this.#store.read(async (tx) => {
      const now = this.#now().getTime();
      const ledger = await tx.ledger();
      const matching = (await tx.listLoops())
        .filter((l) => !CLOSED.has(l.state))
        .filter((l) => filter.accountable_who_id === undefined || l.accountable_who_id === filter.accountable_who_id)
        .filter((l) => filter.loop_type === undefined || l.loop_type === filter.loop_type)
        .filter((l) => filter.state === undefined || l.state === filter.state)
        .filter(
          (l) =>
            filter.key_result_ref === undefined ||
            (l.key_result_ref?.system === filter.key_result_ref.system && l.key_result_ref.id === filter.key_result_ref.id),
        );
      const loops: OpenLoop[] = [];
      for (const loop of matching) {
        const since =
          loop.opened_at ??
          ledger.find((e) => e.event_type === "loop_proposed" && e.subject_ids[0] === loop.id)?.at ??
          new Date(now).toISOString();
        const open: OpenLoop = {
          loop,
          age_seconds: Math.max(0, Math.floor((now - Date.parse(since)) / 1000)),
          governing_when_ids: await this.#whenIds(tx, loop),
          // Ageing policies (SPEC B4) are not evaluated yet, so nothing is breaching.
          breaching: false,
        };
        if (!filter.breaching_only || open.breaching) loops.push(open);
      }
      return { loops };
    });
  }

  /**
   * what_fires_next: for a loop, the Whens it is waiting on and what each firing
   * will cause; for a When, every armed loop that fires when it fires. Exact
   * traversal of the stored graph.
   */
  whatFiresNext(query: { loop_id: string } | { when_id: string }): Promise<{ effects: FiringEffect[] }> {
    return this.#store.read(async (tx) => {
      if ("loop_id" in query) {
        const loop = await this.#loop(tx, query.loop_id);
        if (!ARMED.has(loop.state)) return { effects: [] };
        const effects: FiringEffect[] = [];
        for (const w of await this.#whenIds(tx, loop)) effects.push(await this.#effect(tx, loop, w));
        return { effects };
      }
      const when = await tx.getNode(query.when_id);
      if (!when || when.kind !== "when") throw new KernelError("not_found", `When ${query.when_id} does not exist`);
      return { effects: await this.#effectsOfWhen(tx, when.id) };
    });
  }

  /**
   * health (SPEC §5): metrics for redesign, never a gate. Over the window
   * ending now: Joe-initiated manual_correction count and loops abandoned;
   * at the snapshot: breach % and the median age of accepted, non-closed loops.
   */
  health(windowSeconds: number): Promise<HealthMetrics> {
    return this.#store.read(async (tx) => {
      const now = this.#now().getTime();
      const since = now - windowSeconds * 1000;
      const inWindow = (at: string | null): boolean => at !== null && Date.parse(at) >= since && Date.parse(at) <= now;
      const loops = await tx.listLoops();
      const ages = loops
        .filter((l) => !CLOSED.has(l.state) && l.opened_at !== null)
        .map((l) => Math.max(0, Math.floor((now - Date.parse(l.opened_at as string)) / 1000)))
        .sort((a, b) => a - b);
      const mid = Math.floor(ages.length / 2);
      const median = ages.length === 0 ? null : ages.length % 2 === 1 ? ages[mid]! : (ages[mid - 1]! + ages[mid]!) / 2;
      return {
        snapshot_at: new Date(now).toISOString(),
        // Ageing policies (SPEC B4) are not evaluated yet, so nothing is breaching (as in open_loops).
        breach_pct: 0,
        manual_correction_count: (await tx.ledger()).filter((e) => e.event_type === "manual_correction" && inWindow(e.at)).length,
        median_open_age_seconds: median,
        abandonment_count: loops.filter((l) => l.close_reason === "abandoned" && inWindow(l.closed_at)).length,
      };
    });
  }

  /**
   * ledger_events (SPEC B2.4): read-only, up to `limit` ledger events committed
   * after `after` (a commit position; 0 is the start), in commit order, with the
   * position to read from next. Nothing new committed: no events and `next`
   * equal to `after`. A position beyond the committed ledger is a bad request.
   */
  ledgerEvents(after: number, limit: number): Promise<LedgerEventsPage> {
    return this.#store.read(async (tx) => {
      const page = await tx.ledgerAfter(after, limit);
      if (!page) throw new KernelError("bad_request", `cursor ${after} is not a position in the committed ledger`);
      return { events: page.events, next: page.position };
    });
  }

  getLoop(loopId: string): Promise<Loop> {
    return this.#store.read((tx) => this.#loop(tx, loopId));
  }

  // ---- internals ----------------------------------------------------------

  #at(): string {
    return this.#now().toISOString();
  }

  async #loop(tx: GraphTx, loopId: string): Promise<Loop> {
    const loop = await tx.getLoop(loopId);
    if (!loop) throw new KernelError("not_found", `loop ${loopId} does not exist`);
    return loop;
  }

  async #communication(tx: GraphTx, id: string): Promise<Communication> {
    const communication = await tx.getCommunication(id);
    if (!communication) throw new KernelError("not_found", `communication ${id} does not exist`);
    return communication;
  }

  /**
   * Hands a communication to the sender: stamps the authority it goes out
   * under, writes communication_sent and the outbox entry citing it in the
   * same transaction, and marks the send request enqueued.
   */
  async #release(
    tx: GraphTx,
    communication: Communication,
    request: SendRequest,
    actor: string,
    release: Record<string, unknown>,
  ): Promise<LedgerEvent> {
    const authority: Authority = request.authority;
    const sent: Communication = { ...communication, sent_under_authority: authority };
    this.#check("communication", sent);
    await tx.putCommunication(sent);
    const at = this.#at();
    const ledger_event = await this.#append(tx, {
      at,
      actor,
      event_type: "communication_sent",
      subject_ids: [communication.id, request.loop_id],
      payload: { communication_id: communication.id, loop_id: request.loop_id, authority, requested_by: request.requested_by, ...release },
      idempotency_key: null,
    });
    await tx.enqueue({
      ledger_event_id: ledger_event.id,
      topic: "send",
      payload: { communication_id: communication.id, loop_id: request.loop_id },
      created_at: at,
    });
    await tx.putSendRequest({ ...request, status: "enqueued" });
    return ledger_event;
  }

  /**
   * Receivers of `communication` the loop's type does not allow. Under an
   * `owner_only` scope the allowed receivers are exactly the service owner's
   * registered receivers (KernelOptions.ownerReceiverIds). Graph claims a
   * caller can write (the loop's accountable Who, `owns` edges) grant nothing.
   * Under `any` (the default) none are refused.
   */
  #receiversOutsideScope(loop: Loop, communication: Communication): string[] {
    const policy = loopTypePolicy(loop.loop_type, this.#loopTypePolicies);
    if (policy?.receivers !== "owner_only") return [];
    return [...new Set(communication.participant_who_ids)].filter((id) => !this.#ownerReceiverIds.has(id));
  }

  async #whenIds(tx: GraphTx, loop: Loop): Promise<string[]> {
    const ids: string[] = [];
    for (const id of loop.member_node_ids) if ((await tx.getNode(id))?.kind === "when") ids.push(id);
    if (loop.closing_when_id !== null && !ids.includes(loop.closing_when_id)) ids.push(loop.closing_when_id);
    return ids;
  }

  /**
   * Whens held by a suspended loop: governed by (a member or the closing When
   * of) at least one suspended loop and by no armed loop. A held When does not
   * fire; the timer stores apply the same rule to calendar Whens.
   */
  async #heldWhenIds(tx: GraphTx): Promise<Set<string>> {
    const suspended = new Set<string>();
    const armed = new Set<string>();
    for (const l of await tx.listLoops()) {
      const into = l.state === SUSPENDED ? suspended : ARMED.has(l.state) ? armed : undefined;
      if (into) for (const id of await this.#whenIds(tx, l)) into.add(id);
    }
    for (const id of armed) suspended.delete(id);
    return suspended;
  }

  async #effectsOfWhen(tx: GraphTx, whenId: string): Promise<FiringEffect[]> {
    const effects: FiringEffect[] = [];
    for (const l of await tx.listLoops())
      if (ARMED.has(l.state) && (await this.#whenIds(tx, l)).includes(whenId)) effects.push(await this.#effect(tx, l, whenId));
    return effects;
  }

  /**
   * What firing `whenId` does to `loop`: the closing When closes it; a When
   * its members wait on (is_waiting_on) or that causes/enables a member
   * re-opens a waiting or chased loop; any other member When is recorded only.
   */
  async #effect(tx: GraphTx, loop: Loop, whenId: string): Promise<FiringEffect> {
    const members = new Set(loop.member_node_ids);
    const via = (await tx.edgesTouching(whenId)).filter((e) => unblocks(e, whenId, members)).map((e) => e.id);
    const effect: FiringEffect = { when_id: whenId, loop_id: loop.id };
    if (loop.closing_when_id === whenId) effect.next_state = "closed";
    else if (via.length > 0 && (loop.state === "waiting" || loop.state === "chased")) effect.next_state = "open";
    if (via.length > 0) effect.via_edge_ids = via;
    return effect;
  }

  async #move(
    tx: GraphTx,
    loop: Loop,
    to: LoopState,
    how: { actor: string; evidence: { kind: "communication" | "gather" | "ledger_event"; id: string }; idempotency_key: string | null; close_reason: Loop["close_reason"] },
  ): Promise<LoopWithEvent> {
    if (!LOOP_TRANSITIONS[loop.state].includes(to))
      throw new KernelError("conflict", `loop ${loop.id} cannot move from ${loop.state} to ${to}`);
    const at = this.#at();
    const next: Loop = {
      ...loop,
      state: to,
      closed_at: CLOSED.has(to) ? at : null,
      close_reason: to === "closed_with_reason" ? how.close_reason : null,
    };
    this.#check("loop", next);
    await tx.putLoop(next);
    const ledger_event = await this.#append(tx, {
      at,
      actor: how.actor,
      event_type: "transition",
      subject_ids: [loop.id],
      payload: { from_state: loop.state, to_state: to, evidence: how.evidence },
      idempotency_key: how.idempotency_key,
    });
    return { loop: next, ledger_event };
  }

  async #append(tx: GraphTx, event: Omit<LedgerEvent, "id"> & { event_type: LedgerEventType }): Promise<LedgerEvent> {
    const full: LedgerEvent = { id: this.#newId("evt"), ...event };
    this.#check("ledger-event", full);
    await tx.appendEvent(full);
    return full;
  }

  /** Validates a record against its SPEC B2 schema before it is written. */
  #check(object: "node" | "edge" | "loop" | "ledger-event" | "communication", value: unknown, code?: KernelErrorCode): void {
    const validate = this.#ajv.getSchema(`${SCHEMA_ID_BASE}${object}.schema.json`);
    if (!validate) throw new Error(`schema ${object} is not registered`);
    if (validate(value)) return;
    const message = `${object} does not match its schema: ${this.#ajv.errorsText(validate.errors)}`;
    if (code) throw new KernelError(code, message, validate.errors);
    throw new Error(message);
  }
}
