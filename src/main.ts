// The API entrypoint: `node dist/main.js` (deploy/ Deployment).
//
// Serves through a Kernel over PgGraphStore at DATABASE_URL, so the API is the
// system of record and never loses a loop on restart. Without DATABASE_URL it
// refuses to start (exit 1) unless test mode is selected explicitly
// (LOOPCLOSER_TEST_MODE=1), which serves from an in-memory store. SIGINT and
// SIGTERM stop accepting connections, close the pool and exit zero.
import type { AddressInfo } from "node:net";
import pg from "pg";
import {
  API_KEYS_DIR,
  API_KEYS_DIR_ENV,
  API_SCOPES_DIR,
  API_SCOPES_DIR_ENV,
  CONFIG_ENV,
  loadApiKeys,
  loadApiScopes,
  loadConfig,
  TEST_MODE_ENV,
} from "./config.ts";
import { InMemoryGraphStore, Kernel, PgGraphStore } from "./kernel/index.ts";
import { createServer, SERVICE_NAME } from "./server.ts";

const config = loadConfig();
const testMode = process.env[TEST_MODE_ENV] === "1";
if (!config.databaseUrl && !testMode) {
  console.error(
    `${CONFIG_ENV.databaseUrl} is not set: refusing to serve from an in-memory store (set ${TEST_MODE_ENV}=1 to select test mode)`,
  );
  process.exit(1);
}

const keysDir = process.env[API_KEYS_DIR_ENV] || API_KEYS_DIR;
const scopesDir = process.env[API_SCOPES_DIR_ENV] || API_SCOPES_DIR;
const apiKeys = loadApiKeys(keysDir);
if (apiKeys.size === 0) console.warn(`no API keys under ${keysDir}: every /v1 call will be refused`);
const scopes = loadApiScopes(scopesDir);
if (scopes.size === 0) console.warn(`no API scopes under ${scopesDir}: only joe's principal is granted any operation`);

let pool: pg.Pool | undefined;
if (config.databaseUrl) {
  pool = new pg.Pool({ connectionString: config.databaseUrl, connectionTimeoutMillis: 10_000 });
  // An idle client losing its connection must not crash the process; the next query reconnects.
  pool.on("error", (err) => console.error(`database pool error: ${err.message}`));
} else {
  console.warn(`${TEST_MODE_ENV}=1: serving from an in-memory store; every loop is lost on exit`);
}
const kernel = new Kernel(pool ? new PgGraphStore(pool) : new InMemoryGraphStore());
const server = createServer({ kernel, apiKeys, scopes });

server.listen(config.port, config.host, () => {
  const { address, port } = server.address() as AddressInfo;
  console.log(`${SERVICE_NAME} listening on http://${address}:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close(() => {
      (pool?.end() ?? Promise.resolve()).then(
        () => process.exit(0),
        (err: unknown) => {
          console.error(`closing the database pool failed: ${err instanceof Error ? err.message : String(err)}`);
          process.exit(1);
        },
      );
    });
    // Idle keep-alive connections must not hold shutdown open.
    server.closeIdleConnections();
  });
}
