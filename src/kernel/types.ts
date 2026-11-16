// TypeScript shapes of the SPEC B2 records and B3 requests the kernel handles.
// contracts/schemas/v1 and contracts/openapi.json are the source of truth; the
// kernel validates every record it writes against those schemas.

export type LoopState = "proposed" | "open" | "waiting" | "chased" | "closed" | "closed_with_reason";
export type CloseReason = "abandoned" | "superseded" | "no-longer-applies" | "rejected";
export type Authority = "autonomous" | "joe-approves-each" | "joe-approves-template";
export type EdgeType =
  | "causes" | "enables" | "blocks"
  | "depends_on" | "responds_to" | "supersedes" | "evidences" | "owns" | "is_waiting_on" | "updates" | "gathers_from";
export type LedgerEventType =
  | "loop_proposed" | "loop_accepted" | "loop_rejected" | "transition" | "when_fired"
  | "communication_sent" | "communication_received" | "gather_performed" | "supersession"
  | "merge" | "split" | "manual_correction" | "tombstone";

export interface Evidence {
  kind: "communication" | "gather" | "ledger_event";
  id: string;
}

export interface PolicyRef {
  id: string;
  version: number;
}

export interface Node {
  id: string;
  kind: "who" | "what" | "when";
  created_at: string;
  status: "active" | "superseded" | "merged" | "tombstoned";
  attributes: Record<string, unknown>;
}

export interface Edge {
  id: string;
  from_id: string;
  to_id: string;
  edge_type: EdgeType;
  created_by: string;
  created_at: string;
  evidence: Evidence | null;
  status: "active" | "superseded" | "retracted";
}

export interface Loop {
  id: string;
  name: string;
  loop_type: string;
  state: LoopState;
  accountable_who_id: string;
  member_node_ids: string[];
  closing_when_id: string | null;
  authority: Authority;
  opened_at: string | null;
  closed_at: string | null;
  close_reason: CloseReason | null;
  policy_refs: { ageing: PolicyRef; escalation: PolicyRef };
}

export interface LedgerEvent {
  id: string;
  at: string;
  actor: string;
  event_type: LedgerEventType;
  subject_ids: string[];
  payload: Record<string, unknown>;
  idempotency_key: string | null;
}

/** OpenAPI ProposedEdge. */
export interface ProposedEdge {
  from_id: string;
  to_id: string;
  edge_type: EdgeType;
  evidence?: Evidence | null;
}

/** OpenAPI ProposeLoopRequest: nodes are new Node records or `{ ref }` to existing ones. */
export interface ProposeLoopInput {
  name: string;
  loop_type: string;
  accountable_who_id: string;
  nodes: (Node | { ref: string })[];
  edges: ProposedEdge[];
  closing_when_id?: string | undefined;
  actor: string;
  rationale: string;
}

export interface AcceptLoopInput {
  acceptor: string;
}

export interface RejectLoopInput {
  actor: string;
  reason: string;
}

export interface TransitionInput {
  to_state: LoopState;
  actor: string;
  evidence: Evidence;
  idempotency_key: string;
  close_reason?: CloseReason;
}

export type FireEventInput =
  | { when_id: string; idempotency_key: string; payload?: Record<string, unknown>; actor?: string }
  | { event_type: string; source: string; payload: Record<string, unknown>; idempotency_key: string; actor?: string };

export interface OpenLoopsFilter {
  accountable_who_id?: string;
  loop_type?: string;
  state?: "proposed" | "open" | "waiting" | "chased";
  breaching_only?: boolean;
}

export interface LoopWithEvent {
  loop: Loop;
  ledger_event: LedgerEvent;
}

export interface TransitionResult extends LoopWithEvent {
  /** false when the idempotency key was already applied. */
  applied: boolean;
}

export interface FireEventResult {
  ledger_event: LedgerEvent;
  applied: boolean;
  loop_ids: string[];
  workflow_runs: never[];
}

export interface OpenLoop {
  loop: Loop;
  age_seconds: number;
  governing_when_ids: string[];
  breaching: boolean;
}

export interface FiringEffect {
  when_id: string;
  loop_id: string;
  next_state?: LoopState;
  via_edge_ids?: string[];
}

/** OpenAPI HealthResult, without the requested window. */
export interface HealthMetrics {
  snapshot_at: string;
  breach_pct: number;
  manual_correction_count: number;
  median_open_age_seconds: number | null;
  abandonment_count: number;
}

/** SPEC B2.5 Communication. An outbound one is a draft until a send is released (sent_under_authority set then). */
export interface Communication {
  id: string;
  thread_id: string;
  channel: "email" | "message" | "other";
  direction: "outbound" | "inbound";
  participant_who_ids: string[];
  at: string;
  body_pointer: string;
  body_hash: string;
  loop_id: string;
  sent_under_authority: Authority | null;
}

/** OpenAPI RecordCommunicationRequest. */
export type RecordCommunicationInput = Omit<Communication, "id" | "sent_under_authority">;

/** OpenAPI RequestSendRequest (the loop comes from the path). */
export interface RequestSendInput {
  communication_id: string;
  actor: string;
}

/** OpenAPI ApproveSendRequest. */
export interface ApproveSendInput {
  approver: string;
}

/**
 * A request_send on one communication: `pending_approval` until Joe approves it
 * (joe-approves-each), `enqueued` once the send is in the outbox, `refused`
 * when the loop type's receiver scope forbids a receiver (never sent).
 */
export interface SendRequest {
  communication_id: string;
  loop_id: string;
  authority: Authority;
  status: "pending_approval" | "enqueued" | "refused";
  requested_by: string;
  requested_at: string;
  /** Set on a refused request: the receivers outside the loop type's scope. */
  refused_receiver_ids?: string[];
}

/** OpenAPI SendRequestResult. */
export interface SendRequestResult {
  communication_id: string;
  authority: Authority;
  status: "pending_approval" | "enqueued";
}

/** OpenAPI ApproveSendResult. */
export interface ApproveSendResult {
  communication_id: string;
  status: "released";
  ledger_event: LedgerEvent;
}

/** A side effect in the transactional outbox (TECH-STACK §6), citing the ledger event that caused it. */
export interface OutboxEntry {
  ledger_event_id: string;
  topic: string;
  payload: Record<string, unknown>;
  created_at: string;
}
