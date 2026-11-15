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
