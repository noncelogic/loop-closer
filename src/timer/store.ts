// Storage port for the timer tick (TECH-STACK §6).
//
// The tick needs a transaction in which it can claim due calendar Whens (in
// Postgres: `SELECT … WHERE next_fire_at <= now FOR UPDATE SKIP LOCKED`),
// append ledger events and advance `next_fire_at`, all committing or rolling
// back together. InMemoryTimerStore implements the same contract — serialised,
// all-or-nothing transactions and the ledger's idempotency-key uniqueness —
// for tests and for running without the Postgres replica.

export type LoopState = "proposed" | "open" | "waiting" | "chased" | "closed" | "closed_with_reason";

export interface PolicyRef {
  readonly id: string;
  readonly version: number;
}

/** SPEC B2.1 node (contracts/schemas/v1/node.schema.json). */
export interface NodeRecord {
  id: string;
  kind: "who" | "what" | "when";
  created_at: string;
  status: "active" | "superseded" | "merged" | "tombstoned";
  attributes: Record<string, unknown>;
}

/** SPEC B2.4 ledger event (contracts/schemas/v1/ledger-event.schema.json). */
export interface LedgerEvent {
  id: string;
  at: string;
  actor: string;
  event_type: string;
  subject_ids: string[];
  payload: Record<string, unknown>;
  idempotency_key: string | null;
}

/** The slice of a loop the ageing check reads. */
export interface LoopAgeingRow {
  id: string;
  loop_type: string;
  state: LoopState;
  /** When the loop entered its current state (the latest transition's ledger time). */
  state_entered_at: string;
  ageing_policy: PolicyRef;
}

/** SPEC B4 ageing policy: expected dwell per state; a state with no entry never breaches. */
export interface AgeingPolicy {
  id: string;
  version: number;
  max_dwell_seconds: Partial<Record<LoopState, number>>;
}

export interface DueCalendarWhen {
  readonly id: string;
  readonly schedule: unknown;
  readonly timezone: unknown;
  readonly next_fire_at: string;
}

export interface TimerTx {
  /** Lock and return active calendar Whens with next_fire_at <= now, oldest first, skipping rows another tick holds. */
  claimDueCalendarWhens(now: Date): Promise<DueCalendarWhen[]>;
  /** Append-only; rejects a duplicate idempotency key. */
  appendLedgerEvent(event: LedgerEvent): Promise<void>;
  setNextFireAt(whenId: string, nextFireAt: string | null): Promise<void>;
  /** Non-closed loops with the ageing policy version each one cites (null if that version is missing). */
  listOpenLoopsForAgeing(): Promise<Array<{ loop: LoopAgeingRow; policy: AgeingPolicy | null }>>;
}

export interface TimerStore {
  transaction<T>(fn: (tx: TimerTx) => Promise<T>): Promise<T>;
}

export interface TimerState {
  nodes: NodeRecord[];
  ledger: LedgerEvent[];
  loops: LoopAgeingRow[];
  ageing_policies: AgeingPolicy[];
}

export class DuplicateIdempotencyKeyError extends Error {
  override name = "DuplicateIdempotencyKeyError";
}

export class InMemoryTimerStore implements TimerStore {
  #state: TimerState;
  #queue: Promise<unknown> = Promise.resolve();
  transactionsCommitted = 0;
  transactionsRolledBack = 0;

  constructor(state: TimerState) {
    this.#state = structuredClone(state);
  }

  snapshot(): TimerState {
    return structuredClone(this.#state);
  }

  transaction<T>(fn: (tx: TimerTx) => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const work = structuredClone(this.#state);
      try {
        const result = await fn(memoryTx(work));
        this.#state = work;
        this.transactionsCommitted++;
        return result;
      } catch (err) {
        this.transactionsRolledBack++;
        throw err;
      }
    };
    const result = this.#queue.then(run, run);
    this.#queue = result.catch(() => undefined);
    return result;
  }
}

const CLOSED: ReadonlySet<LoopState> = new Set(["closed", "closed_with_reason"]);

function memoryTx(state: TimerState): TimerTx {
  return {
    async claimDueCalendarWhens(now) {
      return state.nodes
        .filter((n) => n.kind === "when" && n.status === "active" && n.attributes["when_type"] === "calendar")
        .filter((n) => typeof n.attributes["next_fire_at"] === "string" && Date.parse(n.attributes["next_fire_at"]) <= now.getTime())
        .map((n) => ({
          id: n.id,
          schedule: n.attributes["schedule"],
          timezone: n.attributes["timezone"],
          next_fire_at: n.attributes["next_fire_at"] as string,
        }))
        .sort((a, b) => Date.parse(a.next_fire_at) - Date.parse(b.next_fire_at) || a.id.localeCompare(b.id));
    },
    async appendLedgerEvent(event) {
      if (event.idempotency_key !== null && state.ledger.some((e) => e.idempotency_key === event.idempotency_key)) {
        throw new DuplicateIdempotencyKeyError(`idempotency key ${event.idempotency_key} already recorded`);
      }
      state.ledger.push(structuredClone(event));
    },
    async setNextFireAt(whenId, nextFireAt) {
      const node = state.nodes.find((n) => n.id === whenId);
      if (!node) throw new Error(`no When ${whenId}`);
      node.attributes["next_fire_at"] = nextFireAt;
    },
    async listOpenLoopsForAgeing() {
      return state.loops
        .filter((l) => !CLOSED.has(l.state))
        .map((loop) => ({
          loop: structuredClone(loop),
          policy:
            structuredClone(
              state.ageing_policies.find((p) => p.id === loop.ageing_policy.id && p.version === loop.ageing_policy.version),
            ) ?? null,
        }));
    },
  };
}
