// Graph store for the Loop Closer kernel: nodes, edges, loops and the
// append-only ledger behind one transactional boundary (TECH-STACK §2/§4: a
// transition and the ledger event recording it commit or roll back together).
//
// The kernel only talks to GraphStore. InMemoryGraphStore is the reference
// implementation used by tests and local runs; a Postgres implementation sits
// behind the same interface.
import type { Communication, Edge, LedgerEvent, Loop, Node, OutboxEntry, SendRequest } from "./types.ts";

/**
 * Operations available inside one transaction. Every method returns a Promise
 * the caller awaits, so a store whose reads and writes are network queries
 * (Postgres) can implement it. A rejected call fails the transaction: the
 * store rolls back everything written in it.
 */
export interface GraphTx {
  getNode(id: string): Promise<Node | undefined>;
  putNode(node: Node): Promise<void>;
  listNodes(): Promise<Node[]>;
  getEdge(id: string): Promise<Edge | undefined>;
  putEdge(edge: Edge): Promise<void>;
  /** Active edges with `nodeId` at either end. */
  edgesTouching(nodeId: string): Promise<Edge[]>;
  getLoop(id: string): Promise<Loop | undefined>;
  putLoop(loop: Loop): Promise<void>;
  listLoops(): Promise<Loop[]>;
  /** Appends; the ledger is never edited. Idempotency keys are unique across the ledger. */
  appendEvent(event: LedgerEvent): Promise<void>;
  findEventByIdempotencyKey(key: string): Promise<LedgerEvent | undefined>;
  /** The full ledger in append order. */
  ledger(): Promise<LedgerEvent[]>;
  /**
   * Up to `limit` events committed after commit position `position`, in commit
   * order, and the position after the last of them (`position` itself when
   * there are none). Position 0 is the start of the ledger; a position is the
   * count of events committed before it. Undefined when `position` lies beyond
   * the committed ledger, so it was never handed out.
   */
  ledgerAfter(position: number, limit: number): Promise<{ events: LedgerEvent[]; position: number } | undefined>;
  getCommunication(id: string): Promise<Communication | undefined>;
  putCommunication(communication: Communication): Promise<void>;
  /** The send request on a communication, if one was made. */
  getSendRequest(communicationId: string): Promise<SendRequest | undefined>;
  putSendRequest(request: SendRequest): Promise<void>;
  /** Adds a side effect to the transactional outbox; it commits with the transaction. */
  enqueue(entry: OutboxEntry): Promise<void>;
  /** The outbox in enqueue order. */
  outbox(): Promise<OutboxEntry[]>;
}

export interface GraphStore {
  /**
   * Runs `fn` atomically: every write commits, or (on throw, or a rejected
   * GraphTx call) none does. Transactions are serialised. `fn` awaits every
   * GraphTx call it makes before it returns.
   */
  transaction<T>(fn: (tx: GraphTx) => T | Promise<T>): Promise<T>;
  /** A read-only view; writes inside it are rejected. */
  read<T>(fn: (tx: GraphTx) => T | Promise<T>): Promise<T>;
}

interface State {
  nodes: Map<string, Node>;
  edges: Map<string, Edge>;
  loops: Map<string, Loop>;
  ledger: LedgerEvent[];
  idempotency: Map<string, LedgerEvent>;
  communications: Map<string, Communication>;
  sendRequests: Map<string, SendRequest>;
  outbox: OutboxEntry[];
}

const copy = <T>(v: T): T => structuredClone(v);

function cloneState(s: State): State {
  return {
    nodes: new Map(s.nodes),
    edges: new Map(s.edges),
    loops: new Map(s.loops),
    ledger: [...s.ledger],
    idempotency: new Map(s.idempotency),
    communications: new Map(s.communications),
    sendRequests: new Map(s.sendRequests),
    outbox: [...s.outbox],
  };
}

export class InMemoryGraphStore implements GraphStore {
  #state: State = {
    nodes: new Map(),
    edges: new Map(),
    loops: new Map(),
    ledger: [],
    idempotency: new Map(),
    communications: new Map(),
    sendRequests: new Map(),
    outbox: [],
  };
  #queue: Promise<unknown> = Promise.resolve();

  transaction<T>(fn: (tx: GraphTx) => T | Promise<T>): Promise<T> {
    return this.#serialise(async () => {
      const working = cloneState(this.#state);
      const view = this.#tx(working, true);
      try {
        const result = await fn(view.tx);
        this.#state = working; // commit
        return result;
      } finally {
        view.close();
      }
    });
  }

  read<T>(fn: (tx: GraphTx) => T | Promise<T>): Promise<T> {
    return this.#serialise(async () => {
      const view = this.#tx(this.#state, false);
      try {
        return await fn(view.tx);
      } finally {
        view.close();
      }
    });
  }

  #serialise<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  /**
   * The GraphTx over `s`. Each call settles asynchronously, like a query would;
   * once the transaction or read is over (`close`) every call rejects, so a
   * write the caller forgot to await cannot land after commit or rollback.
   */
  #tx(s: State, writable: boolean): { tx: GraphTx; close: () => void } {
    let open = true;
    const live = (): void => {
      if (!open) throw new Error("transaction is already over");
    };
    const write = (): void => {
      live();
      if (!writable) throw new Error("write attempted in a read-only view");
    };
    const tx: GraphTx = {
      getNode: async (id) => (live(), copy(s.nodes.get(id))),
      putNode: async (node) => (write(), void s.nodes.set(node.id, copy(node))),
      listNodes: async () => (live(), [...s.nodes.values()].map(copy)),
      getEdge: async (id) => (live(), copy(s.edges.get(id))),
      putEdge: async (edge) => (write(), void s.edges.set(edge.id, copy(edge))),
      edgesTouching: async (nodeId) => (
        live(),
        [...s.edges.values()].filter((e) => e.status === "active" && (e.from_id === nodeId || e.to_id === nodeId)).map(copy)
      ),
      getLoop: async (id) => (live(), copy(s.loops.get(id))),
      putLoop: async (loop) => (write(), void s.loops.set(loop.id, copy(loop))),
      listLoops: async () => (live(), [...s.loops.values()].map(copy)),
      appendEvent: async (event) => {
        write();
        if (event.idempotency_key !== null) {
          if (s.idempotency.has(event.idempotency_key))
            throw new Error(`idempotency key ${event.idempotency_key} already in the ledger`);
          s.idempotency.set(event.idempotency_key, copy(event));
        }
        s.ledger.push(copy(event));
      },
      findEventByIdempotencyKey: async (key) => (live(), copy(s.idempotency.get(key))),
      ledger: async () => (live(), s.ledger.map(copy)),
      ledgerAfter: async (position, limit) => {
        live();
        if (!Number.isSafeInteger(position) || position < 0 || position > s.ledger.length) return undefined;
        const events = s.ledger.slice(position, position + Math.max(0, limit)).map(copy);
        return { events, position: position + events.length };
      },
      getCommunication: async (id) => (live(), copy(s.communications.get(id))),
      putCommunication: async (communication) => (write(), void s.communications.set(communication.id, copy(communication))),
      getSendRequest: async (id) => (live(), copy(s.sendRequests.get(id))),
      putSendRequest: async (request) => (write(), void s.sendRequests.set(request.communication_id, copy(request))),
      enqueue: async (entry) => (write(), void s.outbox.push(copy(entry))),
      outbox: async () => (live(), s.outbox.map(copy)),
    };
    return { tx, close: () => void (open = false) };
  }
}
