// Loop Closer kernel (SPEC B3, Phase 0): intake (propose → dedup → accept),
// manual `transition` and `fire_event`, and the `open_loops` /
// `what_fires_next` queries — all answered from the stored graph, never by
// similarity. Every state change is written with its ledger event in one
// store transaction.
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createValidator, SCHEMA_ID_BASE } from "../contracts/index.ts";
import type { GraphStore, GraphTx } from "./store.ts";
import type {
  AcceptLoopInput,
  Edge,
  EdgeType,
  FireEventInput,
  FireEventResult,
  FiringEffect,
  LedgerEvent,
  LedgerEventType,
  Loop,
  LoopState,
  LoopWithEvent,
  Node,
  OpenLoop,
  OpenLoopsFilter,
  PolicyRef,
  ProposeLoopInput,
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

export interface KernelOptions {
  now?: () => Date;
  /** Returns a fresh `lc_…` id; `prefix` names the record kind (loop, edge, evt). */
  newId?: (prefix: string) => string;
  /** Policy refs cited by new loops until loop-type policies (SPEC B4) exist. */
  defaultPolicyRefs?: { ageing: PolicyRef; escalation: PolicyRef };
}

const DEFAULT_POLICY_REFS = {
  ageing: { id: "lc_policy_ageing_default", version: 1 },
  escalation: { id: "lc_policy_escalation_default", version: 1 },
} as const;

/** Loop states whose Whens are armed (accepted and not closed). */
const ARMED: ReadonlySet<LoopState> = new Set(["open", "waiting", "chased"]);
const CLOSED: ReadonlySet<LoopState> = new Set(["closed", "closed_with_reason"]);

/**
 * Valid manual transitions. `proposed` leaves only via accept_loop / reject_loop;
 * closed states are terminal (re-opening is a new loop or a manual_correction).
 */
const TRANSITIONS: Readonly<Record<LoopState, readonly LoopState[]>> = {
  proposed: [],
  open: ["waiting", "chased", "closed", "closed_with_reason"],
  waiting: ["open", "chased", "closed", "closed_with_reason"],
  chased: ["open", "waiting", "closed", "closed_with_reason"],
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
  readonly #ajv = createValidator();

  constructor(store: GraphStore, options: KernelOptions = {}) {
    this.#store = store;
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? ((prefix) => `lc_${prefix}_${randomUUID()}`);
    this.#policyRefs = options.defaultPolicyRefs ?? DEFAULT_POLICY_REFS;
  }

  // ---- intake -------------------------------------------------------------

  /**
   * propose_loop: resolves the proposed subgraph, runs the dedup check against
   * non-closed loops on the same accountable Who + What, and only then stores
   * the subgraph and a `proposed` Loop with its loop_proposed ledger event.
   */
  proposeLoop(input: ProposeLoopInput): Promise<LoopWithEvent> {
    return this.#store.transaction((tx) => {
      const at = this.#at();
      const members = new Map<string, Node>();
      const created: Node[] = [];
      for (const entry of input.nodes) {
        if (isRef(entry)) {
          const existing = tx.getNode(entry.ref);
          if (!existing) throw new KernelError("not_found", `node ${entry.ref} does not exist`);
          members.set(existing.id, existing);
          continue;
        }
        this.#check("node", entry, "bad_request");
        const existing = tx.getNode(entry.id);
        if (existing && !isDeepStrictEqual(existing, entry))
          throw new KernelError("conflict", `node ${entry.id} already exists with different content; reference it with { ref }`);
        if (!existing) created.push(entry);
        members.set(entry.id, entry);
      }

      let accountable = members.get(input.accountable_who_id);
      if (!accountable) {
        accountable = tx.getNode(input.accountable_who_id);
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
      const duplicates = tx
        .listLoops()
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

      for (const n of created) tx.putNode(n);
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
        tx.putEdge(edge);
        edgeIds.push(edge.id);
      }

      const loop: Loop = {
        id: this.#newId("loop"),
        name: input.name,
        loop_type: input.loop_type,
        state: "proposed",
        accountable_who_id: accountable.id,
        member_node_ids: [...members.keys()],
        closing_when_id: closingWhenId,
        authority: "joe-approves-each",
        opened_at: null,
        closed_at: null,
        close_reason: null,
        policy_refs: structuredClone(this.#policyRefs),
      };
      this.#check("loop", loop, "bad_request");
      tx.putLoop(loop);
      const ledger_event = this.#append(tx, {
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
    return this.#store.transaction((tx) => {
      const loop = this.#loop(tx, loopId);
      if (loop.state !== "proposed")
        throw new KernelError("conflict", `loop ${loopId} is ${loop.state}; only a proposed loop can be accepted`);
      const at = this.#at();
      const next: Loop = { ...loop, state: "open", opened_at: at };
      this.#check("loop", next);
      tx.putLoop(next);
      const ledger_event = this.#append(tx, {
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

  // ---- manual firing ------------------------------------------------------

  /** transition: a validated state change + ledger event, atomically; a replayed idempotency key applies once. */
  transition(loopId: string, input: TransitionInput): Promise<TransitionResult> {
    return this.#store.transaction((tx) => {
      const prior = tx.findEventByIdempotencyKey(input.idempotency_key);
      if (prior) {
        const same =
          prior.event_type === "transition" &&
          prior.subject_ids[0] === loopId &&
          prior.payload["to_state"] === input.to_state;
        if (!same) throw new KernelError("conflict", `idempotency key ${input.idempotency_key} was already used for a different change`);
        return { loop: this.#loop(tx, loopId), ledger_event: prior, applied: false };
      }
      const loop = this.#loop(tx, loopId);
      if (input.to_state === "closed_with_reason") {
        if (!input.close_reason) throw new KernelError("bad_request", "closed_with_reason needs a close_reason");
        if (input.close_reason === "rejected")
          throw new KernelError("bad_request", "close_reason rejected is reserved for reject_loop at intake");
      } else if (input.close_reason !== undefined) {
        throw new KernelError("bad_request", `close_reason only applies to closed_with_reason, not ${input.to_state}`);
      }
      const { loop: next, ledger_event } = this.#move(tx, loop, input.to_state, {
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
   * to event_type + source) as one when_fired ledger event, then applies the
   * transitions the firing causes on armed loops (see whatFiresNext). A
   * replayed idempotency key applies once. Workflow runs arrive with templates.
   */
  fireEvent(input: FireEventInput): Promise<FireEventResult> {
    return this.#store.transaction((tx) => {
      const prior = tx.findEventByIdempotencyKey(input.idempotency_key);
      if (prior) {
        if (prior.event_type !== "when_fired")
          throw new KernelError("conflict", `idempotency key ${input.idempotency_key} was already used for a different change`);
        return { ledger_event: prior, applied: false, loop_ids: (prior.payload["loop_ids"] as string[] | undefined) ?? [], workflow_runs: [] };
      }

      let whens: Node[];
      if ("when_id" in input) {
        const when = tx.getNode(input.when_id);
        if (!when || when.kind !== "when") throw new KernelError("not_found", `When ${input.when_id} does not exist`);
        whens = [when];
      } else {
        whens = tx.listNodes().filter((n) => {
          const a = n.attributes;
          const binding = a["source_binding"] as { source?: unknown } | undefined;
          return n.kind === "when" && n.status === "active" && a["when_type"] === "event" &&
            a["event_type"] === input.event_type && binding?.source === input.source;
        });
        if (whens.length === 0)
          throw new KernelError("not_found", `no When is bound to event ${input.event_type} from ${input.source}`);
      }

      const at = this.#at();
      const actor = input.actor ?? "system:fire_event";
      for (const when of whens) {
        if (when.attributes["when_type"] !== "event") continue; // calendar scheduling belongs to the timer loop
        const fireCount = typeof when.attributes["fire_count"] === "number" ? when.attributes["fire_count"] : 0;
        const fired: Node = { ...when, attributes: { ...when.attributes, fired_at: at, fire_count: fireCount + 1 } };
        this.#check("node", fired);
        tx.putNode(fired);
      }

      const effects = whens.flatMap((w) => this.#effectsOfWhen(tx, w.id));
      const loopIds = [...new Set(effects.map((e) => e.loop_id))];
      const payload: Record<string, unknown> = { when_ids: whens.map((w) => w.id), loop_ids: loopIds };
      if ("event_type" in input) Object.assign(payload, { event_type: input.event_type, source: input.source });
      if (input.payload !== undefined) payload["event_payload"] = input.payload;
      const ledger_event = this.#append(tx, {
        at,
        actor,
        event_type: "when_fired",
        subject_ids: [...whens.map((w) => w.id), ...loopIds],
        payload,
        idempotency_key: input.idempotency_key,
      });

      const evidence = { kind: "ledger_event", id: ledger_event.id } as const;
      for (const effect of effects) {
        if (!effect.next_state) continue;
        const loop = this.#loop(tx, effect.loop_id);
        if (loop.state === effect.next_state || !TRANSITIONS[loop.state].includes(effect.next_state)) continue;
        this.#move(tx, loop, effect.next_state, { actor, evidence, idempotency_key: null, close_reason: null });
      }
      return { ledger_event, applied: true, loop_ids: loopIds, workflow_runs: [] };
    });
  }

  // ---- queries ------------------------------------------------------------

  /** open_loops: every non-closed loop matching the filters, with age and governing Whens. */
  openLoops(filter: OpenLoopsFilter = {}): Promise<{ loops: OpenLoop[] }> {
    return this.#store.read((tx) => {
      const now = this.#now().getTime();
      const ledger = tx.ledger();
      const loops = tx
        .listLoops()
        .filter((l) => !CLOSED.has(l.state))
        .filter((l) => filter.accountable_who_id === undefined || l.accountable_who_id === filter.accountable_who_id)
        .filter((l) => filter.loop_type === undefined || l.loop_type === filter.loop_type)
        .filter((l) => filter.state === undefined || l.state === filter.state)
        .map((loop): OpenLoop => {
          const since =
            loop.opened_at ??
            ledger.find((e) => e.event_type === "loop_proposed" && e.subject_ids[0] === loop.id)?.at ??
            new Date(now).toISOString();
          return {
            loop,
            age_seconds: Math.max(0, Math.floor((now - Date.parse(since)) / 1000)),
            governing_when_ids: this.#whenIds(tx, loop),
            // Ageing policies (SPEC B4) are not evaluated yet, so nothing is breaching.
            breaching: false,
          };
        })
        .filter((l) => !filter.breaching_only || l.breaching);
      return { loops };
    });
  }

  /**
   * what_fires_next: for a loop, the Whens it is waiting on and what each firing
   * will cause; for a When, every armed loop that fires when it fires. Exact
   * traversal of the stored graph.
   */
  whatFiresNext(query: { loop_id: string } | { when_id: string }): Promise<{ effects: FiringEffect[] }> {
    return this.#store.read((tx) => {
      if ("loop_id" in query) {
        const loop = this.#loop(tx, query.loop_id);
        if (!ARMED.has(loop.state)) return { effects: [] };
        return { effects: this.#whenIds(tx, loop).map((w) => this.#effect(tx, loop, w)) };
      }
      const when = tx.getNode(query.when_id);
      if (!when || when.kind !== "when") throw new KernelError("not_found", `When ${query.when_id} does not exist`);
      return { effects: this.#effectsOfWhen(tx, when.id) };
    });
  }

  getLoop(loopId: string): Promise<Loop> {
    return this.#store.read((tx) => this.#loop(tx, loopId));
  }

  // ---- internals ----------------------------------------------------------

  #at(): string {
    return this.#now().toISOString();
  }

  #loop(tx: GraphTx, loopId: string): Loop {
    const loop = tx.getLoop(loopId);
    if (!loop) throw new KernelError("not_found", `loop ${loopId} does not exist`);
    return loop;
  }

  #whenIds(tx: GraphTx, loop: Loop): string[] {
    const ids = loop.member_node_ids.filter((id) => tx.getNode(id)?.kind === "when");
    if (loop.closing_when_id !== null && !ids.includes(loop.closing_when_id)) ids.push(loop.closing_when_id);
    return ids;
  }

  #effectsOfWhen(tx: GraphTx, whenId: string): FiringEffect[] {
    return tx
      .listLoops()
      .filter((l) => ARMED.has(l.state) && this.#whenIds(tx, l).includes(whenId))
      .map((l) => this.#effect(tx, l, whenId));
  }

  /**
   * What firing `whenId` does to `loop`: the closing When closes it; a When
   * its members wait on (is_waiting_on) or that causes/enables a member
   * re-opens a waiting or chased loop; any other member When is recorded only.
   */
  #effect(tx: GraphTx, loop: Loop, whenId: string): FiringEffect {
    const members = new Set(loop.member_node_ids);
    const via = tx.edgesTouching(whenId).filter((e) => unblocks(e, whenId, members)).map((e) => e.id);
    const effect: FiringEffect = { when_id: whenId, loop_id: loop.id };
    if (loop.closing_when_id === whenId) effect.next_state = "closed";
    else if (via.length > 0 && (loop.state === "waiting" || loop.state === "chased")) effect.next_state = "open";
    if (via.length > 0) effect.via_edge_ids = via;
    return effect;
  }

  #move(
    tx: GraphTx,
    loop: Loop,
    to: LoopState,
    how: { actor: string; evidence: { kind: "communication" | "gather" | "ledger_event"; id: string }; idempotency_key: string | null; close_reason: Loop["close_reason"] },
  ): LoopWithEvent {
    if (!TRANSITIONS[loop.state].includes(to))
      throw new KernelError("conflict", `loop ${loop.id} cannot move from ${loop.state} to ${to}`);
    const at = this.#at();
    const next: Loop = {
      ...loop,
      state: to,
      closed_at: CLOSED.has(to) ? at : null,
      close_reason: to === "closed_with_reason" ? how.close_reason : null,
    };
    this.#check("loop", next);
    tx.putLoop(next);
    const ledger_event = this.#append(tx, {
      at,
      actor: how.actor,
      event_type: "transition",
      subject_ids: [loop.id],
      payload: { from_state: loop.state, to_state: to, evidence: how.evidence },
      idempotency_key: how.idempotency_key,
    });
    return { loop: next, ledger_event };
  }

  #append(tx: GraphTx, event: Omit<LedgerEvent, "id"> & { event_type: LedgerEventType }): LedgerEvent {
    const full: LedgerEvent = { id: this.#newId("evt"), ...event };
    this.#check("ledger-event", full);
    tx.appendEvent(full);
    return full;
  }

  /** Validates a record against its SPEC B2 schema before it is written. */
  #check(object: "node" | "edge" | "loop" | "ledger-event", value: unknown, code?: KernelErrorCode): void {
    const validate = this.#ajv.getSchema(`${SCHEMA_ID_BASE}${object}.schema.json`);
    if (!validate) throw new Error(`schema ${object} is not registered`);
    if (validate(value)) return;
    const message = `${object} does not match its schema: ${this.#ajv.errorsText(validate.errors)}`;
    if (code) throw new KernelError(code, message, validate.errors);
    throw new Error(message);
  }
}
