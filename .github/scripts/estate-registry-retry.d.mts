// Types for estate-registry-retry.mjs, imported by test/deploy/estate-image.test.ts.
export declare const REGISTRY_ATTEMPTS: number;
export declare function backoffMs(attempt: number): number;
export declare function isTransient(output: string): boolean;
export interface RegistryOpOptions {
  env?: NodeJS.ProcessEnv;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}
export declare function registryOp(
  op: "pull" | "push",
  ref: string,
  opts?: RegistryOpOptions,
): Promise<{ attempts: number; output: string; digest?: string }>;
