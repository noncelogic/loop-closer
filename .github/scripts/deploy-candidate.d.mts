// Types for deploy-candidate.mjs, imported by tests/delivery/deploy.test.ts and tests/deploy/deploy-candidate.test.ts.
/** Runs one docker command; given `signal`, the command is killed once it aborts and the promise rejects once it has exited. */
export type Docker = (args: string[], opts?: { check?: boolean; signal?: AbortSignal }) => Promise<string>;
export declare const REPO_ROOT: string;
/** Arms `fn` to run once after `ms`; returns what disarms it. */
export type SetTimer = (fn: () => void, ms: number) => () => void;
/**
 * The docker CLI (`bin`, docker on PATH by default), run without blocking the event loop; a command is killed
 * after `timeoutMs` (armed with `setTimer`) only when the caller gives one, or once its `signal` aborts, and the
 * promise settles only once the command has exited.
 */
export declare function dockerCli(opts?: { timeoutMs?: number; bin?: string; setTimer?: SetTimer }): Docker;
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
  /**
   * Once aborted, the deploy kills a docker wait in flight, lets a daemon change in flight complete, runs no further
   * command, ends its wait or probe and rejects.
   */
  signal?: AbortSignal;
  /** A bound on the whole deploy: once it passes, the deploy stops as if `signal` had aborted. */
  deadlineMs?: number;
  /** The timer the deadline is armed with. */
  setTimer?: SetTimer;
}
export declare function deployCandidate(input: DeployCandidateInput): Promise<{ url: string; keysDir: string; principals: string[] }>;
/** Which of the candidate's containers, volumes and network docker still lists, as "<kind> <name>". */
export declare function candidateLeftovers(input: { name: string; docker?: Docker }): Promise<string[]>;
/** Removes the candidate, then reads back that nothing of it is left; rejects naming what is. */
export declare function removeCandidate(input: {
  name: string;
  docker?: Docker;
  sleep?: (ms: number) => Promise<void>;
  attempts?: number;
  intervalMs?: number;
}): Promise<void>;
