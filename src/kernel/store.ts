// Graph store for the Loop Closer kernel: nodes, edges, loops and the
// append-only ledger behind one transactional boundary (TECH-STACK §2/§4: a
// transition and the ledger event recording it commit or roll back together).
//
// The kernel only talks to GraphStore. InMemoryGraphStore is the reference
// implementation used by tests and local runs; a Postgres implementation sits
// behind the same interface.
import type { Edge, LedgerEvent, Loop, Node } from "./types.ts";

/** Operations available inside one transaction. */
export interface GraphTx {
  getNode(id: string): Node | undefined;
  putNode(node: Node): void;
  listNodes(): Node[];
  getEdge(id: string): Edge | undefined;
  putEdge(edge: Edge): void;
  /** Active edges with `nodeId` at either end. */
  edgesTouching(nodeId: string): Edge[];
  getLoop(id: string): Loop | undefined;
  putLoop(loop: Loop): void;
  listLoops(): Loop[];
  /** Appends; the ledger is never edited. Idempotency keys are unique across the ledger. */
  appendEvent(event: LedgerEvent): void;
  findEventByIdempotencyKey(key: string): LedgerEvent | undefined;
  /** The full ledger in append order. */
  ledger(): LedgerEvent[];
}

export interface GraphStore {
  /** Runs `fn` atomically: every write commits, or (on throw) none does. Transactions are serialised. */
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
}

const copy = <T>(v: T): T => structuredClone(v);

function cloneState(s: State): State {
  return {
    nodes: new Map(s.nodes),
    edges: new Map(s.edges),
    loops: new Map(s.loops),
    ledger: [...s.ledger],
    idempotency: new Map(s.idempotency),
  };
}

export class InMemoryGraphStore implements GraphStore {
  #state: State = { nodes: new Map(), edges: new Map(), loops: new Map(), ledger: [], idempotency: new Map() };
  #queue: Promise<unknown> = Promise.resolve();

  transaction<T>(fn: (tx: GraphTx) => T | Promise<T>): Promise<T> {
    return this.#serialise(async () => {
      const working = cloneState(this.#state);
      const result = await fn(this.#tx(working, true));
      this.#state = working; // commit
      return result;
    });
  }

  read<T>(fn: (tx: GraphTx) => T | Promise<T>): Promise<T> {
    return this.#serialise(async () => fn(this.#tx(this.#state, false)));
  }

  #serialise<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  #tx(s: State, writable: boolean): GraphTx {
    const write = (): void => {
      if (!writable) throw new Error("write attempted in a read-only view");
    };
    return {
      getNode: (id) => copy(s.nodes.get(id)),
      putNode: (node) => (write(), void s.nodes.set(node.id, copy(node))),
      listNodes: () => [...s.nodes.values()].map(copy),
      getEdge: (id) => copy(s.edges.get(id)),
      putEdge: (edge) => (write(), void s.edges.set(edge.id, copy(edge))),
      edgesTouching: (nodeId) =>
        [...s.edges.values()].filter((e) => e.status === "active" && (e.from_id === nodeId || e.to_id === nodeId)).map(copy),
      getLoop: (id) => copy(s.loops.get(id)),
      putLoop: (loop) => (write(), void s.loops.set(loop.id, copy(loop))),
      listLoops: () => [...s.loops.values()].map(copy),
      appendEvent: (event) => {
        write();
        if (event.idempotency_key !== null) {
          if (s.idempotency.has(event.idempotency_key))
            throw new Error(`idempotency key ${event.idempotency_key} already in the ledger`);
          s.idempotency.set(event.idempotency_key, copy(event));
        }
        s.ledger.push(copy(event));
      },
      findEventByIdempotencyKey: (key) => copy(s.idempotency.get(key)),
      ledger: () => s.ledger.map(copy),
    };
  }
}
