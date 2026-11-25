// Types for delivery-batch.mjs, imported by tests/delivery/batch.test.ts.
export declare const BATCH_WORKFLOW: string;
export interface BatchDecisionInput {
  repo: string | undefined;
  headSha: string | undefined;
  token: string | undefined;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}
export declare function batchDecision(input: BatchDecisionInput): Promise<{ run: boolean; since: string | null }>;
export declare function firstBatchHistory(repo: string | undefined): (url: string | URL, init?: RequestInit) => Promise<Response>;
export interface RunBatchInput {
  env?: Record<string, string | undefined>;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  log?: (line: string) => void;
}
export declare function runBatch(input?: RunBatchInput): Promise<{ run: boolean; since: string | null }>;
