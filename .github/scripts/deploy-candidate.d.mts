// Types for deploy-candidate.mjs, imported by tests/delivery/deploy.test.ts.
export type Docker = (args: string[], opts?: { check?: boolean }) => string;
export declare const REPO_ROOT: string;
export declare const DOCKER_TIMEOUT_MS: number;
export declare const CANDIDATE_INPUTS: Readonly<Record<"compose" | "deployment" | "schemaJob" | "scopes" | "database", string>>;
export interface DeployCandidateInput {
  image: string;
  name: string;
  docker?: Docker;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => string;
  keysRoot?: string;
  root?: string;
  attempts?: number;
  intervalMs?: number;
  /** Once aborted, the deploy runs no further docker command, ends its wait or health probe and rejects. */
  signal?: AbortSignal;
}
export declare function deployCandidate(input: DeployCandidateInput): Promise<{ url: string; keysDir: string; principals: string[] }>;
export declare function removeCandidate(input: { name: string; docker?: Docker }): void;
