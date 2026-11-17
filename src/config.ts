import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The service's config contract: the environment variables it reads. The
 * deploy/ manifests are checked against this (tests/deploy/manifests.test.ts).
 */
export const CONFIG_ENV = {
  port: "PORT",
  host: "HOST",
  /** Postgres connection URI; in-cluster it is the CNPG `loopcloser-db-app` secret's `uri`. */
  databaseUrl: "DATABASE_URL",
} as const;

export const DEFAULT_PORT = 8080;

/**
 * Selects test mode when set to "1": the API serves from an in-memory store
 * that loses every loop on exit. Only tests and local smoke boots set it; the
 * Deployment never does, so a deployed API without DATABASE_URL refuses to start.
 */
export const TEST_MODE_ENV = "LOOPCLOSER_TEST_MODE";

/** Overrides API_KEYS_DIR / API_SCOPES_DIR, for boots outside the cluster (tests). */
export const API_KEYS_DIR_ENV = "LOOPCLOSER_API_KEYS_DIR";
export const API_SCOPES_DIR_ENV = "LOOPCLOSER_API_SCOPES_DIR";

export interface Config {
  readonly host: string;
  readonly port: number;
  readonly databaseUrl?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rawPort = env[CONFIG_ENV.port];
  const port = Number(rawPort ?? String(DEFAULT_PORT));
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be an integer in 0..65535, got ${JSON.stringify(rawPort)}`);
  }
  const host = env[CONFIG_ENV.host] ?? "0.0.0.0";
  const databaseUrl = env[CONFIG_ENV.databaseUrl];
  return databaseUrl ? { host, port, databaseUrl } : { host, port };
}

/**
 * Where the per-agent API keys are mounted: the `loopcloser-api-keys` secret
 * (deploy/external-secrets.yaml), one file per agent principal holding its key.
 */
export const API_KEYS_DIR = "/etc/loopcloser/api-keys";

/** Agent principal → API key, from a mounted secret directory; none if it is absent. */
export function loadApiKeys(dir: string = API_KEYS_DIR): Map<string, string> {
  const keys = new Map<string, string>();
  if (!existsSync(dir)) return keys;
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith(".")) continue; // the kubelet's ..data bookkeeping entries
    const path = join(dir, name);
    if (!statSync(path).isFile()) continue;
    const key = readFileSync(path, "utf8").trim();
    if (key) keys.set(name, key);
  }
  return keys;
}

/**
 * Where the per-agent operation scopes are mounted, beside the keys: one file
 * per principal, named like its key file, listing the operationIds of
 * contracts/openapi.json that principal may call (whitespace- or
 * newline-separated; `#` starts a comment). Scopes are data (TECH-STACK §9):
 * a principal with no file is granted nothing. Joe's principal holds every
 * scope without a file (src/server.ts).
 */
export const API_SCOPES_DIR = "/etc/loopcloser/api-scopes";

/** Agent principal → granted operationIds, from a mounted directory; none if it is absent. */
export function loadApiScopes(dir: string = API_SCOPES_DIR): Map<string, Set<string>> {
  const scopes = new Map<string, Set<string>>();
  if (!existsSync(dir)) return scopes;
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith(".")) continue; // the kubelet's ..data bookkeeping entries
    const path = join(dir, name);
    if (!statSync(path).isFile()) continue;
    const operations = readFileSync(path, "utf8")
      .split("\n")
      .map((line) => line.replace(/#.*$/, ""))
      .flatMap((line) => line.split(/\s+/))
      .filter((op) => op.length > 0);
    scopes.set(name, new Set(operations));
  }
  return scopes;
}
