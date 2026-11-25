// Types for delivery-batch.mjs, imported by tests/delivery/batch.test.ts.
export declare const BATCH_WORKFLOW: string;
export interface BatchDecisionInput {
  repo: string | undefined;
  headSha: string | undefined;
  token: string | undefined;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}
export declare function batchDecision(input: BatchDecisionInput): Promise<{ run: boolean; since: string | null }>;
