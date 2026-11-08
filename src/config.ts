export interface Config {
  readonly host: string;
  readonly port: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env["PORT"] ?? "8080");
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be an integer in 0..65535, got ${JSON.stringify(env["PORT"])}`);
  }
  return { host: env["HOST"] ?? "0.0.0.0", port };
}
