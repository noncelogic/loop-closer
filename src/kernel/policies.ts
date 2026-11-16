// Loop-type policies as data (SPEC B4). A loop inherits its type's authority
// and cites its type's ageing and escalation policies by ID+version. A loop
// type with no entry here gets the default: authority joe-approves-each
// (SPEC B2.6) and the kernel's default policy refs.
import type { Authority, PolicyRef } from "./types.ts";

/** What stops an escalation chase. */
export type StopCondition = "ack" | "resolve" | "answered";

/**
 * Escalation policy with its SPEC B4 chase bounds. A null bound is set by the
 * policy's source, not by this repo.
 */
export interface EscalationPolicy extends PolicyRef {
  max_attempts: number | null;
  min_interval_seconds: number | null;
  stop_conditions: readonly StopCondition[];
  /** Where the bound values come from. */
  bounds_source: string;
}

/**
 * Who a loop of this type may send to: `any` leaves receivers to the
 * authority (approval) gate; `owner_only` allows only the accountable Who and
 * the receivers it owns (active `owns` edges from the owner to a Who).
 */
export type ReceiverScope = "any" | "owner_only";

export interface LoopTypePolicy {
  loop_type: string;
  version: number;
  authority: Authority;
  receivers: ReceiverScope;
  escalation: EscalationPolicy;
  /** The on-record decision that set this type's authority (SPEC B4 authority policy). */
  decided_by: string;
}

export const DEFAULT_AUTHORITY: Authority = "joe-approves-each";

export const LOOP_TYPE_POLICIES: readonly LoopTypePolicy[] = Object.freeze([
  {
    loop_type: "factory-notification",
    version: 1,
    authority: "autonomous",
    receivers: "owner_only",
    escalation: {
      id: "lc_policy_escalation_factory_notification",
      version: 1,
      max_attempts: null,
      min_interval_seconds: null,
      stop_conditions: ["ack", "resolve", "answered"],
      bounds_source: "harness notification policy (record mode, measured)",
    },
    decided_by:
      "owner decision 2026-11-15 item 5, noncelogic/meta-harness:operations/notifications-design.md (autonomous for the self-notification loop type only)",
  },
]);

/** The policy of `loopType`, or undefined when the type takes the defaults. Exact, case-sensitive match. */
export function loopTypePolicy(loopType: string, policies: readonly LoopTypePolicy[] = LOOP_TYPE_POLICIES): LoopTypePolicy | undefined {
  return policies.find((p) => p.loop_type === loopType);
}
