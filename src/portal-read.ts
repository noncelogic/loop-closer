// The scheduled portal-read entrypoint: `node dist/portal-read.js`.
//
// Runs one scheduled listings read (runScheduledListingsRead,
// src/sensors/portal-run.ts) against PgGraphStore at DATABASE_URL. Its targets
// are the public page URLs bound to the armed event Whens of open
// directory-listing loops in that graph (src/sensors/listing-targets.ts),
// never deploy configuration; with none it reads nothing outside and still
// records the sensor's heartbeat. It prints the report as one JSON line,
// closes the pool and exits. The listing state compared against is what
// earlier invocations recorded in the graph. Any failure — no DATABASE_URL, an
// unreachable database, a failed read — exits non-zero so the scheduled Job
// fails visibly; a failed read records no heartbeat.
import pg from "pg";
import { CONFIG_ENV } from "./config.ts";
import { PgGraphStore } from "./kernel/pg-store.ts";
import { runScheduledListingsRead } from "./sensors/portal-run.ts";

async function main(): Promise<void> {
  const databaseUrl = process.env[CONFIG_ENV.databaseUrl];
  if (!databaseUrl) throw new Error(`${CONFIG_ENV.databaseUrl} is not set`);

  const pool = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 10_000 });
  pool.on("error", (err) => console.error(`database pool error: ${err.message}`));
  try {
    const report = await runScheduledListingsRead(new PgGraphStore(pool));
    console.log(JSON.stringify({ msg: "portal_read", ...report }));
  } finally {
    await pool.end();
  }
}

main().then(
  () => {
    process.exitCode = 0;
  },
  (err: unknown) => {
    console.error(`portal read failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exitCode = 1;
  },
);
