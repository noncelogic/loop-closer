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
